import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { ScopeKey, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { extractFactsFromText } from "./auto-extract.js";
import { formatFactsAsText, formatFactsForPrompt } from "./context-injector.js";
import { resolvePluginConfig } from "./config.js";
import {
  gcStaleCache,
  readRecallCache,
  writeRecallCache,
  type RecallCacheScope,
} from "./recall-cache.js";
import { HOLO_MEMORY_TOOL_DESCRIPTION, toJsonSchema } from "./tool-schema.js";
import {
  READ_ACTIONS,
  WRITE_ACTIONS,
  closeStores,
  err,
  getStore,
  handleAdd,
  handleFeedback,
  handleList,
  handleProbe,
  handleRelated,
  handleReason,
  handleRemove,
  handleSearch,
  handleUpdate,
  type CoreActionHandler,
  type ToolParams
} from "./dispatch.js";
import type { MemoryStore } from "./memory-store.js";
import type { AgentRunEvent, HolographicMemoryConfig, RecallState } from "./types.js";

const STATE_NAMESPACE = "recall";
const STATE_KEY = "context";

// Auto-extract trust ladder. Trust answers "how confident are we?" — it is
// NOT a visibility switch. Visibility belongs to the `source` column.
//
//   0.5+   curated / explicit / higher-confidence facts
//   0.3    auto-extracted, acceptable but weak  ← this PR
//   <0.3   normally hidden unless minTrust is lowered
//
// At 0.3, auto-facts pass the default `minTrustScore` filter (also 0.3,
// inclusive `>=`) and surface in default recall, ranked below curated
// 0.5+ facts in the score blend. If we ever want to hide auto-facts from
// default recall, the right knob is `source = 'auto'` (e.g. an
// `excludeAutoFacts` option on the recall query) — NOT pushing trust
// below the floor, which would falsely claim the facts are below the
// system's quality bar.
const AUTO_EXTRACT_TRUST = 0.3;
const AUTO_EXTRACT_SOURCE = "auto";

// joinIssueText is shared by handleRunStarted (recall query) and
// handleRunFinished (auto-extract source text). storeRegistry / getStore /
// closeStores live in dispatch.ts so the standalone MCP server reuses them.
function joinIssueText(issue: any): string {
  return [issue?.title, issue?.description, issue?.body]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
}

const plugin = definePlugin({
  async setup(ctx: any) {
    const config = resolvePluginConfig(await readConfig(ctx));

    registerSettings(ctx, config);
    registerSearchTool(ctx, config);

    // Recall is wired only via in-process Paperclip RPC here. To make the
    // tool reachable from claude_local / codex_local subprocesses (which
    // don't see ctx.tools.register), we ship a separate stdio MCP server in
    // src/mcp-server.ts plus a setup script that registers it in the user's
    // Claude/Codex MCP config. Do NOT auto-write per-run MCP config from
    // this worker — Paperclip's claude-local seed dir is content-hashed
    // (see paperclip claude-config.ts:40-50) and a per-run write would
    // invalidate the seed cache and race concurrent agents. See issue #20.
    ctx.events?.on?.("agent.run.started", async (event: any) => {
      const payload = extractRunFields(event);
      await handleRunStarted(ctx, payload, config);
    });

    // Auto-extract durable facts from the issue body + contemporaneous
    // human comments after each completed run (#11). Skipped on
    // `agent.run.failed` — failed runs produce noisy/misleading content,
    // matches Hermes' on_session_end posture.
    ctx.events?.on?.("agent.run.finished", async (event: any) => {
      const payload = extractRunFields(event);
      await handleRunFinished(ctx, payload, config);
    });
  },
  async onShutdown() {
    closeStores();
  }
});

export default plugin;
runWorker(plugin, import.meta.url);

export function extractRunFields(event: any): AgentRunEvent {
  // PluginEvent ships IDs at the top level and a typed payload underneath;
  // duck-type both spots so flat test fixtures also work.
  const payload = event?.payload ?? event ?? {};
  const fields: AgentRunEvent = {};
  const runId = event?.entityId ?? event?.runId ?? payload.runId;
  const agentId = event?.actorId ?? event?.agentId ?? payload.agentId;
  const issueId = event?.issueId ?? payload.issueId;
  const companyId = event?.companyId ?? payload.companyId;
  const startedAt = event?.startedAt ?? payload.startedAt;
  const finishedAt = event?.finishedAt ?? payload.finishedAt;
  if (typeof runId === "string" && runId) fields.runId = runId;
  if (typeof agentId === "string" && agentId) fields.agentId = agentId;
  if (typeof issueId === "string" && issueId) fields.issueId = issueId;
  if (typeof companyId === "string" && companyId) fields.companyId = companyId;
  if (typeof startedAt === "string" && startedAt) fields.startedAt = startedAt;
  if (typeof finishedAt === "string" && finishedAt) fields.finishedAt = finishedAt;
  return fields;
}

export async function handleRunStarted(
  ctx: any,
  event: AgentRunEvent,
  config: HolographicMemoryConfig
): Promise<RecallState | undefined> {
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  const eventIds = {
    runId: event.runId,
    issueId: event.issueId,
    agentId: event.agentId,
    companyId: event.companyId
  };
  const skip = (reason: string): undefined => {
    ctx.logger?.info?.("recall: skipped", { reason, ...eventIds, elapsedMs: elapsed() });
    return undefined;
  };

  if (!config.recallEnabled) return skip("disabled");
  if (!event.issueId) return skip("missing_issue_id");

  // companyId is on the PluginEvent envelope (PLUGIN_SPEC §16) and required
  // by issues.get; passing undefined makes the SDK return null and silently
  // disables automated recall. Fall back to ctx.companyId only for tests.
  const companyId = event.companyId ?? (ctx as any).companyId;

  let issue: unknown;
  try {
    issue = await ctx.issues?.get?.(event.issueId, companyId);
  } catch (error) {
    ctx.logger?.error?.("recall: issue fetch failed", {
      ...eventIds,
      elapsedMs: elapsed(),
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
  const query = joinIssueText(issue);

  if (!query.trim()) return skip("empty_issue");

  const store = getStore(config);
  let facts;
  try {
    facts = store.search(query, {
      limit: config.maxFactsPerRecall,
      minTrust: config.minTrustScore,
      halfLifeDays: config.trustHalfLifeDays,
      ...(companyId ? { companyId } : {})
    });
  } catch (error) {
    ctx.logger?.error?.("recall: search failed", {
      ...eventIds,
      elapsedMs: elapsed(),
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }

  if (!facts.length) return skip("no_facts");

  const round3 = (n: number): number => Math.round(n * 1000) / 1000;
  let sumScore = 0;
  let maxScoreRaw = 0;
  let sumTrust = 0;
  for (const fact of facts) {
    const score = fact.score ?? 0;
    sumScore += score;
    if (score > maxScoreRaw) maxScoreRaw = score;
    sumTrust += fact.trustScore;
  }
  const avgScore = round3(sumScore / facts.length);
  const maxScore = round3(maxScoreRaw);
  const avgTrust = round3(sumTrust / facts.length);

  const state: RecallState = {
    query,
    facts,
    formatted: formatFactsForPrompt(facts),
    createdAt: new Date().toISOString()
  };

  if (event.issueId) state.issueId = event.issueId;
  if (event.runId) state.runId = event.runId;

  // Write the same recall payload under every available scope so any of
  // run/issue/agent (whichever the agent later asks about) resolves.
  // allSettled (not all): one rejected scope must not silently drop
  // recall state for the other two — partial success is still useful.
  const scopeTargets: Array<{ kind: "run" | "issue" | "agent"; scope: ScopeKey }> = [];
  if (event.runId) scopeTargets.push({ kind: "run", scope: scopeFor("run", event.runId) });
  if (event.issueId) scopeTargets.push({ kind: "issue", scope: scopeFor("issue", event.issueId) });
  if (event.agentId) scopeTargets.push({ kind: "agent", scope: scopeFor("agent", event.agentId) });

  const settled = await Promise.allSettled(
    scopeTargets.map((t) => writeScopeState(ctx, t.scope, state))
  );
  const scopesWritten: string[] = [];
  const scopesFailed: string[] = [];
  settled.forEach((result, i) => {
    const target = scopeTargets[i];
    if (!target) return;
    if (result.status === "fulfilled") {
      scopesWritten.push(target.kind);
    } else {
      scopesFailed.push(target.kind);
    }
  });

  if (scopeTargets.length > 0 && scopesWritten.length === 0) {
    ctx.logger?.error?.("recall: all scope writes failed", {
      ...eventIds,
      elapsedMs: elapsed(),
      scopesFailed,
      facts: facts.length
    });
    return undefined;
  }
  if (scopesFailed.length > 0) {
    ctx.logger?.warn?.("recall: partial scope write failure", {
      ...eventIds,
      elapsedMs: elapsed(),
      scopesWritten,
      scopesFailed
    });
  }

  ctx.logger?.info?.("recall: fired", {
    facts: facts.length,
    avgScore,
    maxScore,
    avgTrust,
    minTrust: config.minTrustScore,
    limit: config.maxFactsPerRecall,
    scopesWritten,
    scopesFailed,
    ...eventIds,
    elapsedMs: elapsed()
  });

  // Mirror to the on-disk recall cache so the standalone MCP server (claude_local
  // / codex_local subprocesses) can resolve recall_context across processes.
  // Best-effort: write failures are logged, never thrown — agent runs must
  // not break because the cache is unhappy. GC stale entries in the same pass.
  const log = (m: string) => ctx.log?.warn?.(m) ?? ctx.logger?.warn?.(m) ?? undefined;
  // exactOptionalPropertyTypes requires we omit undefined properties rather
  // than assigning `undefined` to optional fields.
  const ids: { runId?: string; issueId?: string; agentId?: string } = {};
  if (event.runId) ids.runId = event.runId;
  if (event.issueId) ids.issueId = event.issueId;
  if (event.agentId) ids.agentId = event.agentId;
  // Fire-and-forget: cache write + GC are best-effort side effects for the
  // out-of-process MCP server. Awaiting them blocks agent.run.started on
  // ~3 readdirs + N stats with no benefit to the in-process recall path
  // (ctx.state above is the authoritative read inside Paperclip). Failures
  // are logged via writeRecallCache/gcStaleCache's own try/catch handlers.
  // The Promise.resolve().then() wrapper catches synchronous throws (e.g.
  // a future schema change makes RecallState non-serializable, JSON.stringify
  // throws inside writeRecallCache before any Promise is returned). Without
  // it, `.catch()` would never see the error because it'd surface as a sync
  // throw on the worker's call stack, killing agent.run.started silently.
  void Promise.resolve()
    .then(() => writeRecallCache(config.dbPath, state, ids, log))
    .catch((error: unknown) =>
      log(`[holographic-memory] writeRecallCache rejected: ${(error as Error).message}`),
    );
  void Promise.resolve()
    .then(() => gcStaleCache(config.dbPath, undefined, undefined, log))
    .catch((error: unknown) =>
      log(`[holographic-memory] gcStaleCache rejected: ${(error as Error).message}`),
    );

  return state;
}

export async function handleRunFinished(
  ctx: any,
  event: AgentRunEvent,
  config: HolographicMemoryConfig
): Promise<{ inserted: number } | undefined> {
  if (!config.retainEnabled) {
    return undefined;
  }
  if (!event.issueId) {
    return undefined;
  }
  const runLabel = event.runId ?? "<unknown>";

  if (!event.startedAt || !event.finishedAt) {
    // Fail closed: without honest timestamps we cannot attribute facts
    // to this run, so we'd rather skip than write a misleading run_id.
    ctx.logger?.warn?.(
      `auto-extract: run ${runLabel} missing startedAt/finishedAt, skipping`
    );
    return undefined;
  }

  const issueId = event.issueId;
  const runId = event.runId ?? null;
  const agentId = event.agentId ?? null;
  const companyId = event.companyId ?? (ctx as any).companyId;
  const startedAtMs = Date.parse(event.startedAt);
  const finishedAtMs = Date.parse(event.finishedAt);

  if (Number.isNaN(startedAtMs) || Number.isNaN(finishedAtMs)) {
    ctx.logger?.warn?.(
      `auto-extract: run ${runLabel} has unparseable startedAt/finishedAt, skipping`
    );
    return undefined;
  }

  try {
    // issues.get and listComments are independent — fetch in parallel
    // so the handler pays max(get, listComments) rather than sum.
    const [issue, rawComments] = await Promise.all([
      ctx.issues?.get?.(issueId, companyId),
      ctx.issues?.listComments?.(issueId, companyId)
    ]);
    const bodyText = joinIssueText(issue);

    const filteredComments = (rawComments ?? []).filter((comment: any) => {
      // Humans only — agent comments saying "I prefer X" are self-talk,
      // not user preferences. authorUserId presence is the canonical
      // "human authored" signal in the SDK shape.
      if (!comment?.authorUserId) return false;
      // Contemporaneous comments only, so run_id provenance stays
      // honest. createdAt is Date or ISO string depending on host.
      const createdAtMs =
        comment.createdAt instanceof Date
          ? comment.createdAt.getTime()
          : Date.parse(String(comment.createdAt ?? ""));
      if (Number.isNaN(createdAtMs)) return false;
      return createdAtMs >= startedAtMs && createdAtMs <= finishedAtMs;
    });

    const sources: string[] = [];
    if (bodyText.trim().length > 0) sources.push(bodyText);
    for (const comment of filteredComments) {
      if (typeof comment?.body === "string" && comment.body.trim().length > 0) {
        sources.push(comment.body);
      }
    }

    const store = getStore(config);
    let insertedCount = 0;

    for (const text of sources) {
      const hits = extractFactsFromText(text);
      for (const hit of hits) {
        try {
          // exactOptionalPropertyTypes forbids `field: undefined` on
          // optional props; build incrementally and skip absent fields.
          const fact: Parameters<MemoryStore["addFact"]>[0] = {
            content: hit.content,
            category: hit.category,
            trustScore: AUTO_EXTRACT_TRUST,
            source: AUTO_EXTRACT_SOURCE
          };
          if (agentId) fact.agentId = agentId;
          if (runId) fact.runId = runId;
          if (companyId) fact.companyId = companyId;
          const result = store.addFact(fact);
          if (result.inserted) insertedCount += 1;
        } catch (err) {
          // One bad insertion (SQLite lock race, constraint violation)
          // must not abort peers in the same run.
          ctx.logger?.warn?.(
            `auto-extract: addFact failed in run ${runLabel}`,
            err
          );
        }
      }
    }

    ctx.logger?.info?.(
      `auto-extract: issue ${issueId} run ${runLabel} → inserted ${insertedCount} facts`
    );
    return { inserted: insertedCount };
  } catch (err) {
    // Network blips on issues.get / listComments must not throw out of
    // an SDK event handler.
    ctx.logger?.error?.(
      `auto-extract: failed for run ${runLabel}`,
      err
    );
    return undefined;
  }
}

function scopeFor(scopeKind: "run" | "issue" | "agent", scopeId: string): ScopeKey {
  return { scopeKind, scopeId, namespace: STATE_NAMESPACE, stateKey: STATE_KEY } as ScopeKey;
}

async function writeScopeState(ctx: any, scope: ScopeKey, value: unknown): Promise<void> {
  if (ctx.state?.set) {
    await ctx.state.set(scope, value);
  } else if (ctx.plugin?.state?.set) {
    await ctx.plugin.state.set(scope, value);
  }
}

async function readScopeState(ctx: any, scope: ScopeKey): Promise<RecallState | undefined> {
  let value: unknown;
  if (ctx.state?.get) {
    value = await ctx.state.get(scope);
  } else if (ctx.plugin?.state?.get) {
    value = await ctx.plugin.state.get(scope);
  }
  return (value ?? undefined) as RecallState | undefined;
}

// ---------------------------------------------------------------------------
// recall_context — only ctx-aware handler; lives here because it reads
// plugin state populated on agent.run.started. Other handlers are in
// dispatch.ts so the standalone MCP server can reuse them.
// ---------------------------------------------------------------------------

type CtxActionHandler = (
  store: MemoryStore,
  params: ToolParams,
  config: HolographicMemoryConfig,
  ctx: any,
  runCtx: ToolRunContext
) => Promise<ToolResult>;

async function handleRecallContext(
  store: MemoryStore,
  params: ToolParams,
  config: HolographicMemoryConfig,
  ctx: any,
  runCtx: ToolRunContext
): Promise<ToolResult> {
  // Lookup order: explicit run_id → issue_id → agent_id → runCtx.runId
  // (the SDK gives us this on every tool call) → live search.
  const candidates: Array<ScopeKey | undefined> = [
    params.run_id ? scopeFor("run", params.run_id) : undefined,
    params.issue_id ? scopeFor("issue", params.issue_id) : undefined,
    params.agent_id ? scopeFor("agent", params.agent_id) : undefined,
    runCtx?.runId ? scopeFor("run", runCtx.runId) : undefined,
    runCtx?.agentId ? scopeFor("agent", runCtx.agentId) : undefined
  ];

  for (const scope of candidates) {
    if (!scope) continue;
    const cached = await readScopeState(ctx, scope);
    if (cached?.formatted) {
      return { content: cached.formatted, data: cached };
    }
  }

  // Fall back to the on-disk recall cache. In-Paperclip we usually hit
  // ctx.state above; this branch covers the case where ctx.state was never
  // populated (e.g. plugin restart between agent.run.started and the tool
  // call) and serves the same source of truth the standalone MCP server reads.
  const fileLookups: Array<[RecallCacheScope, string]> = [];
  if (params.run_id) fileLookups.push(["run", params.run_id]);
  if (params.issue_id) fileLookups.push(["issue", params.issue_id]);
  if (params.agent_id) fileLookups.push(["agent", params.agent_id]);
  if (runCtx?.runId) fileLookups.push(["run", runCtx.runId]);
  if (runCtx?.agentId) fileLookups.push(["agent", runCtx.agentId]);
  for (const [scope, scopeId] of fileLookups) {
    const cached = await readRecallCache(config.dbPath, scope, scopeId);
    if (cached?.formatted) {
      return { content: cached.formatted, data: cached };
    }
  }

  if (params.query?.trim()) {
    // recall_context's live-search fallback uses maxFactsPerRecall (not the
    // dispatch read-handler default of 5) so the cached-vs-search split
    // behaves consistently. companyId scoping mirrors the dispatch path.
    // halfLifeDays threaded through so decay applies on this code path too;
    // without it, the live fallback would silently use raw trust ranking
    // while the cached path reflects whatever decay was applied at write.
    const opts: { limit: number; minTrust: number; halfLifeDays: number; companyId?: string } = {
      limit: params.limit ?? config.maxFactsPerRecall,
      minTrust: params.min_trust ?? config.minTrustScore,
      halfLifeDays: config.trustHalfLifeDays
    };
    if (runCtx?.companyId) opts.companyId = runCtx.companyId;
    const facts = store.search(params.query, opts);
    return { content: formatFactsAsText(facts) };
  }

  return {
    content:
      "No cached recall context for this run. Pass run_id, issue_id, agent_id, or query to search the memory store directly."
  };
}

// Adapter that bridges a CoreActionHandler (which returns a DispatchToolResult)
// into the ctx-aware ActionHandler shape expected by the worker dispatch.
// Forwards `runCtx` so cross-tenant scoping (companyId) reaches the core
// handlers — the standalone MCP server passes runCtx: undefined.
function adaptCore(handler: CoreActionHandler): CtxActionHandler {
  return async (store, params, config, _ctx, runCtx) => {
    const result = await handler(store, params, config, runCtx);
    // DispatchToolResult and ToolResult are structurally identical for our
    // purposes (content + optional data + optional error). The cast keeps
    // the SDK type contract without re-allocating.
    return result as ToolResult;
  };
}

export const ACTION_HANDLERS: Record<string, CtxActionHandler> = {
  search: adaptCore(handleSearch),
  probe: adaptCore(handleProbe),
  related: adaptCore(handleRelated),
  reason: adaptCore(handleReason),
  recall_context: handleRecallContext,
  list: adaptCore(handleList),
  feedback: adaptCore(handleFeedback),
  add: adaptCore(handleAdd),
  update: adaptCore(handleUpdate),
  remove: adaptCore(handleRemove)
};

export async function dispatchAction(
  params: ToolParams,
  config: HolographicMemoryConfig,
  ctx: any,
  runCtx: ToolRunContext
): Promise<ToolResult> {
  const action = params.action ?? "search";
  const handler = ACTION_HANDLERS[action];
  if (!handler) return err(`Unknown memory action: ${action}`) as ToolResult;

  if (READ_ACTIONS.has(action) && !config.recallEnabled) {
    return { content: "Holographic memory recall is disabled." };
  }
  if (WRITE_ACTIONS.has(action) && !config.retainEnabled) {
    // D10 / Codex C4: write loop honors retainEnabled, not recallEnabled.
    return { content: "Memory retain is disabled. Set retainEnabled=true in plugin config." };
  }

  const store = getStore(config);
  return handler(store, params, config, ctx, runCtx);
}

function registerSearchTool(ctx: any, config: HolographicMemoryConfig): void {
  const declaration = {
    displayName: "Holographic Memory",
    description: HOLO_MEMORY_TOOL_DESCRIPTION,
    // Derived from the same zod source the manifest and the standalone MCP
    // server use, so all three entry points see identical parameter shapes.
    parametersSchema: toJsonSchema(),
  };

  const handler = async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
    return dispatchAction((params as ToolParams) ?? {}, config, ctx, runCtx);
  };

  if (ctx.tools?.register) {
    ctx.tools.register("holographic_memory_search", declaration, handler);
  } else if (ctx.agent?.tools?.register) {
    ctx.agent.tools.register("holographic_memory_search", declaration, handler);
  }
}

// Re-export the tool description constant under the legacy function name so
// existing test imports keep working. The description body lives in
// src/tool-schema.ts as the single source of truth.
export function buildToolDescription(): string {
  return HOLO_MEMORY_TOOL_DESCRIPTION;
}

function registerSettings(ctx: any, config: HolographicMemoryConfig): void {
  ctx.settings?.register?.({
    title: "Holographic Memory",
    fields: [
      { key: "dbPath", type: "string", label: "Memory database path", default: config.dbPath },
      { key: "recallEnabled", type: "boolean", label: "Enable recall (read)", default: config.recallEnabled },
      { key: "retainEnabled", type: "boolean", label: "Enable retain (write)", default: config.retainEnabled },
      { key: "minTrustScore", type: "number", label: "Minimum trust score", default: config.minTrustScore },
      {
        key: "maxFactsPerRecall",
        type: "number",
        label: "Maximum facts per recall",
        default: config.maxFactsPerRecall
      }
    ]
  });
}

async function readConfig(ctx: any): Promise<Partial<HolographicMemoryConfig>> {
  // The SDK exposes config via ctx.config.get() (async). The previous
  // duck-typed shape (ctx.config as object, ctx.settings.values) is kept
  // as a fallback so existing tests keep working.
  if (typeof ctx.config?.get === "function") {
    return ((await ctx.config.get()) ?? {}) as Partial<HolographicMemoryConfig>;
  }
  return (ctx.config ?? ctx.settings?.values ?? {}) as Partial<HolographicMemoryConfig>;
}
