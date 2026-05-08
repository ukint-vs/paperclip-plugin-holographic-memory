import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { ScopeKey, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { extractFactsFromText } from "./auto-extract.js";
import { formatFactsAsText, formatFactsForPrompt } from "./context-injector.js";
import { resolvePluginConfig } from "./config.js";
import { MemoryStore } from "./memory-store.js";
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

interface ToolParams {
  action?: string;
  // Read params
  query?: string;
  entity?: string;
  entities?: string[];
  category?: string;
  fact_id?: number;
  helpful?: boolean;
  limit?: number;
  min_trust?: number;
  // Recall params
  run_id?: string;
  issue_id?: string;
  agent_id?: string;
  // Write params
  content?: string;
  tags?: string | string[];
  trust_score?: number;
  trust_delta?: number;
}

// MemoryStore registry keyed by dbPath. The plugin is intentionally
// instance-scoped (one DB per Paperclip instance, per the README and
// Hermes parity), but keying by path lets onConfigChanged swap the
// path at runtime without leaking a stale connection. Closed in onShutdown.
const storeRegistry = new Map<string, MemoryStore>();

function getStore(config: HolographicMemoryConfig): MemoryStore {
  let store = storeRegistry.get(config.dbPath);
  if (!store) {
    store = new MemoryStore(config.dbPath);
    storeRegistry.set(config.dbPath, store);
  }
  return store;
}

function closeStores(): void {
  for (const store of storeRegistry.values()) {
    store.close();
  }
  storeRegistry.clear();
}

const plugin = definePlugin({
  async setup(ctx: any) {
    const config = resolvePluginConfig(await readConfig(ctx));

    registerSettings(ctx, config);
    registerSearchTool(ctx, config);

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
  // PluginEvent gives us companyId/actorId/entityId at the top level and a
  // typed payload underneath. Pull the IDs we care about from either spot,
  // tolerating the duck-typed test ctx that hands us a flat object.
  // Shared between agent.run.started and agent.run.finished — the
  // envelope-level fields are identical (decision 2A); finished
  // additionally carries startedAt/finishedAt on the payload, used by
  // handleRunFinished's time-window filter (D13).
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
  if (!config.recallEnabled || !event.issueId) {
    return undefined;
  }

  // companyId is on the PluginEvent envelope (PLUGIN_SPEC §16) and required
  // by issues.get; passing undefined makes the SDK return null and silently
  // disables automated recall. Fall back to ctx.companyId only for tests.
  const companyId = event.companyId ?? (ctx as any).companyId;
  const issue = await ctx.issues?.get?.(event.issueId, companyId);
  const query = [issue?.title, issue?.description, issue?.body]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");

  if (!query.trim()) {
    return undefined;
  }

  const store = getStore(config);
  const facts = store.search(query, {
    limit: config.maxFactsPerRecall,
    minTrust: config.minTrustScore
  });

  if (!facts.length) {
    return undefined;
  }

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
  // The Paperclip SDK already namespaces state by (scopeKind, scopeId),
  // so we don't need a separate "latest" pointer — runCtx.runId on a tool
  // call is authoritative.
  await Promise.all(
    [
      event.runId ? scopeFor("run", event.runId) : undefined,
      event.issueId ? scopeFor("issue", event.issueId) : undefined,
      event.agentId ? scopeFor("agent", event.agentId) : undefined
    ]
      .filter((s): s is ScopeKey => s !== undefined)
      .map((scope) => writeScopeState(ctx, scope, state))
  );

  return state;
}

// Auto-extract handler for `agent.run.finished` (#11).
//
// Pipeline (matches the diagram in the plan file):
//   1. Guards: retainEnabled, issueId, startedAt + finishedAt — fail
//      closed when timestamps are missing rather than write false
//      provenance (D13).
//   2. Fetch sources: issue body + comments. Both calls live inside one
//      try/catch so a single failure logs and aborts cleanly without
//      crashing the SDK event handler (decision 1C).
//   3. Filter comments: human-authored (`authorUserId != null`, D12) AND
//      contemporaneous with the run window (D13).
//   4. Regex pass via `extractFactsFromText` over each source string.
//   5. Insert via `store.addFact` with `source/agentId/runId` populated.
//      Each addFact is wrapped in try/catch (Hermes line 380 pattern)
//      so one bad row doesn't abort peers.
//   6. Log once at info level with the inserted-count — only after the
//      regex pass completes. Early-return guards skip this log so the
//      log line means "the handler ran end-to-end" (clarification C9).
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
  // Hoisted once; reused in every log line so a future placeholder change
  // (e.g. switching to runId) only happens in one place.
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
    const bodyText = [issue?.title, issue?.description, issue?.body]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n");

    const filteredComments = (rawComments ?? []).filter((comment: any) => {
      // D12: only humans. Agent comments saying "I prefer X" are
      // self-talk, not user preferences. authorUserId presence is the
      // canonical "human authored" signal in the SDK shape.
      if (!comment?.authorUserId) return false;
      // D13: only contemporaneous comments. createdAt is a Date or ISO
      // string depending on the host; normalize via Date.parse.
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
          // exactOptionalPropertyTypes forbids `field: value | undefined`
          // on optional props — build the fact incrementally and only
          // attach agentId/runId when present.
          const fact: Parameters<MemoryStore["addFact"]>[0] = {
            content: hit.content,
            category: hit.category,
            trustScore: AUTO_EXTRACT_TRUST,
            source: AUTO_EXTRACT_SOURCE
          };
          if (agentId) fact.agentId = agentId;
          if (runId) fact.runId = runId;
          const result = store.addFact(fact);
          if (result.inserted) insertedCount += 1;
        } catch (err) {
          // Inner catch — mirrors Hermes' on_session_end pattern in
          // ~/.hermes/hermes-agent/plugins/memory/holographic/__init__.py
          // (the `_auto_extract_facts` try/except around add_fact): one
          // bad insertion (e.g. SQLite lock race) must not abort the
          // loop. Logged for diagnostics; not rethrown.
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
    // Outer catch (decision 1C): network blips on issues.get /
    // listComments must not throw out of an SDK event handler. Log and
    // exit cleanly — the next run.finished will retry naturally.
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
// Action handlers — exported for direct invocation in tests.
// ---------------------------------------------------------------------------

type ActionHandler = (
  store: MemoryStore,
  params: ToolParams,
  config: HolographicMemoryConfig,
  ctx: any,
  runCtx: ToolRunContext
) => Promise<ToolResult>;

function err(message: string): ToolResult {
  return { content: message, error: message };
}

async function handleSearch(store: MemoryStore, params: ToolParams, config: HolographicMemoryConfig): Promise<ToolResult> {
  if (!params.query?.trim()) return err("Missing required parameter: query");
  const facts = store.search(params.query, {
    limit: params.limit ?? 5,
    minTrust: params.min_trust ?? config.minTrustScore
  });
  return { content: formatFactsAsText(facts) };
}

async function handleProbe(store: MemoryStore, params: ToolParams, config: HolographicMemoryConfig): Promise<ToolResult> {
  if (!params.entity?.trim()) return err("Missing required parameter: entity");
  const facts = store.probe(params.entity, {
    limit: params.limit ?? 5,
    minTrust: params.min_trust ?? config.minTrustScore
  });
  return { content: formatFactsAsText(facts) };
}

async function handleRelated(store: MemoryStore, params: ToolParams, config: HolographicMemoryConfig): Promise<ToolResult> {
  if (!params.entity?.trim()) return err("Missing required parameter: entity");
  const facts = store.related(params.entity, {
    limit: params.limit ?? 5,
    minTrust: params.min_trust ?? config.minTrustScore
  });
  return { content: formatFactsAsText(facts) };
}

async function handleReason(store: MemoryStore, params: ToolParams, config: HolographicMemoryConfig): Promise<ToolResult> {
  if (!Array.isArray(params.entities) || params.entities.length === 0) {
    return err("Missing required parameter: entities");
  }
  const facts = store.reason(params.entities, {
    limit: params.limit ?? 5,
    minTrust: params.min_trust ?? config.minTrustScore
  });
  return { content: formatFactsAsText(facts) };
}

async function handleList(store: MemoryStore, params: ToolParams, config: HolographicMemoryConfig): Promise<ToolResult> {
  const options: { limit: number; minTrust: number; category?: string } = {
    limit: params.limit ?? 5,
    minTrust: params.min_trust ?? config.minTrustScore
  };
  if (params.category) options.category = params.category;
  const facts = store.listFacts(options);
  // D6 / Codex C10: list is a CRUD/inventory op, returns JSON.
  return { content: JSON.stringify({ facts, count: facts.length }), data: { facts, count: facts.length } };
}

async function handleFeedback(store: MemoryStore, params: ToolParams): Promise<ToolResult> {
  if (typeof params.fact_id !== "number" || typeof params.helpful !== "boolean") {
    return err("Missing required parameters: fact_id and helpful");
  }
  const result = store.recordFeedback(params.fact_id, params.helpful);
  return { content: JSON.stringify(result), data: result };
}

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

  if (params.query?.trim()) {
    const facts = store.search(params.query, {
      limit: params.limit ?? config.maxFactsPerRecall,
      minTrust: params.min_trust ?? config.minTrustScore
    });
    return { content: formatFactsAsText(facts) };
  }

  return {
    content:
      "No cached recall context for this run. Pass run_id, issue_id, agent_id, or query to search the memory store directly."
  };
}

async function handleAdd(store: MemoryStore, params: ToolParams): Promise<ToolResult> {
  if (typeof params.content !== "string" || !params.content.trim()) {
    return err("Missing required parameter: content");
  }
  const fact: Parameters<MemoryStore["addFact"]>[0] = { content: params.content };
  if (typeof params.category === "string") fact.category = params.category;
  if (params.tags !== undefined) fact.tags = params.tags;
  if (typeof params.trust_score === "number") fact.trustScore = params.trust_score;
  const result = store.addFact(fact);
  return { content: JSON.stringify(result), data: result };
}

async function handleUpdate(store: MemoryStore, params: ToolParams): Promise<ToolResult> {
  if (typeof params.fact_id !== "number") {
    return err("Missing required parameter: fact_id");
  }
  const partial: Parameters<MemoryStore["updateFact"]>[1] = {};
  if (typeof params.content === "string") partial.content = params.content;
  if (typeof params.category === "string") partial.category = params.category;
  if (params.tags !== undefined) partial.tags = params.tags;
  if (typeof params.trust_delta === "number") partial.trustDelta = params.trust_delta;
  const result = store.updateFact(params.fact_id, partial);
  return { content: JSON.stringify(result), data: result };
}

async function handleRemove(store: MemoryStore, params: ToolParams): Promise<ToolResult> {
  if (typeof params.fact_id !== "number") {
    return err("Missing required parameter: fact_id");
  }
  const result = store.removeFact(params.fact_id);
  return { content: JSON.stringify(result), data: result };
}

export const ACTION_HANDLERS: Record<string, ActionHandler> = {
  search: handleSearch,
  probe: handleProbe,
  related: handleRelated,
  reason: handleReason,
  recall_context: handleRecallContext,
  list: handleList,
  feedback: handleFeedback,
  add: handleAdd,
  update: handleUpdate,
  remove: handleRemove
};

const READ_ACTIONS = new Set(["search", "probe", "related", "reason", "recall_context", "list", "feedback"]);
const WRITE_ACTIONS = new Set(["add", "update", "remove"]);

export async function dispatchAction(
  params: ToolParams,
  config: HolographicMemoryConfig,
  ctx: any,
  runCtx: ToolRunContext
): Promise<ToolResult> {
  const action = params.action ?? "search";
  const handler = ACTION_HANDLERS[action];
  if (!handler) return err(`Unknown memory action: ${action}`);

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
  const description = buildToolDescription();

  const declaration = {
    displayName: "Holographic Memory",
    description,
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
            "recall_context",
            "list",
            "feedback",
            "add",
            "update",
            "remove"
          ],
          default: "search"
        },
        query: { type: "string" },
        entity: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        category: { type: "string" },
        fact_id: { type: "number" },
        helpful: { type: "boolean" },
        limit: { type: "number", default: 5, minimum: 1, maximum: 50 },
        min_trust: { type: "number", default: config.minTrustScore, minimum: 0, maximum: 1 },
        run_id: { type: "string" },
        issue_id: { type: "string" },
        agent_id: { type: "string" },
        content: { type: "string" },
        tags: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }]
        },
        trust_score: { type: "number", minimum: 0, maximum: 1 },
        trust_delta: { type: "number", minimum: -1, maximum: 1 }
      },
      required: []
    }
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

// Returns the static system-prompt surrogate for the tool description.
// Tool declarations are registered once at setup() and not refreshed,
// so we deliberately avoid embedding mutable state (e.g. fact counts)
// here — stale info would mislead the agent. Status belongs in the
// data returned by recall_context / list, not in the schema's description.
export function buildToolDescription(): string {
  return [
    "Holographic memory store. Facts persist across runs in an isolated SQLite DB.",
    "",
    "On the first turn of a run, call action='recall_context' to read any pre-fetched memory for the current issue.",
    "Use action='search', 'probe', or 'reason' to retrieve facts. Pass min_trust to filter weak facts.",
    "Use action='add' to store a durable fact the user would expect remembered. Mark category ('project','user_pref','tool','general') and tags.",
    "Use action='feedback' (helpful: boolean) on a fact_id after consuming it — this trains trust scores so good facts rise.",
    "Use action='update' to refine a fact's content or trust; action='remove' to delete a stale fact.",
    "Note: writes (add/update/remove) require retainEnabled=true in plugin config."
  ].join("\n");
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
