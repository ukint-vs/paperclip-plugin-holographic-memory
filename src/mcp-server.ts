#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_DB_PATH, expandHome } from "./config.js";
import { closeStores, dispatchStandaloneAction, type ToolParams } from "./dispatch.js";
import {
  HOLO_MEMORY_TOOL_DESCRIPTION,
  HoloMemorySearchSchema,
} from "./tool-schema.js";
import type { HolographicMemoryConfig } from "./types.js";

// Standalone MCP stdio server bridging holographic_memory_search to claude_local
// and codex_local agents. Spawned per claude/codex session via the user's
// MCP config (~/.claude/settings.json mcpServers, ~/.codex/config.toml
// [mcp_servers.holographic-memory]). Reads the same SQLite DB as the
// Paperclip worker and the same on-disk recall cache. See README "Using with
// claude_local and codex_local" for setup; see issue #20 for why this exists.

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function envNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function resolveStandaloneConfig(env: NodeJS.ProcessEnv = process.env): HolographicMemoryConfig {
  // MCP-mode defaults: RECALL=true and RETAIN=true. The user explicitly
  // wired this server into their CLI config, so they want both reads and
  // writes on. The Paperclip plugin defaults RETAIN=false because in-app
  // recall does not require it; here it does.
  const dbPath = env.PAPERCLIP_HOLO_MEMORY_DB?.trim() || DEFAULT_DB_PATH;
  return {
    dbPath: expandHome(dbPath),
    recallEnabled: envBool(env.PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED, true),
    retainEnabled: envBool(env.PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED, true),
    minTrustScore: envNumber(env.PAPERCLIP_HOLO_MEMORY_MIN_TRUST, 0.3, 0, 1),
    maxFactsPerRecall: Math.floor(
      envNumber(env.PAPERCLIP_HOLO_MEMORY_MAX_RECALL, 10, 1, 50),
    ),
  };
}

export function createServer(config: HolographicMemoryConfig = resolveStandaloneConfig()): McpServer {
  const server = new McpServer({
    name: "holographic-memory",
    version: "0.1.0",
  });

  server.registerTool(
    "holographic_memory_search",
    {
      title: "Holographic Memory",
      description: HOLO_MEMORY_TOOL_DESCRIPTION,
      inputSchema: HoloMemorySearchSchema.shape,
    },
    async (rawParams) => {
      const params = (rawParams ?? {}) as ToolParams;
      const result = await dispatchStandaloneAction(params, config);
      // Map our DispatchToolResult to the MCP CallToolResult shape: content
      // is an array of typed parts. We pack the formatted text plus, when
      // structured data is present, a JSON-serialized text block so agents
      // that prefer parsed payloads (e.g. for action='list') can recover them.
      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: result.content },
      ];
      if (result.data !== undefined) {
        content.push({
          type: "text",
          text: `\n[data]\n${JSON.stringify(result.data)}`,
        });
      }
      return {
        content,
        isError: Boolean(result.error),
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // Best-effort cleanup on signals AND when the host disconnects stdio.
  // better-sqlite3 also auto-closes on process exit, but explicit closure
  // prevents stale .db-wal files from abrupt SIGKILL recovery cycles.
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    closeStores();
    // Allow any final stdio flush before exit.
    setImmediate(() => process.exit(code));
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  transport.onclose = () => shutdown(0);

  await server.connect(transport);
}

// Run main() only when invoked as the entry script, not when imported in
// tests. The shebang above makes this directly executable via `npx ...`.
const invokedAsScript = (() => {
  if (typeof process === "undefined") return false;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // tsx and node both populate argv[1] with the resolved path of the script;
  // in production this is dist/mcp-server.js. We compare against import.meta.url
  // when available for ESM-aware detection.
  try {
    const url = new URL(import.meta.url);
    return url.pathname === argv1 || url.pathname.endsWith("/mcp-server.js");
  } catch {
    return /mcp-server\.(js|ts)$/.test(argv1);
  }
})();

if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`[holographic-memory] MCP server failed to start: ${(error as Error).message}\n`);
    closeStores();
    process.exit(1);
  });
}
