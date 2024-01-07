import { CyaneaPlugin } from "@pbrucla/cyanea-core"
import { getEnvCredentials } from "@pbrucla/cyanea-core/util/index.ts"
import CyaneaEvent, { diff } from "@pbrucla/cyanea-core/event/index.ts"
import chalk from "chalk"
import { google } from "googleapis"
import { DateTime, IANAZone, Settings as LuxonSettings } from "luxon"

LuxonSettings.throwOnInvalid = true
declare module "luxon" {
  interface TSSettings {
    throwOnInvalid: true
  }
}

// smh the newsletter doesn't support 5+ digit years ~ Andrew
const NEWSLETTER_DATE_FORMAT = "yyyy-MM-dd"
const NEWSLETTER_TIME_FORMAT = "t"
// google sheets can inconsistently format dates (concern)
const NEWSLETTER_PARSE_FORMAT_1 = `yyyy-MM-dd t`
const NEWSLETTER_PARSE_FORMAT_2 = `yyyy-M-d t`

const CYANEA_METADATA_COLUMN = "M"
const CYANEA_METADATA_COLUMN_INDEX = CYANEA_METADATA_COLUMN.charCodeAt(0) - "A".charCodeAt(0)

// TODO document credentials:
//
// - CYANEA_UCLA_ACM_NEWSLETTER_CLIENT_EMAIL
// - CYANEA_UCLA_ACM_NEWSLETTER_PRIVATE_KEY

interface ACMNewsletterConfigQuarter {
  name?: string
  weeks?: number
  weekOneMonday: number
  googleSheetId: string
}

interface ACMNewsletterConfig {
  timezone?: string
  committee:
    | "general"
    | "impact"
    | "external"
    | "board"
    | "teachla"
    | "ai"
    | "cyber"
    | "design"
    | "hack"
    | "icpc"
    | "studio"
    | "w"
  quarters: ACMNewsletterConfigQuarter[]
}

function tryParseDateAndTime(date: any, time: any, zone: IANAZone): DateTime {
  try {
    return DateTime.fromFormat(`${date} ${time}`, NEWSLETTER_PARSE_FORMAT_1, { zone })
  } catch {
    return DateTime.fromFormat(`${date} ${time}`, NEWSLETTER_PARSE_FORMAT_2, { zone })
  }
}

function prettifyCommittee(committee: ACMNewsletterConfig["committee"]): string {
  switch (committee) {
    case "general":
      return "General"
    case "impact":
      return "Impact"
    case "external":
      return "External"
    case "board":
      return "Board"
    case "teachla":
      return "TeachLA"
    case "ai":
      return "AI"
    case "cyber":
      return "Cyber"
    case "design":
      return "Design"
    case "hack":
      return "Hack"
    case "icpc":
      return "ICPC"
    case "studio":
      return "Studio"
    case "w":
      return "W"
    default:
      throw `invalid committee ${committee} (this should never happen)`
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
          description: "The timezone to calculate weeks-of-the-quarter in.",
        },
        committee: {
          type: "string",
          enum: [
            "general",
            "impact",
            "external",
            "board",
            "teachla",
            "ai",
            "cyber",
            "design",
            "hack",
            "icpc",
            "studio",
            "w",
          ] as const,
          description: "The UCLA ACM committee to publish events under.",
        },
        quarters: {
          type: "array",
          items: {
            type: "object",
            description: "One quarter of the UCLA calendar year.",
            properties: {
              name: {
                type: "string",
                nullable: true,
                description: "Optional human-readable name for this quarter.",
              },
              weeks: {
                type: "integer",
                minimum: 1,
                nullable: true,
                default: 10,
                description: "How many weeks this quarter lasts for (defaults to 10).",
              },
              weekOneMonday: {
                type: "integer",
                description: "Midnight on Monday of Week 1 of this quarter, in UNIX timestamp format.",
              },
              googleSheetId: {
                type: "string",
                description: "The ACM Newsletter Google Sheet id to write this quarter's events to.",
              },
            },
            required: ["weekOneMonday", "googleSheetId"],
            additionalProperties: false,
            nullable: false,
          },
          minItems: 0,
        },
      },
      additionalProperties: false,
      required: ["committee", "quarters"],
    },
    async load(config) {
      const timezone = IANAZone.create(config.timezone ?? "America/Los_Angeles")
      const resolvedQuarters = config.quarters.map(q => {
        const weekOneMonday = DateTime.fromMillis(q.weekOneMonday, { zone: timezone })
        if (
          weekOneMonday.weekday !== 1 ||
          weekOneMonday.hour !== 0 ||
          weekOneMonday.minute !== 0 ||
          weekOneMonday.second !== 0 ||
          weekOneMonday.millisecond !== 0
        ) {
          throw `UNIX timestamp ${weekOneMonday} is not midnight on a Monday in the ${timezone.name} timezone`
        }

        return {
          weeks: q.weeks ?? 10,
          weekOneMonday,
          googleSheetId: q.googleSheetId,
        }
      })

      const creds = getEnvCredentials("CYANEA_UCLA_ACM_NEWSLETTER", "CLIENT_EMAIL", "PRIVATE_KEY")
      if (creds === null) {
        throw `cyanea-ucla-acm-newsletter is missing required credentials!
       Please set CYANEA_UCLA_ACM_NEWSLETTER_[CLIENT_EMAIL, PRIVATE_KEY] with valid Google Sheets API credentials.`
      }

      const sheets = google.sheets({ version: "v4" }).spreadsheets.values
      const jwtClient = new google.auth.JWT(creds.client_email, "", creds.private_key, [
        "https://www.googleapis.com/auth/spreadsheets",
      ])
      await jwtClient.authorize()

      return {
        async syncEvents(events, _filestore, now) {
          const luxNow = DateTime.fromJSDate(now, { zone: timezone })

          // preprocess events a bit
          const processedEvents = events.map(e => {
            // run a couple of sanity checks
            if (e.end < e.start) {
              throw `event with id ${e.id} ends before it starts`
            }

            // remove metadata from events that cannot be represented in the newsletter
            // so that diffing with data from the newsletter works later
            e.type = undefined
            if (e.links) {
              if ("discord" in e.links) {
                e.links = { discord: e.links.discord }
              } else if ("facebook" in e.links) {
                e.links = { discord: e.links.facebook }
              } else {
                e.links = undefined
              }
            } else {
              e.links = undefined
            }
            e.meta = undefined

            // make sure banner is set to some value for diffing
            e.banner ??= ""

            // drop anything higher than minute precision because
            // the acm newsletter only supports minute precision
            const start = DateTime.fromMillis(e.start, { zone: timezone }).startOf("minute")
            const end = DateTime.fromMillis(e.end, { zone: timezone }).startOf("minute")
            e.start = start.toMillis()
            e.end = end.toMillis()

            return [e, { start, end }] as const
          })

          // for each quarter...
          for (const quarter of resolvedQuarters) {
            // update only quarter(s) that intersect the current time
            const endOfQuarter = quarter.weekOneMonday.plus({ weeks: quarter.weeks })
            if (luxNow >= quarter.weekOneMonday && luxNow < endOfQuarter) {
              // grab existing rows in the sheet for diffing
              const existingSheetRows = (
                await sheets.batchGet({
                  auth: jwtClient,
                  spreadsheetId: quarter.googleSheetId,
                  ranges: Array.from(
                    new Array(quarter.weeks),
                    (_x, i) => `'Week ${i + 1}'!A:${CYANEA_METADATA_COLUMN}`,
                  ),
                })
              )?.data.valueRanges

              if (!existingSheetRows || !existingSheetRows.every(w => !!w.values)) {
                throw `Failed to fetch Google Sheet row data for spreadsheet id '${quarter.googleSheetId}'`
              }
              const missingRows = existingSheetRows.flatMap((w, i) => (w.values ? [] : [`${i + 1}`]))
              if (missingRows.length > 0) {
                throw `Failed to fetch full Google Sheet row data for spreadsheet id '${
                  quarter.googleSheetId
                }': missing weeks ${missingRows.join(", ")}`
              }

              const rowsToUpdate: { range: string; values: any[][] }[] = []

              // for each week...
              for (let week = 1; week <= quarter.weeks; week++) {
                const startOfWeek = quarter.weekOneMonday.plus({ weeks: week - 1 })
                const endOfWeek = quarter.weekOneMonday.plus({ weeks: week })

                // figure out what events occur this week
                // this will throw on events that end before they begin
                // and ignore events that cross day and/or week boundaries
                const eventsThisWeek = processedEvents.flatMap(([e, l]) => {
                  // only include this event if it occurs entirely within this week
                  if (l.start >= startOfWeek && l.end < endOfWeek) {
                    if (l.start.startOf("day").toMillis() != l.end.startOf("day").toMillis()) {
                      console.warn(
                        chalk.yellow(
                          ` warn: refusing to sync event ${e.id} that spans multiple days (the ACM newsletter does not currently support multiple-day events)`,
                        ),
                      )
                      return []
                    } else {
                      return [e]
                    }
                  } else {
                    return []
                  }
                })

                // grab events from this week that were previously sync'd to the newsletter,
                // making sure to keep track of which row an event originates from for later updating
                const [existingEventsThisWeek, idToRow] = existingSheetRows[week - 1]
                  .values!.map((row, i) => [row, i] as const)
                  .filter(
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    ([row, _i]) =>
                      row.length >= 13 &&
                      typeof row[0] === "string" &&
                      row[0].toLowerCase() === config.committee &&
                      typeof row[CYANEA_METADATA_COLUMN_INDEX] === "string" &&
                      row[CYANEA_METADATA_COLUMN_INDEX].startsWith("cyanea:id="),
                  )
                  .map(
                    ([row, i]) =>
                      [
                        {
                          id: (row[CYANEA_METADATA_COLUMN_INDEX] as string).substring(10),
                          title: String(row[1] ?? ""),
                          type: undefined,
                          description: String(row[6] ?? ""),
                          location: String(row[5] ?? ""),
                          banner: String(row[8] ?? ""),
                          start: tryParseDateAndTime(row[2], row[3], timezone).toMillis(),
                          end: tryParseDateAndTime(row[2], row[4], timezone).toMillis(),
                          links: row[7] ? { discord: row[7] } : undefined,
                          meta: undefined,
                        },
                        i,
                      ] as const,
                  )
                  .reduce(
                    ([events, idToRow], [event, i]) => {
                      events.push(event)
                      idToRow.set(event.id, i)
                      return [events, idToRow]
                    },
                    [new Array<CyaneaEvent>(), new Map<string, number>()] as const,
                  )

                // diff events!
                const { added, modified, removed } = diff(existingEventsThisWeek, eventsThisWeek)

                // update all modified events and replace as many deleted events with added events as possible
                // this code is careful to not touch columns J-${CYANEA_METADATA_COLUMN} in case a human added
                // something in those columns
                for (const [replaceId, eventToUpdate] of [
                  ...modified.map(e => [e.id, e] as const),
                  ...added.slice(0, removed.length).map((e, i) => [removed[i].id, e] as const),
                ]) {
                  if (!idToRow.has(replaceId))
                    throw `idToRow map doesn't have existing event ${replaceId} (this should never happen)`
                  const updateRow = idToRow.get(replaceId)! + 1
                  const start = DateTime.fromMillis(eventToUpdate.start, { zone: timezone })
                  const end = DateTime.fromMillis(eventToUpdate.end, { zone: timezone })

                  rowsToUpdate.push({
                    range: `'Week ${week}'!A${updateRow}:I${updateRow}`,
                    values: [
                      [
                        prettifyCommittee(config.committee),
                        eventToUpdate.title,
                        start.toFormat(NEWSLETTER_DATE_FORMAT),
                        start.toFormat(NEWSLETTER_TIME_FORMAT),
                        end.toFormat(NEWSLETTER_TIME_FORMAT),
                        eventToUpdate.location,
                        eventToUpdate.description,
                        eventToUpdate.links && "discord" in eventToUpdate.links
                          ? eventToUpdate.links.discord
                          : undefined,
                        eventToUpdate.banner,
                      ],
                    ],
                  })
                  rowsToUpdate.push({
                    range: `'Week ${week}'!${CYANEA_METADATA_COLUMN}${updateRow}:${CYANEA_METADATA_COLUMN}${updateRow}`,
                    values: [[`cyanea:id=${eventToUpdate.id}`]],
                  })
                }

                if (removed.length > added.length) {
                  // delete any remaining events
                  for (const removedEvent of removed.slice(added.length)) {
                    if (!idToRow.has(removedEvent.id))
                      throw `idToRow map doesn't have existing event ${removedEvent.id} (this should never happen)`
                    const yeetRow = idToRow.get(removedEvent.id)! + 1
                    rowsToUpdate.push({
                      range: `'Week ${week}'!A${yeetRow}:${CYANEA_METADATA_COLUMN}${yeetRow}`,
                      values: [Array.from(new Array(CYANEA_METADATA_COLUMN_INDEX + 1), () => "")],
                    })
                  }
                } else if (added.length > removed.length) {
                  // add the rest of the events at the bottom
                  let nextEmptyRow = existingSheetRows[week - 1].values!.length + 1
                  for (const addedEvent of added.slice(removed.length)) {
                    const start = DateTime.fromMillis(addedEvent.start, { zone: timezone })
                    const end = DateTime.fromMillis(addedEvent.end, { zone: timezone })
                    rowsToUpdate.push({
                      range: `'Week ${week}'!A${nextEmptyRow}:${CYANEA_METADATA_COLUMN}${nextEmptyRow}`,
                      values: [
                        [
                          prettifyCommittee(config.committee),
                          addedEvent.title,
                          start.toFormat(NEWSLETTER_DATE_FORMAT),
                          start.toFormat(NEWSLETTER_TIME_FORMAT),
                          end.toFormat(NEWSLETTER_TIME_FORMAT),
                          addedEvent.location,
                          addedEvent.description,
                          addedEvent.links && "discord" in addedEvent.links ? addedEvent.links.discord : undefined,
                          addedEvent.banner,
                          ...Array.from(new Array(CYANEA_METADATA_COLUMN_INDEX - 1 - 8), () => ""),
                          `cyanea:id=${addedEvent.id}`,
                        ],
                      ],
                    })

                    nextEmptyRow++
                  }
                }
              }

              // finally, write all changes back to the sheet for this quarter!
              console.debug(`Pushing ${rowsToUpdate.length} updated ranges to Google Sheets...`)
              await sheets.batchUpdate({
                auth: jwtClient,
                spreadsheetId: quarter.googleSheetId,
                requestBody: {
                  data: rowsToUpdate,
                  valueInputOption: "USER_ENTERED",
                },
              })
            }
          }
        },
      }
    },
  },
} satisfies CyaneaPlugin<undefined, undefined, ACMNewsletterConfig>
