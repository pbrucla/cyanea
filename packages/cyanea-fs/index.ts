import { CyaneaPlugin } from "@pbrucla/cyanea-core"
import { validateEventsOrThrow } from "@pbrucla/cyanea-core/event/index.ts"
import { orDefault, resolvePathOrThrow, walk } from "@pbrucla/cyanea-core/util/index.ts"
import fs from "node:fs/promises"

interface FsConfig {
  path: string
}

interface FsFilestoreConfig extends FsConfig {
  pretty?: boolean | number
  target?: "disk" | "filestore"
}

const typescriptWontInferSpreadProperly = <T, U>(t: T, u: U): T & U => ({ ...t, ...u })

const fsConfigSchemaBuilder = <T extends Record<string, any>>(description: string, extra?: T) =>
  ({
    type: "object",
    properties: typescriptWontInferSpreadProperly(
      {
        path: {
          type: "string",
          description: description,
        } as const,
      },
      extra,
    ),
    required: ["path"],
    additionalProperties: false,
  }) as const

export default {
  filestore: {
    configSchema: fsConfigSchemaBuilder("Path to a folder where filestore artifacts will be written."),
    async load(config) {
      const basePath = resolvePathOrThrow(process.cwd(), config.path)
      await fs.mkdir(basePath, { recursive: true })

      return {
        async writeFile(file, data) {
          file = resolvePathOrThrow(basePath, file)
          await fs.writeFile(file, data)
        },

        async commit() {},
      }
    },
  },
  source: {
    configSchema: fsConfigSchemaBuilder(
      "Path to either a single JSON file or folder of JSON files to read Cyanea events from.",
    ),
    async load(config) {
      const basePath = resolvePathOrThrow(process.cwd(), config.path)

      return {
        async readEvents() {
          const allEvents = []
          const allEventIds = new Map()

          let eventSources
          if ((await fs.stat(basePath)).isDirectory()) {
            eventSources = walk(basePath)
          } else {
            eventSources = [basePath]
          }

          for await (const eventsJson of eventSources) {
            if (!eventsJson.endsWith(".json")) {
              throw `Found non-JSON file '${eventsJson}' in events directory`
            }
            let eventsContents
            try {
              eventsContents = await fs.readFile(eventsJson, "utf-8")
            } catch (e) {
              throw `failed to read Cyanea events from file '${eventsJson}': ${e}`
            }
            let events
            try {
              events = JSON.parse(eventsContents)
            } catch (e) {
              throw `failed to parse Cyanea events from file '${eventsJson}': ${e}`
            }
            validateEventsOrThrow(events)
            for (const event of events) {
              if (allEventIds.has(event.id)) {
                throw (
                  `found event with duplicate id '${event.id}' in '${eventsJson}'` +
                  ` (conflicting with an event from '${allEventIds.get(event.id)}')`
                )
              }
              allEvents.push(event)
              allEventIds.set(event.id, eventsJson)
            }
          }

          return allEvents
        },
      }
    },
  },
  sink: {
    configSchema: fsConfigSchemaBuilder("Path to a JSON file to write Cyanea events to.", {
      pretty: {
        type: ["boolean", "integer"],
        nullable: true,
        minimum: 0,
        default: 2,
        description: "Whether to pretty-print the written JSON events. Defaults to 2 spaces.",
      },
      target: {
        type: "string",
        enum: ["disk", "filestore"],
        nullable: true,
        default: "disk",
        description: "Whether to write events directly to disk or to the global filestore.",
      },
    } as const),
    async load(config) {
      const outPath = resolvePathOrThrow(config.target === "disk" ? process.cwd() : "", config.path)

      return {
        async syncEvents(events, filestore) {
          await (config.target === "disk" ? fs.writeFile : filestore.writeFile)(
            outPath,
            JSON.stringify(events, undefined, orDefault(config.pretty, 2)),
          )
        },
      }
    },
  },
} satisfies CyaneaPlugin<FsConfig, FsConfig, FsFilestoreConfig>
