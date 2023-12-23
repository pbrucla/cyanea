import { JSONSchemaType } from "ajv"
import _ from "lodash"

import schema from "./schema.json" with { type: "json" }

/**
 * The unified event format for ACM Cyber's Cyanea script.
 */
export default interface CyaneaEvent {
  id: string
  title: string
  type?: string | string[]
  description: string
  location: string
  banner?: string
  start: number
  end: number
  links?: Record<string, string>
  meta?: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

// TODO microsoft/Typescript#32063 microsoft/Typescript#54488
export const EVENT_SCHEMA = schema as JSONSchemaType<CyaneaEvent>

/**
 * Diffs set b of CyaneaEvents against set a.
 */
export function diff(
  a: CyaneaEvent[],
  b: CyaneaEvent[],
): {
  added: CyaneaEvent[]
  modified: CyaneaEvent[]
  removed: CyaneaEvent[]
} {
  return {
    added: _.differenceBy(b, a, x => x.id),
    removed: _.differenceBy(a, b, x => x.id),
    modified: _.differenceWith(
      _.intersectionBy(b, a, x => x.id),
      a,
      _.isEqual,
    ),
  }
}
