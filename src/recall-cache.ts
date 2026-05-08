import fs from "node:fs/promises";
import path from "node:path";
import type { RecallState } from "./types.js";

// Cross-process recall pre-fetch cache.
//
// The Paperclip worker writes RecallState into ctx.state on agent.run.started,
// which is reachable from in-process Paperclip-RPC tool calls but invisible to
// claude_local / codex_local subprocesses. The MCP server (a separate process
// per claude/codex spawn) cannot read ctx.state. To bridge this, the worker
// also writes the same RecallState to a JSON file keyed on run/issue/agent
// scopes; the MCP server reads it on recall_context calls when the agent
// passes run_id/issue_id/agent_id.
//
// Layout:
//   <dirname(dbPath)>/recall-cache/run/<runId>.json
//   <dirname(dbPath)>/recall-cache/issue/<issueId>.json
//   <dirname(dbPath)>/recall-cache/agent/<agentId>.json
//
// One file per scope (not symlinks) so a single recall is reachable by any of
// the three keys without filesystem feature dependencies. Files are mode 0600
// to match the surrounding ~/.paperclip permissions; on a shared host you do
// NOT want another user reading another user's recall context.

export type RecallCacheScope = "run" | "issue" | "agent";

const SCOPE_DIRS: Record<RecallCacheScope, string> = {
  run: "run",
  issue: "issue",
  agent: "agent",
};

export const DEFAULT_RECALL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function recallCacheRoot(dbPath: string): string {
  return path.join(path.dirname(dbPath), "recall-cache");
}

function cachePath(dbPath: string, scope: RecallCacheScope, scopeId: string): string {
  // sanitize: strip path separators so a malformed runId can't escape the
  // cache directory. We don't expect adversarial input here, but defense in
  // depth is cheap.
  const safeId = scopeId.replace(/[\/\\\0]/g, "_");
  return path.join(recallCacheRoot(dbPath), SCOPE_DIRS[scope], `${safeId}.json`);
}

export interface RecallCacheIds {
  runId?: string;
  issueId?: string;
  agentId?: string;
}

// Best-effort write. Failures (disk full, permissions, race with concurrent
// gc) are caught and reported via the optional logger, never thrown — agent
// runs must not break because the cache is unhappy. The atomic-write pattern
// (tmp + rename) prevents partial reads.
export async function writeRecallCache(
  dbPath: string,
  state: RecallState,
  ids: RecallCacheIds,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  const payload = JSON.stringify(state);
  const writes: Array<[RecallCacheScope, string]> = [];
  if (ids.runId) writes.push(["run", ids.runId]);
  if (ids.issueId) writes.push(["issue", ids.issueId]);
  if (ids.agentId) writes.push(["agent", ids.agentId]);

  for (const [scope, scopeId] of writes) {
    const target = cachePath(dbPath, scope, scopeId);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const tmp = `${target}.tmp.${process.pid}`;
      await fs.writeFile(tmp, payload, { mode: 0o600 });
      await fs.rename(tmp, target);
    } catch (error) {
      log(`[holographic-memory] recall-cache write failed for ${scope}=${scopeId}: ${(error as Error).message}`);
    }
  }
}

// Best-effort read. Returns undefined on any miss (file missing, parse error,
// permissions). Never throws.
export async function readRecallCache(
  dbPath: string,
  scope: RecallCacheScope,
  scopeId: string,
): Promise<RecallState | undefined> {
  const target = cachePath(dbPath, scope, scopeId);
  try {
    const raw = await fs.readFile(target, "utf8");
    return JSON.parse(raw) as RecallState;
  } catch {
    return undefined;
  }
}

// Sweep stale cache files. Called from the worker on agent.run.started so the
// directory does not grow unbounded across long sessions; the MCP server does
// not run gc because it cannot tell which files are stale across all the runs
// it never observed. Failures are silent.
export async function gcStaleCache(
  dbPath: string,
  maxAgeMs: number = DEFAULT_RECALL_CACHE_TTL_MS,
  now: number = Date.now(),
  log: (message: string) => void = () => undefined,
): Promise<void> {
  const root = recallCacheRoot(dbPath);
  for (const scope of Object.keys(SCOPE_DIRS) as RecallCacheScope[]) {
    const dir = path.join(root, SCOPE_DIRS[scope]);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry);
      try {
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.unlink(file);
        }
      } catch (error) {
        log(`[holographic-memory] recall-cache gc failed for ${file}: ${(error as Error).message}`);
      }
    }
  }
}
