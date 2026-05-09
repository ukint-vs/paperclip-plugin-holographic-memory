#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_DB_PATH, expandHome } from "./config.js";
import { closeStores, dispatchStandaloneAction, type ToolParams } from "./dispatch.js";
import { isInvokedAsScript } from "./invoked-as-script.js";
import { readPackageVersion } from "./package-version.js";
import {
  HOLO_MEMORY_TOOL_DESCRIPTION,
  HoloMemorySearchSchema,
} from "./tool-schema.js";
import type { HolographicMemoryConfig } from "./types.js";

export const PACKAGE_VERSION = readPackageVersion();

// Standalone MCP stdio server bridging holographic_memory_search to claude_local
// and codex_local agents. Spawned per claude/codex session via the user's
// MCP config (~/.claude/settings.json mcpServers, ~/.codex/config.toml
// [mcp_servers.holographic-memory]). Reads the same SQLite DB as the
// Paperclip worker and the same on-disk recall cache. See README "Using with
// claude_local and codex_local" for setup; see issue #20 for why this exists.
//
// Cross-tenant posture (intentional today):
// MCP standalone mode is tenant-blind. It calls dispatchStandaloneAction
// without a runCtx, so cross-tenant scoping (CoreActionHandler's optional
// `runCtx.companyId`) defaults to undefined and reads see every company's
// facts on the configured dbPath. Fine for a single-company Paperclip
// instance; breaks isolation if a shared dbPath is used by multiple
// companies. Workaround until the fix lands: run a per-company MCP server
// with a per-company dbPath. Wiring companyId through the MCP tool schema
// and namespacing the recall-cache reads is tracked in issue #28.

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
    trustHalfLifeDays: envNumber(env.PAPERCLIP_HOLO_MEMORY_TRUST_HALF_LIFE_DAYS, 0, 0, 3650),
  };
}

export function createServer(config: HolographicMemoryConfig = resolveStandaloneConfig()): McpServer {
  const server = new McpServer({
    name: "holographic-memory",
    version: PACKAGE_VERSION,
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
      // Wrap in try/catch so handler-level exceptions (e.g. SQLITE errors
      // when a fact_id doesn't exist) come back as a structured tool error
      // the agent can branch on, instead of bubbling out as a JSON-RPC
      // server error which most MCP clients render as an opaque failure.
      try {
        const result = await dispatchStandaloneAction(params, config);
        // Map DispatchToolResult to the MCP CallToolResult shape: content is
        // an array of typed parts. We pack the formatted text plus, when
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
      } catch (error) {
        const message = (error as Error).message;
        return {
          content: [
            {
              type: "text",
              text: `holographic_memory_search error: ${message}`,
            },
          ],
          isError: true,
        };
      }
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
  //
  // Why this exit shape: the previous version called `setImmediate(process.exit)`
  // which schedules the exit one tick later but does NOT drain stdout. Under
  // SIGTERM during an in-flight tools/call response, that truncated the JSON-RPC
  // reply on slow pipes. Now we let the event loop drain naturally by setting
  // process.exitCode and not calling process.exit at all when there's pending
  // stdio; if the loop is already idle, Node exits anyway. Signals also unref
  // the SQLite handle via closeStores so the loop has nothing left to keep alive.
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    closeStores();
    process.exitCode = code;
    // Force an explicit flush + exit fallback: write a no-op then exit in the
    // callback. process.stdout.write's callback fires after the kernel
    // accepts the bytes, so any in-flight JSON-RPC reply has flushed by then.
    process.stdout.write("", () => process.exit(code));
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  transport.onclose = () => shutdown(0);

  await server.connect(transport);
}

// Run main() only when invoked as the entry script, not when imported in
// tests. The shebang above makes this directly executable via `npx ...`.
// Helper resolves symlinks so npm-bin invocations work correctly; see
// src/invoked-as-script.ts for the 0.4.0 regression this guards against.
if (isInvokedAsScript(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`[holographic-memory] MCP server failed to start: ${(error as Error).message}\n`);
    closeStores();
    process.exit(1);
  });
}
