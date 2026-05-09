import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaperclipPluginManifestV1, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { toJsonSchema } from "./tool-schema.js";

// Read version from package.json at module init so the manifest's `version`
// field (advertised to Paperclip's plugin loader and surfaced in Settings UI)
// tracks package.json without manual sync. Same approach as
// `src/mcp-server.ts` PACKAGE_VERSION; pre-0.4.0 this was hardcoded `"0.1.0"`
// and stayed there across releases. Resolves both in src/ (../package.json)
// and dist/ (sibling to dist/, also ../package.json).
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    // Sandboxed contexts where package.json isn't readable — never expected
    // in the dist-loaded path, but keeps the manifest constructable rather
    // than throwing at import time.
    return "0.0.0";
  }
}

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-holographic-memory",
  apiVersion: 1,
  version: readPackageVersion(),
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
      trustHalfLifeDays: {
        type: "number",
        title: "Trust half-life (days)",
        description:
          "Days for trust to decay to 50%. Set to 0 (default) to disable decay. Applies to scored read paths (search, related).",
        default: 0,
        minimum: 0,
        maximum: 3650,
      },
    },
  },
  tools: [
    {
      name: "holographic_memory_search",
      displayName: "Holographic Memory",
      description:
        "Search and manage an isolated Paperclip holographic memory store. Use this before a task to surface past decisions, entities, and facts; use write actions (gated by retainEnabled) to record durable knowledge.",
      // Derived from src/tool-schema.ts so worker / manifest / MCP server can
      // never disagree on the parameter shape.
      parametersSchema: toJsonSchema() as PluginToolDeclaration["parametersSchema"],
    },
  ],
};

export default manifest;
