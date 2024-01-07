import { CyaneaPlugin } from "@pbrucla/cyanea-core"
import { getEnvCredentials } from "@pbrucla/cyanea-core/util/index.ts"
import CyaneaEvent, { diff } from "@pbrucla/cyanea-core/event/index.ts"
import { google } from "googleapis"
import type { calendar_v3 } from "googleapis/build/src/apis/calendar/v3.d.ts"
import { DateTime, IANAZone, Settings as LuxonSettings } from "luxon"
import crypto from "node:crypto"

LuxonSettings.throwOnInvalid = true
declare module "luxon" {
  interface TSSettings {
    throwOnInvalid: true
  }
}

// note: we add an extra UUID to iCal identifiers because
// Google Calendar doesn't seem to allow using identifiers
// from events that have been deleted (???)
const ICALUID_REGEX = /^UID:(.*)\+[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}@cyanea$/

// TODO document credentials:
//
// - CYANEA_GCAL_CLIENT_EMAIL
// - CYANEA_GCAL_PRIVATE_KEY

interface GoogleCalendarConfig {
  timezone?: string
  googleCalendarId: string
}

function toGCalEvent(event: CyaneaEvent, zone: IANAZone): calendar_v3.Schema$Event {
  return {
    summary: event.title,
    description: event.description,
    location: event.location,
    attachments: event.banner ? [{ fileUrl: event.banner }] : undefined,
    start: { dateTime: DateTime.fromMillis(event.start, { zone }).toISO() },
    end: { dateTime: DateTime.fromMillis(event.end, { zone }).toISO() },
  }
}

export default {
  sink: {
    configSchema: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          nullable: true,
          default: "America/Los_Angeles",
          description: "The timezone to write events timestamps with.",
        },
        googleCalendarId: {
          type: "string",
          description: "The Google Calendar id to write events to.",
        },
      },
      additionalProperties: false,
      required: ["googleCalendarId"],
    },
    async load(config) {
      const timezone = IANAZone.create(config.timezone ?? "America/Los_Angeles")

      const creds = getEnvCredentials("CYANEA_GCAL", "CLIENT_EMAIL", "PRIVATE_KEY")
      if (creds === null) {
        throw `cyanea-gcal is missing required credentials!
       Please set CYANEA_GCAL_[CLIENT_EMAIL, PRIVATE_KEY] with valid Google Calendar API credentials.`
      }

      const calendar = google.calendar({ version: "v3" }).events
      const jwtClient = new google.auth.JWT(creds.client_email, "", creds.private_key, [
        "https://www.googleapis.com/auth/calendar.events",
      ])
      await jwtClient.authorize()

      return {
        async syncEvents(events) {
          // preprocess events a bit
          const processedEvents = events.map(e => {
            // run a couple of sanity checks
            if (e.end < e.start) {
              throw `event with id ${e.id} ends before it starts`
            }

            // remove metadata from events that cannot be represented in gcal
            // so that diffing with data from gcal works later
            e.type = undefined
            e.links = undefined
            e.meta = undefined

            // make sure banner is set to some value for diffing
            e.banner ??= undefined

            // drop anything higher than second precision because
            // gcal only supports second precision
            e.start = DateTime.fromMillis(e.start, { zone: timezone }).startOf("second").toMillis()
            e.end = DateTime.fromMillis(e.end, { zone: timezone }).startOf("second").toMillis()

            return e
          })

          // grab existing events in the calendar
          const existingEvents: CyaneaEvent[] = []
          const cyaneaID2GCalID = new Map<string, string>()
          let nextPageToken: string | undefined = undefined
          do {
            const res: calendar_v3.Schema$Events = (
              await calendar.list({
                auth: jwtClient,
                calendarId: config.googleCalendarId,
                maxResults: 2000,
                pageToken: nextPageToken,
              })
            ).data

            nextPageToken = res.nextPageToken ?? undefined
            if (!res.items) continue

            for (const gCalEvent of res.items) {
              const possiblyCyaneaId = gCalEvent.iCalUID?.match(ICALUID_REGEX)?.at(1)
              if (!possiblyCyaneaId) continue

              if (cyaneaID2GCalID.has(possiblyCyaneaId)) {
                throw `Google Calendar returned an event with duplicate Cyanea/iCal id ${gCalEvent.iCalUID} (the calendar may have been concurrently modified)`
              }
              cyaneaID2GCalID.set(possiblyCyaneaId, gCalEvent.id!)

              existingEvents.push({
                id: possiblyCyaneaId,
                title: gCalEvent.summary ?? "",
                type: undefined,
                description: gCalEvent.description ?? "",
                location: gCalEvent.location ?? "",
                banner: gCalEvent.attachments?.at(0)?.fileUrl ?? undefined,
                start: DateTime.fromISO(gCalEvent.start!.dateTime!, {
                  zone: gCalEvent.start!.timeZone ?? undefined,
                  setZone: true,
                }).toMillis(),
                end: DateTime.fromISO(gCalEvent.end!.dateTime!, {
                  zone: gCalEvent.end!.timeZone ?? undefined,
                  setZone: true,
                }).toMillis(),
                links: undefined,
                meta: undefined,
              })
            }
          } while (nextPageToken !== undefined)

          // diff events!
          const { added, modified, removed } = diff(existingEvents, processedEvents)

          console.debug(
            `Syncing ${added.length}+${modified.length}+${removed.length} added/modified/removed events to Google Calendar...`,
          )

          // add, update, and delete events
          for (const addedEvent of added) {
            await calendar.insert({
              auth: jwtClient,
              calendarId: config.googleCalendarId,
              sendUpdates: "all",
              supportsAttachments: true,
              requestBody: Object.assign(
                {
                  iCalUID: `UID:${addedEvent.id}+${crypto.randomUUID()}@cyanea`,
                },
                toGCalEvent(addedEvent, timezone),
              ),
            })
          }
          for (const modifiedEvent of modified) {
            if (!cyaneaID2GCalID.has(modifiedEvent.id)) {
              throw `cyaneaID2GCalID map doesn't have existing event ${modifiedEvent.id} (this should never happen)`
            }

            await calendar.update({
              auth: jwtClient,
              calendarId: config.googleCalendarId,
              eventId: cyaneaID2GCalID.get(modifiedEvent.id)!,
              sendUpdates: "all",
              supportsAttachments: true,
              requestBody: toGCalEvent(modifiedEvent, timezone),
            })
          }
          for (const removedEvent of removed) {
            if (!cyaneaID2GCalID.has(removedEvent.id)) {
              throw `cyaneaID2GCalID map doesn't have existing event ${removedEvent.id} (this should never happen)`
            }

            await calendar.delete({
              auth: jwtClient,
              calendarId: config.googleCalendarId,
              sendUpdates: "all",
              eventId: cyaneaID2GCalID.get(removedEvent.id)!,
            })
          }
        },
      }
    },
  },
} satisfies CyaneaPlugin<undefined, undefined, GoogleCalendarConfig>
