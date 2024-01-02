import { CONFIG_V1_SCHEMA } from "@pbrucla/cyanea-cli/config.ts"
import { loadPlugin } from "@pbrucla/cyanea-cli/plugin.ts"
import chalk from "chalk"
import esbuild from "esbuild"
import child_process from "node:child_process"
import fs from "node:fs/promises"
import util from "node:util"

function generateBanner(packageName: string): { js: string } {
  // fixes https://github.com/evanw/esbuild/issues/1921#issuecomment-1152991694
  return {
    js: `/** ${packageName} - ACM Cyber's modular script for syncing unified event information across disparate platforms! **/\nvar require=(await import("module")).createRequire(import.meta.url)`,
  }
}

const COMMON_ESLINT_OPTS: esbuild.BuildOptions = {
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: "esnext",
}

console.log(chalk.blueBright("Locating packages..."))

const packages = new Set<string>()
for await (const p of await fs.opendir("packages")) {
  packages.add(p.name)
}

// make sure cyanea-cli actually exists
if (!packages.has("cyanea-cli")) {
  throw "fatal: could not find packages/cyanea-cli"
}
// don't build cyanea-core explicitly
packages.delete("cyanea-core")

console.log(chalk.blueBright("Building cyanea-cli..."))
await esbuild.build({
  entryPoints: ["packages/cyanea-cli/index.ts"],
  outfile: "dist/cyanea.mjs",
  banner: generateBanner("cyanea"),
  define: {
    "process.env.DIST_PLUGINS_FOLDER": `"plugins"`,
  },
  ...COMMON_ESLINT_OPTS,
})
packages.delete("cyanea-cli")

const configs: {
  filestore: Record<string, Record<string, any>>
  source: Record<string, Record<string, any>>
  sink: Record<string, Record<string, any>>
} = { filestore: {}, source: {}, sink: {} }

for (const p of packages) {
  console.log(chalk.blueBright(`Building plugin ${p}...`))

  const plugin = await loadPlugin(`@pbrucla/${p}`)
  if (plugin === null || typeof plugin !== "object") {
    throw `package 'packages/${p}' is not a plugin`
  }

  for (const type of ["filestore", "source", "sink"] as const) {
    if (plugin[type] !== undefined && plugin[type] !== null) {
      if (typeof plugin[type] != "object" || !("configSchema" in plugin[type])) {
        throw `package 'packages/${p}''s ${type} declaration is not a CyaneaPluginComponent`
      }
      const pluginConfigSchema = plugin[type].configSchema as Record<string, any>
      if (!("description" in pluginConfigSchema)) {
        pluginConfigSchema["description"] = `@pbrucla/${p} ${type} config options.`
      }
      configs[type][`@pbrucla/${p}`] = pluginConfigSchema
    }
  }

  await esbuild.build({
    entryPoints: [`packages/${p}/index.ts`],
    outfile: `dist/plugins/@pbrucla/${p}.mjs`,
    banner: generateBanner(`@pbrucla/${p}`),
    ...COMMON_ESLINT_OPTS,
  })
}

console.log(chalk.blueBright("Exporting schemas..."))

await fs.mkdir("dist/schemas", { recursive: true })
await fs.copyFile("packages/cyanea-core/event/event.schema.json", "dist/schemas/event.json")
await fs.copyFile("packages/cyanea-core/event/events.schema.json", "dist/schemas/events.json")

const finalConfigSchema = CONFIG_V1_SCHEMA
finalConfigSchema.properties!.filestore["properties"] = configs.filestore
finalConfigSchema.properties!.source["properties"] = configs.source
finalConfigSchema.properties!.sinks["properties"] = configs.sink

await fs.writeFile("dist/schemas/config.json", JSON.stringify(finalConfigSchema, undefined, 2))

console.log(chalk.blueBright("Exporting licenses..."))

await fs.writeFile(
  "dist/LICENSE-3RD-PARTY.txt",
  (await util.promisify(child_process.exec)("yarn licenses generate-disclaimer --recursive --production")).stdout,
)

console.log(chalk.blueBright("Build succeeded!"))
process.exit(0)
