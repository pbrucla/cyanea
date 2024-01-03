import Ajv from "ajv"
import fs from "node:fs/promises"
import path from "node:path"

export const AJV = new Ajv.default({ allowUnionTypes: true })

/**
 * Sanitizes and resolves a relative path against a base path.
 *
 * this is definitely 100% cybersecure code
 */
export function resolvePathOrThrow(base: string, relative: string): string {
  if (relative.includes("\0")) {
    throw `refusing to resolve invalid path ${JSON.stringify(relative)}`
  }

  const normalizedRelative = path.join(".", relative)
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(normalizedRelative)) {
    throw `refusing to resolve invalid path ${JSON.stringify(relative)}`
  }

  return path.join(base, normalizedRelative)
}

/**
 * why doesn't fs.walk exist
 *
 * taken from https://gist.github.com/lovasoa/8691344
 */
export async function* walk(dir: string): AsyncGenerator<string, undefined> {
  for await (const d of await fs.opendir(dir)) {
    const entry = path.join(dir, d.name)
    if (d.isDirectory()) yield* walk(entry)
    else if (d.isFile()) yield entry
  }
}

/**
 * Given a value from a config, returns either the given value if specified, the default value if true or unspecified, or undefined if false.
 */
export function orDefault<T>(configVal: T | boolean | null | undefined, defaultVal: T): T | undefined {
  if (configVal === true || configVal === undefined || configVal === null) {
    return defaultVal
  } else if (configVal === false) {
    return undefined
  } else {
    return configVal
  }
}

/**
 * Reads a set of credentials from the environment with the given prefix and key names.
 * @returns An object with the requested credentials, or `null` if any key is unspecified and has no default.
 */
export function getEnvCredentials<const K extends (string | { key: string; default: string })[]>(
  prefix: string,
  ...envKeys: K
): { [key in K[number] as Lowercase<key extends { key: string } ? key["key"] : key>]: string } | null {
  const out: Record<string, string> = {}
  for (const key of envKeys) {
    if (typeof key === "string") {
      const value = process.env[`${prefix}_${key}`]
      if (value === null || value === undefined) {
        return null
      } else {
        out[key.toLowerCase()] = value
      }
    } else {
      out[key.key.toLowerCase()] = process.env[`${prefix}_${key.key}`] ?? key.default
    }
  }
  return out as ReturnType<typeof getEnvCredentials<K>>
}
