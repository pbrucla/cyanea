let NOW = new Date()

import { CyaneaFilestore, CyaneaSink, CyaneaSource } from "@pbrucla/cyanea-core"
import { AJV } from "@pbrucla/cyanea-core/util/index.ts"
import CyaneaEvent from "@pbrucla/cyanea-core/event"
import { DefinedError } from "ajv"
import chalk from "chalk"
import { Command } from "commander"
import fs from "node:fs/promises"

import { CONFIG_V1_SCHEMA } from "./config.ts"
import { loadPluginComponent } from "./plugin.ts"

function die(reason: string, error?: unknown, suffix?: string): never {
  let stack = ""
  if (error !== undefined && error !== null && typeof error === "object" && "stack" in error) {
    stack = `\n${error.stack}`
  }
  console.error(chalk.redBright(`error: ${reason}${stack}${suffix ?? ""}`))
  process.exit(1)
}

// =======================
// Parse command line args
// =======================

const command: Command = new Command()
  .name("cyanea")
  .description("ACM Cyber's modular script for syncing unified event information across disparate platforms!")
  .requiredOption("-c, --config <cyanea.json>", "set the Cyanea config file", "cyanea.json")
  .option("--cwd <cwd>", "set Cyanea's current working directory for resolving files and plugins", process.cwd())
  .option("--now <now>", "run Cyanea as if the current time was the given UNIX timestamp")
  .option("--color", "enable coloring output", true)
  .option("--no-color", "disable coloring output")
  .version(process.env.npm_package_version || "unknown", "-v, --version")
  .configureOutput({
    outputError: (str, write) => write(`${chalk.redBright(str)}\n${command.helpInformation()}`),
  })
const opts = command.parse(process.argv).opts()

process.chdir(opts.cwd)
if (opts.now !== undefined && opts.now !== null) {
  NOW = new Date(parseInt(opts.now))
}

// ===========
// Load config
// ===========

let configFileContents
try {
  configFileContents = await fs.readFile(opts.config, "utf-8")
} catch (e) {
  const isDefaultConfig = opts.config === "cyanea.json"
  die(
    `could not read${isDefaultConfig ? " (default)" : ""} Cyanea config file: ${e}`,
    e,
    isDefaultConfig ? chalk.reset(`\n\n${command.helpInformation().slice(0, -1)}`) : undefined,
  )
}

const configV1Validator = AJV.compile(CONFIG_V1_SCHEMA)

let config
try {
  const configJson = JSON.parse(configFileContents)
  if (!("version" in configJson)) {
    die("Cyanea config does not contain a version.")
  }
  if (configJson.version != 1) {
    die(`Cyanea config has unsupported version '${configJson.version}'`)
  }
  if (!configV1Validator(configJson)) {
    throw `\n${(configV1Validator.errors as DefinedError[]).map(x => `  ${x.schemaPath}: ${x.message}`).join("\n")}`
  }
  config = configJson
} catch (e) {
  die(`failed to parse Cyanea config file: ${e}`, e)
}

// ============
// Init plugins
// ============

console.log(chalk.blueBright("Loading plugins..."))

let modules: { source: CyaneaSource; filestore: CyaneaFilestore; sinks: Record<string, CyaneaSink> }
try {
  modules = {
    source: await loadPluginComponent("source", ...Object.entries(config.source)[0]),
    filestore: await loadPluginComponent("filestore", ...Object.entries(config.filestore)[0]),
    sinks: Object.fromEntries(
      await Promise.all(
        Object.entries(config.sinks).map(
          async ([pluginName, pluginConfig]) =>
            [pluginName, await loadPluginComponent("sink", pluginName, pluginConfig)] as const,
        ),
      ),
    ),
  }
} catch (e) {
  die(`${e}`, e)
}

// ===========
// Read source
// ===========

console.log(chalk.blueBright("Reading source of truth..."))
let events: CyaneaEvent[]
try {
  events = await modules.source.readEvents()
  console.log(`Loaded ${events.length} event${events.length !== 1 ? "s" : ""}!`)
} catch (e) {
  die(`failed to read from source: ${e}`, e)
}

// ===========
// Push events
// ===========

const numSinks = Object.keys(modules.sinks).length
console.log(chalk.blueBright(`Syncing ${numSinks} sink${numSinks !== 1 ? "s" : ""}...`))
try {
  const results = await Promise.allSettled(
    Object.entries(modules.sinks).map(([name, module]) =>
      module.syncEvents(events, modules.filestore, NOW).catch(reason => {
        throw `  ${name}: ${reason}`
      }),
    ),
  )
  const errors = results.flatMap(x => (x.status == "rejected" ? [x.reason] : []))
  if (errors.length != 0) {
    throw `\n${errors.join("\n")}`
  }
} catch (e) {
  die(`failed to push events to sinks: ${e}`, e)
}

// ====================
// Filestore committing
// ====================

console.log(chalk.blueBright("Comitting changes..."))
try {
  await modules.filestore.commit()
} catch (e) {
  die(`failed to commit changes to the filestore: ${e}`, e)
}

console.log(chalk.blueBright("Sucessfully synced all events!"))
process.exit(0)
