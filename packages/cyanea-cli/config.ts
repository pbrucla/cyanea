import { JSONSchemaType } from "ajv"

export interface CyaneaConfigV1 {
  version: 1
  filestore: Record<string, Record<string, any>>
  source: Record<string, Record<string, any>>
  sinks: Record<string, Record<string, any>>
}

export const CONFIG_V1_SCHEMA: JSONSchemaType<CyaneaConfigV1> = {
  type: "object",
  description: "Cyanea config format.",
  definitions: {
    plugins: {
      type: "object",
      patternProperties: {
        ["^.*$"]: {
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
      description: "Cyanea config format version. This should be exactly 1.",
    },
    filestore: {
      $ref: "#/definitions/plugins",
      type: "object",
      maxProperties: 1,
      title: "Filestore plugin",
    },
    source: {
      $ref: "#/definitions/plugins",
      type: "object",
      maxProperties: 1,
      title: "Source-of-truth plugin",
    },
    sinks: {
      $ref: "#/definitions/plugins",
      title: "Sink plugins",
    },
  },
  required: ["version", "source", "filestore", "sinks"],
}

export type CyaneaConfig = CyaneaConfigV1
