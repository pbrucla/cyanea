import { JSONSchemaType } from "ajv"

export interface CyaneaConfigV1 {
  version: 1
  filestore: Record<string, Record<string, any>>
  source: Record<string, Record<string, any>>
  sinks: Record<string, Record<string, any>>
}

const PACKAGE_NAME_REGEX = "^(?:(?:@(?:[a-z0-9-*~][a-z0-9-*._~]*)?/[a-z0-9-._~])|[a-z0-9-~])[a-z0-9-._~]*$" as const

export const CONFIG_V1_SCHEMA: JSONSchemaType<CyaneaConfigV1> = {
  type: "object",
  definitions: {
    module: {
      type: "object",
      patternProperties: {
        [PACKAGE_NAME_REGEX]: {
          type: "object",
          required: [],
        },
      },
      additionalProperties: false,
      required: [],
    },
  },
  properties: {
    version: {
      type: "integer",
      const: 1,
    },
    filestore: {
      $ref: "#/definitions/module",
      type: "object",
      maxProperties: 1,
    },
    source: {
      $ref: "#/definitions/module",
      type: "object",
      maxProperties: 1,
    },
    sinks: {
      $ref: "#/definitions/module",
    },
  },
  required: ["version", "source", "filestore", "sinks"],
}

export type CyaneaConfig = CyaneaConfigV1
