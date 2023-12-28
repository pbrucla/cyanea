import { CyaneaPlugin } from "@pbrucla/cyanea-core"
import { validateEventsOrThrow } from "@pbrucla/cyanea-core/event/index.ts"
import { resolvePathOrThrow, walk } from "@pbrucla/cyanea-core/util/index.ts"
import fs from "node:fs/promises"

interface FsConfig {
  path: string
}

const fsConfigSchemaBuilder = (description: string) =>
  ({
    type: "object",
    properties: {
      path: {
        type: "string",
        description: description,
      },
    },
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
    configSchema: fsConfigSchemaBuilder("Path to a JSON file to write Cyanea events to."),
    async load(config) {
      const outPath = resolvePathOrThrow(process.cwd(), config.path)

      return {
        async syncEvents(events) {
          await fs.writeFile(outPath, JSON.stringify(events))
        },
      }
    },
  },
} satisfies CyaneaPlugin<FsConfig, FsConfig, FsConfig>
