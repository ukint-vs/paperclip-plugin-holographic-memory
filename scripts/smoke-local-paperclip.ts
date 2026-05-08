/**
 * E2E smoke for the holographic memory plugin against a real Paperclip host.
 *
 * Prereqs:
 *   - Paperclip server running on http://127.0.0.1:3100 in `local_trusted` mode
 *     (auth bypass on every request — see paperclip server/src/middleware/auth.ts).
 *   - Embedded Postgres reachable at postgres://paperclip:paperclip@127.0.0.1:54329/paperclip
 *     (Paperclip's default when no DATABASE_URL is set — see paperclip
 *     packages/db/src/migration-runtime.ts).
 *   - This plugin built (`pnpm build`).
 *
 * Bring-up command, copy-pasteable:
 *   PAPERCLIP_DEPLOYMENT_MODE=local_trusted SERVE_UI=false BETTER_AUTH_SECRET=smoke \
 *   PORT=3100 pnpm --filter @paperclipai/server dev
 *
 * What this script proves (closes issue #22):
 *   1. POST /api/plugins/install with isLocalPath:true loads our manifest+worker
 *      and lifts the plugin to "ready" with our tool registered.
 *   2. POST /api/plugins/tools/execute against `holographic_memory_search` actually
 *      reaches our worker handler, with a runContext that passes Paperclip's
 *      strict scope validation (agent/run/project all owned by the same company).
 *
 * Read actions exercised: list, recall_context, search.
 */
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const PAPERCLIP_BASE_URL = process.env.PAPERCLIP_BASE_URL ?? "http://127.0.0.1:3100";
// Embedded Postgres credentials are seeded by paperclip's migration-runtime.ts.
const POSTGRES_URL =
  process.env.PAPERCLIP_POSTGRES_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

const PLUGIN_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_KEY = "paperclip-plugin-holographic-memory";
const TOOL_NAMESPACED = `${PLUGIN_KEY}:holographic_memory_search`;

interface SeedIds {
  companyId: string;
  agentId: string;
  projectId: string;
  runId: string;
}

interface ToolExecutionResult {
  pluginId: string;
  toolName: string;
  result: { content?: unknown; error?: string };
}

function log(label: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`▸ ${label}`);
  } else {
    console.log(`▸ ${label}`, typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
  }
}

function bail(message: string, detail?: unknown): never {
  console.error(`✗ ${message}`);
  if (detail !== undefined) console.error(detail);
  process.exit(1);
}

async function waitForServer(url: string, timeoutMs = 60_000) {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/plugins`);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  bail(`Paperclip server not reachable at ${url} after ${timeoutMs}ms`, lastErr);
}

async function seedRunContext(): Promise<SeedIds> {
  const pg = new Client({ connectionString: POSTGRES_URL });
  await pg.connect();
  try {
    // Reuse smoke fixtures across runs so repeated executions are idempotent.
    // Stable name 'holo-memory-smoke' anchors lookup; everything else cascades.
    const SMOKE_NAME = "holo-memory-smoke";

    // companies.name is not unique — select-then-insert keeps the script idempotent.
    const existingCo = await pg.query<{ id: string }>(
      `SELECT id FROM companies WHERE name = $1 ORDER BY created_at LIMIT 1`,
      [SMOKE_NAME],
    );
    let companyId = existingCo.rows[0]?.id;
    if (!companyId) {
      const inserted = await pg.query<{ id: string }>(
        `INSERT INTO companies (name, description, status, budget_monthly_cents)
         VALUES ($1, 'holographic-memory plugin smoke fixture', 'active', 0)
         RETURNING id`,
        [SMOKE_NAME],
      );
      companyId = inserted.rows[0]!.id;
    }

    const agentRow = await pg.query<{ id: string }>(
      `SELECT id FROM agents WHERE company_id = $1 AND name = $2 LIMIT 1`,
      [companyId, SMOKE_NAME],
    );
    let agentId = agentRow.rows[0]?.id;
    if (!agentId) {
      const inserted = await pg.query<{ id: string }>(
        `INSERT INTO agents (company_id, name, role, title, status, adapter_type, adapter_config)
         VALUES ($1, $2, 'engineer', 'Smoke Agent', 'idle', 'process', '{"command":"true","args":[]}'::jsonb)
         RETURNING id`,
        [companyId, SMOKE_NAME],
      );
      agentId = inserted.rows[0]!.id;
    }

    const projectRow = await pg.query<{ id: string }>(
      `SELECT id FROM projects WHERE company_id = $1 AND name = $2 LIMIT 1`,
      [companyId, SMOKE_NAME],
    );
    let projectId = projectRow.rows[0]?.id;
    if (!projectId) {
      const inserted = await pg.query<{ id: string }>(
        `INSERT INTO projects (company_id, name, description, status)
         VALUES ($1, $2, 'plugin smoke fixture', 'in_progress')
         RETURNING id`,
        [companyId, SMOKE_NAME],
      );
      projectId = inserted.rows[0]!.id;
    }

    // Always create a fresh heartbeat run — id is the runContext.runId.
    const runInsert = await pg.query<{ id: string }>(
      `INSERT INTO heartbeat_runs (company_id, agent_id, invocation_source, status, started_at)
       VALUES ($1, $2, 'on_demand', 'running', now())
       RETURNING id`,
      [companyId, agentId],
    );
    const runId = runInsert.rows[0]!.id;

    return { companyId, agentId: agentId!, projectId: projectId!, runId };
  } finally {
    await pg.end();
  }
}

async function postJson<T>(pathname: string, body: unknown): Promise<{ status: number; data: T | { error?: string } }> {
  const res = await fetch(`${PAPERCLIP_BASE_URL}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data: data as T };
}

async function getJson<T>(pathname: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${PAPERCLIP_BASE_URL}${pathname}`);
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data: data as T };
}

async function ensurePluginInstalled(): Promise<string> {
  // Try install. If already installed, the loader returns 4xx — fall back to lookup.
  const { status, data } = await postJson<{ id?: string; pluginId?: string; error?: string }>(
    "/api/plugins/install",
    { packageName: PLUGIN_REPO_ROOT, isLocalPath: true },
  );

  if (status >= 200 && status < 300) {
    const id = (data as any).id ?? (data as any).pluginId;
    log("plugin installed", { id, key: PLUGIN_KEY });
    return id;
  }

  log(`/api/plugins/install returned ${status}, looking up by key`, data);
  const list = await getJson<Array<{ id: string; pluginKey?: string }>>("/api/plugins");
  const rows = Array.isArray(list.data)
    ? list.data
    : ((list.data as any)?.plugins as Array<{ id: string; pluginKey?: string }> | undefined) ?? [];
  const found = rows.find((p) => p.pluginKey === PLUGIN_KEY);
  if (!found) bail(`Install failed and plugin not found by key ${PLUGIN_KEY}`, { installResp: data, list: list.data });
  return found.id;
}

async function waitForPluginReady(pluginId: string, timeoutMs = 30_000) {
  const start = Date.now();
  let lastSnapshot: unknown = null;
  while (Date.now() - start < timeoutMs) {
    const { data } = await getJson<{ status?: string; lifecycleStatus?: string }>(
      `/api/plugins/${encodeURIComponent(pluginId)}`,
    );
    lastSnapshot = data;
    const status = (data as any).status ?? (data as any).lifecycleStatus;
    if (status === "ready") return;
    if (status === "error") bail("Plugin reached error state", data);
    await new Promise((r) => setTimeout(r, 300));
  }
  bail(`Plugin did not reach 'ready' within ${timeoutMs}ms`, lastSnapshot);
}

async function executeTool(
  action: string,
  parameters: Record<string, unknown>,
  runContext: SeedIds,
): Promise<ToolExecutionResult> {
  const { status, data } = await postJson<ToolExecutionResult & { error?: string }>(
    "/api/plugins/tools/execute",
    {
      tool: TOOL_NAMESPACED,
      parameters: { action, ...parameters },
      runContext,
    },
  );
  if (status !== 200) bail(`tool ${action} HTTP ${status}`, data);
  if ((data as any).error) bail(`tool ${action} returned error`, data);
  return data as ToolExecutionResult;
}

async function main() {
  log("Plugin repo", PLUGIN_REPO_ROOT);
  log("Paperclip base", PAPERCLIP_BASE_URL);
  log("Postgres", POSTGRES_URL);

  log("Waiting for Paperclip server...");
  await waitForServer(PAPERCLIP_BASE_URL);
  log("Server reachable");

  log("Seeding company / agent / project / heartbeat_run...");
  const ctx = await seedRunContext();
  log("runContext", ctx);

  log("Installing plugin...");
  const pluginId = await ensurePluginInstalled();

  log("Waiting for plugin → ready...");
  await waitForPluginReady(pluginId);
  log("Plugin ready");

  log("Executing list...");
  const listed = await executeTool("list", { limit: 3 }, ctx);
  log("list result", listed.result);

  log("Executing recall_context...");
  const recall = await executeTool("recall_context", { query: "smoke" }, ctx);
  log("recall_context result", recall.result);

  log("Executing search...");
  const searched = await executeTool("search", { query: "smoke", limit: 3 }, ctx);
  log("search result", searched.result);

  console.log("\n✓ Smoke green: install → tool registration → 3× round-trip via /api/plugins/tools/execute");
}

main().catch((err) => {
  console.error("✗ Smoke threw:", err);
  process.exit(1);
});
