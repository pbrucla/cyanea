import { CyaneaPlugin } from "@pbrucla/cyanea-core"

export default {
  source: {
    configSchema: {
      type: "object",
      required: [],
    },
    load: async () => ({ readEvents: async () => [] }),
  },
} satisfies CyaneaPlugin<undefined, object, undefined>
