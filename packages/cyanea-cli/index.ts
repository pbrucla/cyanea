const NOW = new Date()

import { CyaneaFilestore, CyaneaPlugin, CyaneaSink, CyaneaSource } from "@pbrucla/cyanea-core"
import CyaneaEvent from "@pbrucla/cyanea-core/event"
import Ajv, { DefinedError } from "ajv"
import chalk from "chalk"
import { Command } from "commander"
import fs from "node:fs/promises"
import { createRequire } from "node:module"

import { CONFIG_V1_SCHEMA } from "./config.ts"
import path from "node:path"

function die(reason: string, error?: unknown): never {
  let stack = ""
  if (error !== undefined && error !== null && typeof error === "object" && "stack" in error) {
    stack = `\n${error.stack}`
  }
  console.error(chalk.redBright(`error: ${reason}${stack}`))
  process.exit(1)
}

// =======================
// Parse command line args
// =======================

const opts = new Command()
  .alias("cyanea")
  .description("ACM Cyber's modular script for syncing unified event information across disparate platforms.")
  .requiredOption("-c, --config <cyanea.json>", "set the Cyanea config file")
  .option("--cwd <cwd>", "set Cyanea's current working directory for fresolving iles and plugins", process.cwd())
  .option("--color", "enable coloring output", true)
  .option("--no-color", "disable coloring output")
  .version(process.env.npm_package_version || "unknown", "-v, --version")
  .configureOutput({
    outputError: (str, write) => write(chalk.redBright(str)),
  })
  .parse(process.argv)
  .opts()

process.chdir(opts.cwd)

// ===========
// Load config
// ===========

let configFileContents
try {
  configFileContents = await fs.readFile(opts.config, "utf-8")
} catch (e) {
  die(`failed to read Cyanea config file: ${e}`, e)
}

const ajv = new Ajv.default()
const configV1Validator = ajv.compile(CONFIG_V1_SCHEMA)

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

const jsPluginLoader = await createRequire(path.join(process.cwd(), "__placeholder__.js"))
const tsPluginLoader = await createRequire(path.join(process.cwd(), "__placeholder__.ts"))

async function loadPluginMainModule(loader: NodeRequire, importPath: string, isModule: boolean): Promise<any> {
  if (isModule) {
    return (await import(loader.resolve(importPath))).default
  } else {
    return loader(importPath)
  }
}

async function loadPlugin<Type extends "filestore" | "source" | "sink">(
  type: Type,
  pluginName: string,
  pluginConfig: any,
): Promise<
  Type extends "filestore"
    ? CyaneaFilestore
    : Type extends "source"
      ? CyaneaSource
      : Type extends "sink"
        ? CyaneaSink
        : never
> {
  let pluginIsModule: boolean
  let pluginMain: string | null
  try {
    const packageJson = (await import(jsPluginLoader.resolve(`${pluginName}/package.json`), { with: { type: "json" } }))
      .default
    pluginIsModule = "type" in packageJson && packageJson.type === "module"
    pluginMain = "main" in packageJson && typeof packageJson.main === "string" ? packageJson.main : null
  } catch (e) {
    throw `failed to load Cyanea plugin '${pluginName}''s package.json:\n${e}`
  }

  let maybePlugin: any
  try {
    const pluginMainPath = pluginMain !== null ? path.join(pluginName, pluginMain) : pluginName
    maybePlugin = await loadPluginMainModule(jsPluginLoader, pluginMainPath, pluginIsModule)
  } catch (e) {
    if (pluginMain != null) {
      throw `failed to load Cyanea plugin '${pluginName}':\n${e}`
    } else {
      try {
        const pluginMainTsPath = path.join(pluginName, "index.ts")
        maybePlugin = await loadPluginMainModule(tsPluginLoader, pluginMainTsPath, pluginIsModule)
      } catch (e2) {
        throw `failed to load Cyanea plugin '${pluginName}':\n${e}\n\n${e2}`
      }
    }
  }

  if (!(type in maybePlugin)) {
    throw `package '${pluginName}' isn't a valid Cyanea ${type} plugin! (missing '${type}' declaration in default export)`
  }
  try {
    const plugin = maybePlugin as CyaneaPlugin<unknown, unknown, unknown>
    const pluginConfigValidator = ajv.compile(plugin[type].configSchema)
    if (!pluginConfigValidator(pluginConfig)) {
      throw `failed to parse plugin config:\n${(pluginConfigValidator.errors as DefinedError[])
        .map(x => `  ${x.schemaPath}: ${x.message}`)
        .join("\n")}`
    }
    return (await plugin[type].load(pluginConfig)) as Awaited<ReturnType<typeof loadPlugin<Type>>>
  } catch (e) {
    throw `failed to load Cyanea plugin '${pluginName}': ${e}`
  }
}

let modules: { source: CyaneaSource; filestore: CyaneaFilestore; sinks: Record<string, CyaneaSink> }
try {
  modules = {
    source: await loadPlugin("source", ...Object.entries(config.source)[0]),
    filestore: await loadPlugin("filestore", ...Object.entries(config.filestore)[0]),
    sinks: Object.fromEntries(
      await Promise.all(
        Object.entries(config.sinks).map(
          async ([pluginName, pluginConfig]) =>
            [pluginName, await loadPlugin("sink", pluginName, pluginConfig)] as const,
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
