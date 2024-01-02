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
