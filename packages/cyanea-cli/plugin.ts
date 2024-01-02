import { CyaneaFilestore, CyaneaPlugin, CyaneaSink, CyaneaSource } from "@pbrucla/cyanea-core"
import Ajv, { DefinedError } from "ajv"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import url from "node:url"

// injected at build time; points to bundled plugins directory
const distPluginsFolder = process.env.DIST_PLUGINS_FOLDER

const ajv = new Ajv.default()

export async function loadPluginMainModule(loader: NodeRequire, importPath: string, isModule: boolean): Promise<any> {
  if (isModule) {
    return (await import(loader.resolve(importPath))).default
  } else {
    return loader(importPath)
  }
}

export async function loadPlugin(pluginName: string): Promise<any> {
  const jsPluginLoader = createRequire(path.join(process.cwd(), "__placeholder__.js"))
  let builtinPlugin: string | null = null
  let pluginMain: string | null = null
  let pluginIsModule: boolean = false
  try {
    const packageJson = (await import(jsPluginLoader.resolve(`${pluginName}/package.json`), { with: { type: "json" } }))
      .default
    pluginMain = "main" in packageJson && typeof packageJson.main === "string" ? packageJson.main : null
    pluginIsModule = "type" in packageJson && packageJson.type === "module"
  } catch (e) {
    if (distPluginsFolder) {
      const maybeBuiltinPlugin = path.join(
        path.dirname(url.fileURLToPath(import.meta.url)),
        distPluginsFolder,
        pluginName + ".mjs",
      )
      if (
        await fs.access(maybeBuiltinPlugin, fs.constants.R_OK).then(
          () => true,
          () => false,
        )
      ) {
        builtinPlugin = maybeBuiltinPlugin
        pluginIsModule = true
      }
    }
    if (builtinPlugin === null) {
      throw `failed to load Cyanea plugin '${pluginName}''s package.json:\n${e}`
    }
  }

  try {
    const pluginMainPath = builtinPlugin ?? (pluginMain !== null ? path.join(pluginName, pluginMain) : pluginName)
    return await loadPluginMainModule(jsPluginLoader, pluginMainPath, pluginIsModule)
  } catch (e) {
    if (builtinPlugin != null) {
      throw `failed to load built-in Cyanea plugin '${pluginName}' from ${builtinPlugin}:\n${e}`
    } else if (pluginMain != null) {
      throw `failed to load Cyanea plugin '${pluginName}':\n${e}`
    } else {
      try {
        const tsPluginLoader = createRequire(path.join(process.cwd(), "__placeholder__.ts"))
        const pluginMainTsPath = path.join(pluginName, "index.ts")
        return await loadPluginMainModule(tsPluginLoader, pluginMainTsPath, pluginIsModule)
      } catch (e2) {
        throw `failed to load Cyanea plugin '${pluginName}':\n${e}\n\n${e2}`
      }
    }
  }
}

export async function loadPluginComponent<Type extends "filestore" | "source" | "sink">(
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
  const maybePlugin = await loadPlugin(pluginName)
  if (!(type in maybePlugin) || maybePlugin[type] === undefined || maybePlugin[type] === null) {
    throw `package '${pluginName}' isn't a valid Cyanea ${type} plugin! (missing '${type}' declaration in default export)`
  }
  if (
    typeof maybePlugin[type] !== "object" ||
    !("configSchema" in maybePlugin[type]) ||
    !("load" in maybePlugin[type]) ||
    typeof maybePlugin[type].load !== "function"
  ) {
    throw `package '${pluginName}' isn't a valid Cyanea ${type} plugin! ('${type}' declaration is not a CyaneaPluginComponent)`
  }

  try {
    const plugin = maybePlugin as CyaneaPlugin<unknown, unknown, unknown>
    const pluginConfigValidator = ajv.compile(plugin[type].configSchema)
    if (!pluginConfigValidator(pluginConfig)) {
      throw `failed to parse plugin config:\n${(pluginConfigValidator.errors as DefinedError[])
        .map(x => `  ${x.schemaPath}: ${x.message}`)
        .join("\n")}`
    }
    return (await plugin[type].load(pluginConfig)) as Awaited<ReturnType<typeof loadPluginComponent<Type>>>
  } catch (e) {
    throw `failed to load Cyanea plugin '${pluginName}': ${e}`
  }
}
