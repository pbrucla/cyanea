import { CyaneaPlugin } from "@pbrucla/cyanea-core"

export default {
  filestore: {
    configSchema: {
      type: "object",
      required: [],
    },
    load: async () => ({
      writeFile: async () => {},
      commit: async () => {},
    }),
  },
} satisfies CyaneaPlugin<object, undefined, undefined>
