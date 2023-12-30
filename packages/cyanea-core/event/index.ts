import Ajv, { DefinedError, JSONSchemaType } from "ajv"
import _ from "lodash"

import schema from "./event.schema.json" with { type: "json" }

/**
 * The unified event format for ACM Cyber's Cyanea script.
 */
export default interface CyaneaEvent {
  id: string
  title: string
  type?: string | string[] | null
  description: string
  location: string
  banner?: string | null
  start: number
  end: number
  links?: Record<string, string> | null
  meta?: Record<string, any> | null
}

// TODO microsoft/Typescript#32063 microsoft/Typescript#54488
export const EVENT_SCHEMA = { ...schema, $schema: undefined } as unknown as JSONSchemaType<CyaneaEvent>

const EVENT_VALIDATOR = new Ajv.default().compile(EVENT_SCHEMA)

export function validateEvent(event: unknown): event is CyaneaEvent {
  return EVENT_VALIDATOR(event)
}

export function validateEventOrThrow(event: unknown): asserts event is CyaneaEvent {
  if (!EVENT_VALIDATOR(event)) {
    throw `failed to validate Cyanea event:\n${(EVENT_VALIDATOR.errors as DefinedError[])
      .map(x => `  ${x.schemaPath}: ${x.message}`)
      .join("\n")}`
  }
}

const EVENTS_VALIDATOR = new Ajv.default().compile<CyaneaEvent[]>({
  type: "array",
  items: EVENT_SCHEMA,
})

export function validateEvents(events: unknown): events is CyaneaEvent[] {
  return EVENTS_VALIDATOR(events)
}

export function validateEventsOrThrow(events: unknown): asserts events is CyaneaEvent[] {
  if (!EVENTS_VALIDATOR(events)) {
    throw `failed to validate Cyanea events:\n${(EVENTS_VALIDATOR.errors as DefinedError[])
      .map(x => `  ${x.schemaPath}: ${x.message}`)
      .join("\n")}`
  }
}

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
