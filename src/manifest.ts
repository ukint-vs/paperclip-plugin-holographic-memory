import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-holographic-memory",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Holographic Memory",
  author: "Vadim Smirnov <ukint-vs@proton.me>",
  description:
    "Recall from an isolated Paperclip holographic SQLite memory store. Hybrid FTS5 + Jaccard + HRR retrieval with entity linking and category banks; recalls before each run and exposes an agent tool for targeted lookups.",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issue.comments.read",
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      dbPath: {
        type: "string",
        title: "Memory database path",
        description:
          "SQLite file used by this plugin. Defaults to a Paperclip-isolated path so it does not touch ~/.hermes/memory_store.db.",
        default: "~/.paperclip/instances/default/hermes-memory.db",
      },
      recallEnabled: {
        type: "boolean",
        title: "Enable recall",
        description:
          "When on, recall fires on agent.run.started and read actions of the agent tool are allowed.",
        default: true,
      },
      retainEnabled: {
        type: "boolean",
        title: "Enable retain (write actions)",
        description:
          "When on, the agent can call add/update/remove on the memory store. Off by default — facts are seeded or imported externally.",
        default: false,
      },
      minTrustScore: {
        type: "number",
        title: "Minimum trust score",
        description: "Facts below this score are excluded from recall results.",
        default: 0.3,
        minimum: 0,
        maximum: 1,
      },
      maxFactsPerRecall: {
        type: "number",
        title: "Maximum facts per recall",
        default: 10,
        minimum: 1,
        maximum: 50,
      },
    },
  },
  tools: [
    {
      name: "holographic_memory_search",
      displayName: "Holographic Memory",
      description:
        "Search and manage an isolated Paperclip holographic memory store. Use this before a task to surface past decisions, entities, and facts; use write actions (gated by retainEnabled) to record durable knowledge.",
      parametersSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "search",
              "probe",
              "related",
              "reason",
              "list",
              "feedback",
              "recall_context",
              "add",
              "update",
              "remove",
            ],
            default: "search",
            description:
              "search/probe/related/reason/list/feedback/recall_context are read; add/update/remove require retainEnabled=true.",
          },
          query: { type: "string", description: "Free-text query for search/recall_context fallback." },
          entity: { type: "string", description: "Entity for probe/related." },
          entities: {
            type: "array",
            items: { type: "string" },
            description: "Entity set for reason action.",
          },
          limit: { type: "number", default: 5, minimum: 1, maximum: 50 },
          min_trust: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Minimum trust score for this call; overrides the plugin's minTrustScore default.",
          },
          run_id: { type: "string" },
          issue_id: { type: "string" },
          agent_id: { type: "string" },
          fact_id: { type: "number" },
          helpful: { type: "boolean" },
          content: { type: "string" },
          category: { type: "string" },
          tags: {
            description: "Either a single tag string or an array of tag strings.",
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
          trust_score: { type: "number", minimum: 0, maximum: 1 },
          trust_delta: { type: "number", minimum: -1, maximum: 1 },
        },
      },
    },
  ],
};

export default manifest;
