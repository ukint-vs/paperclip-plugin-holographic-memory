export default {
  name: "paperclip-plugin-holographic-memory",
  displayName: "Holographic Memory",
  description: "Recall from an isolated Paperclip holographic SQLite memory store.",
  version: "0.1.0",
  capabilities: {
    events: {
      subscribe: ["agent.run.started"]
    },
    issues: {
      read: true
    },
    tools: {
      register: true
    },
    state: {
      read: true,
      write: true
    },
    settings: {
      register: true
    }
  },
  configSchema: {
    type: "object",
    properties: {
      dbPath: {
        type: "string",
        title: "Memory database path",
        default: "~/.paperclip/instances/default/hermes-memory.db"
      },
      recallEnabled: {
        type: "boolean",
        title: "Enable recall",
        default: true
      },
      retainEnabled: {
        type: "boolean",
        title: "Enable retain",
        default: false
      },
      minTrustScore: {
        type: "number",
        title: "Minimum trust score",
        default: 0.3,
        minimum: 0,
        maximum: 1
      },
      maxFactsPerRecall: {
        type: "number",
        title: "Maximum facts per recall",
        default: 10,
        minimum: 1,
        maximum: 50
      }
    }
  }
};
