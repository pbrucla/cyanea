import { REST } from "@discordjs/rest"
import { CyaneaPlugin } from "@pbrucla/cyanea-core"
import { getEnvCredentials } from "@pbrucla/cyanea-core/util/index.ts"
import CyaneaEvent, { diff } from "@pbrucla/cyanea-core/event/index.ts"
import chalk from "chalk"
import {
  Routes,
  APIGuild as Guild,
  APIGuildScheduledEvent as GuildScheduledEvent,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  RESTPostAPIGuildScheduledEventJSONBody,
  GuildScheduledEventStatus,
} from "discord-api-types/v10"
import ffmpeg from "fluent-ffmpeg"
import StegCloak from "stegcloak"
import { Writable } from "node:stream"

const DISCORD_API_REASON = "Syncing events via the Cyanea Discord Bot"

const stegcloak = new StegCloak(false, false)
const zwc = (StegCloak as typeof StegCloak & { get zwc(): string[] }).zwc
const zwcRegex = new RegExp(`[${zwc.join("")}]`)
const zwcPlusRegex = new RegExp(`[${zwc.join("")}]{2,}`, "g")
const zwcYeetRegex = new RegExp(`(?<=[^${zwc.join("")}])\u200d(?=[^${zwc.join("")}])`, "g")

// TODO document credentials:
//
// - CYANEA_DISCORD_TOKEN

// Since this Discord sync code can't automatically update images
// if they're later updated elsewhere, you can define the following
// env variable to force an image resync
const FORCE_RESYNC_IMAGES = process.env.CYANEA_DISCORD_FORCE_RESYNC_IMAGES === "true"

interface DiscordConfig {
  guildId: string
}

interface StegcloakdCyaneaMetadata {
  // event id
  i: string
  // event banner url
  b?: string | undefined
}

function stegcloakEventDescription(id: string, banner: string | null | undefined, description: string): string {
  const metadata: StegcloakdCyaneaMetadata = { i: id, ...(banner ? { b: banner } : {}) }
  return stegcloak.hide(JSON.stringify(metadata), "", description)
}

async function toDiscordEvent(event: CyaneaEvent): Promise<RESTPostAPIGuildScheduledEventJSONBody> {
  // fetch the associated banner image and convert it to png, if possible
  let encodedBanner: string | undefined = undefined
  if (event.banner !== undefined && event.banner !== null) {
    if (event.banner.startsWith("http://") || event.banner.startsWith("https://")) {
      try {
        const banner = event.banner
        const parts: Buffer[] = []
        await new Promise<void>((resolve, reject) => {
          ffmpeg(banner)
            .on("start", x => console.log(`Processing banner '${event.banner}' for Discord with command line '${x}'`))
            .on("error", e => reject(e))
            .on("end", () => resolve())
            .frames(1)
            .outputFormat("image2")
            .videoCodec("png")
            .outputOption("-update", "1")
            .pipe(
              new Writable({
                write(chunk, _encoding, callback) {
                  parts.push(chunk)
                  callback()
                },
              }),
            )
        })
        encodedBanner = "data:image/png;base64," + Buffer.concat(parts).toString("base64")
      } catch (e) {
        console.log(
          chalk.yellow(
            ` warn: failed to download and convert banner '${event.banner}' for event ${event.id} for Discord: ${e}`,
          ),
        )
      }
    } else {
      console.log(
        chalk.yellow(
          ` warn: cyanea-discord only supports http:// and https:// banner URLs currently - refusing to attach banner '${event.banner}' to event ${event.id}`,
        ),
      )
    }
  }

  // build the discord event!
  // if the banner image can't fit in the metadata just drop it lol
  let description = stegcloakEventDescription(event.id, event.banner, event.description)
  if (description.length > 1000) {
    description = stegcloakEventDescription(event.id, undefined, event.description)
    if (description.length > 1000) {
      throw `event ${event.id}'s stegcloak'd event id + description is longer than 1000 characters (this should have been thrown as an earlier exception !??)`
    }
  }
  return {
    entity_type: GuildScheduledEventEntityType.External,
    entity_metadata: {
      location: event.location,
    },
    name: event.title,
    scheduled_start_time: new Date(event.start).toISOString(),
    scheduled_end_time: new Date(event.end).toISOString(),
    description,
    image: encodedBanner,
    privacy_level: GuildScheduledEventPrivacyLevel.GuildOnly,
  }
}

export default {
  sink: {
    configSchema: {
      type: "object",
      properties: {
        guildId: {
          type: "string",
          description: "The Discord server to write events to.",
        },
      },
      additionalProperties: false,
      required: ["guildId"],
    },
    async load(config) {
      const creds = getEnvCredentials("CYANEA_DISCORD", "TOKEN")
      if (creds === null) {
        throw `cyanea-discord is missing required credentials!
       Please set CYANEA_DISCORD_[TOKEN] with a valid Discord bot token.`
      }

      // make sure we can access the guild in question
      const discord = new REST({ version: "10" }).setToken(creds.token)
      const guild = (await discord.get(Routes.guild(config.guildId))) as Guild

      return {
        async syncEvents(events, _filestore, now) {
          // preprocess events a bit
          const processedEvents = events.flatMap(e => {
            // run a couple of sanity checks
            if (e.end < e.start) {
              throw `event with id ${e.id} ends before it starts`
            }

            // only sync events that occur in the future
            if (e.start <= now.valueOf()) {
              return []
            }

            // handle stegcloak implementation details
            if (e.description.split(" ").length < 2) {
              throw `cannot sync event ${e.id} to Discord - description must have at least 2 words due to stegcloak implementation details`
            }
            if (zwcRegex.test(e.description)) {
              console.warn(
                chalk.yellow(
                  ` warn: event ${e.id}'s description has zero-width characters ${JSON.stringify(
                    zwc,
                  )} - this may cause stegcloak to die later`,
                ),
              )
            }
            if (stegcloakEventDescription(e.id, e.banner, e.description).length > 1000) {
              if (stegcloakEventDescription(e.id, undefined, e.description).length > 1000) {
                throw `cannot sync event ${e.id} to Discord - stegcloak'd event id + description is longer than 1000 characters`
              }
              console.warn(
                chalk.yellow(
                  ` warn: event ${e.id}'s stegcloak'd metadata is longer than 1000 characters - banner metadata will not be written to Discord!
       (this will cause cyanea-discord to always re-sync this event in the future)`,
                ),
              )
            }

            // remove metadata from events that cannot be represented in discord
            // so that diffing with data from discord works later
            e.type = undefined
            e.links = undefined
            e.meta = undefined

            // force banners to be null if undefined
            // for diffing with StegcloakdCyaneaMetadata
            e.banner ??= null

            return [e]
          })

          // grab existing scheduled events
          const existingEvents: CyaneaEvent[] = []
          const cyaneaID2DiscordID = new Map<string, string>()

          const existingDiscordEvents = (await discord.get(
            Routes.guildScheduledEvents(config.guildId),
          )) as GuildScheduledEvent[]
          for (const discordEvent of existingDiscordEvents) {
            if (
              discordEvent.status === GuildScheduledEventStatus.Canceled ||
              discordEvent.description === null ||
              discordEvent.description === undefined
            ) {
              continue
            }

            // reveal and parse the stegcloak'd payload, if any
            let cyaneaMetadata: string
            try {
              cyaneaMetadata = stegcloak.reveal(discordEvent.description.replaceAll(zwcYeetRegex, ""), "")
            } catch (e) {
              if (
                e instanceof Error &&
                e.message ===
                  "Invisible stream not detected! Please copy and paste the StegCloak text sent by the sender."
              ) {
                continue
              } else {
                console.warn(
                  chalk.yellow(` warn: failed to reveal stegcloak'd Cyanea metadata in event ${discordEvent.id}: ${e}`),
                )
                continue
              }
            }
            let parsedMetadata: StegcloakdCyaneaMetadata
            try {
              parsedMetadata = JSON.parse(cyaneaMetadata)
              if (!("i" in parsedMetadata)) throw "no i field found"
            } catch (e) {
              console.warn(
                chalk.yellow(` warn: failed to parse stegcloak'd Cyanea metadata in event ${discordEvent.id}: ${e}`),
              )
              continue
            }

            if (cyaneaID2DiscordID.has(parsedMetadata.i)) {
              throw `Discord returned an event with duplicate stegcloaked id ${parsedMetadata.i}`
            }
            cyaneaID2DiscordID.set(parsedMetadata.i, discordEvent.id)

            // if there's no end time in discord, just pretend it's the same as the start time - this will likely be fixed later
            const start = Date.parse(discordEvent.scheduled_start_time).valueOf()
            const end = discordEvent.scheduled_end_time ? Date.parse(discordEvent.scheduled_end_time).valueOf() : start
            existingEvents.push({
              id: parsedMetadata.i,
              title: discordEvent.name ?? "",
              type: undefined,
              description: discordEvent.description.replaceAll(zwcPlusRegex, ""),
              location: discordEvent.entity_metadata?.location ?? "",
              banner: FORCE_RESYNC_IMAGES ? null : parsedMetadata.b ?? null,
              start,
              end,
              links: undefined,
              meta: undefined,
            })
          }

          // diff events!
          const { added, modified, removed } = diff(existingEvents, processedEvents)

          console.debug(
            `Syncing ${added.length}+${modified.length}+${removed.length} added/modified/removed events to Discord guild '${guild.name}'...`,
          )

          // add, update, and delete events
          for (const addedEvent of added) {
            await discord.post(Routes.guildScheduledEvents(config.guildId), {
              reason: DISCORD_API_REASON,
              body: await toDiscordEvent(addedEvent),
            })
          }
          for (const modifiedEvent of modified) {
            if (!cyaneaID2DiscordID.has(modifiedEvent.id)) {
              throw `cyaneaID2DiscordID map doesn't have existing event ${modifiedEvent.id} (this should never happen)`
            }

            await discord.patch(Routes.guildScheduledEvent(config.guildId, cyaneaID2DiscordID.get(modifiedEvent.id)!), {
              reason: DISCORD_API_REASON,
              body: await toDiscordEvent(modifiedEvent),
            })
          }
          for (const removedEvent of removed) {
            if (!cyaneaID2DiscordID.has(removedEvent.id)) {
              throw `cyaneaID2DiscordID map doesn't have existing event ${removedEvent.id} (this should never happen)`
            }

            await discord.delete(Routes.guildScheduledEvent(config.guildId, cyaneaID2DiscordID.get(removedEvent.id)!), {
              reason: DISCORD_API_REASON,
            })
          }
        },
      }
    },
  },
} satisfies CyaneaPlugin<undefined, undefined, DiscordConfig>
