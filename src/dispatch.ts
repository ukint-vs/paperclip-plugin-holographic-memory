// Ctx-free action dispatch shared by the Paperclip worker and the standalone
// MCP server. Anything that needs Paperclip state (recall_context) lives in
// worker.ts; everything else routes through here so the MCP server can reuse
// the exact same store and handler logic.

import { formatFactsAsText } from "./context-injector.js";
import { MemoryStore } from "./memory-store.js";
import { readRecallCache, type RecallCacheScope } from "./recall-cache.js";
import type { HolographicMemoryConfig } from "./types.js";

export interface ToolParams {
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

export interface DispatchToolResult {
  content: string;
  data?: unknown;
  error?: string;
}

export type CoreActionHandler = (
  store: MemoryStore,
  params: ToolParams,
  config: HolographicMemoryConfig
) => Promise<DispatchToolResult>;

export const READ_ACTIONS = new Set([
  "search",
  "probe",
  "related",
  "reason",
  "recall_context",
  "list",
  "feedback"
]);

export const WRITE_ACTIONS = new Set(["add", "update", "remove"]);

export function err(message: string): DispatchToolResult {
  return { content: message, error: message };
}

// MemoryStore registry keyed by dbPath. Shared between worker and mcp-server
// so a single process never opens two connections to the same DB. The
// previous Map lived inside worker.ts; pulling it out keeps the mcp-server
// honest when both might run in the same Node process (rare, but cheap).
const storeRegistry = new Map<string, MemoryStore>();

export function getStore(config: HolographicMemoryConfig): MemoryStore {
  let store = storeRegistry.get(config.dbPath);
  if (!store) {
    store = new MemoryStore(config.dbPath);
    storeRegistry.set(config.dbPath, store);
  }
  return store;
}

export function closeStores(): void {
  for (const store of storeRegistry.values()) {
    store.close();
  }
  storeRegistry.clear();
}

export async function handleSearch(
  store: MemoryStore,
  params: ToolParams,
  config: HolographicMemoryConfig
): Promise<DispatchToolResult> {
  if (!params.query?.trim()) return err("Missing required parameter: query");
  const facts = store.search(params.query, {
    limit: params.limit ?? 5,
    minTrust: params.min_trust ?? config.minTrustScore
  });
  return { content: formatFactsAsText(facts) };
}

export async function handleProbe(
  store: MemoryStore,
  params: ToolParams,
  config: HolographicMemoryConfig
): Promise<DispatchToolResult> {
  if (!params.entity?.trim()) return err("Missing required parameter: entity");
  const facts = store.probe(params.entity, {
    limit: params.limit ?? 5,
    minTrust: params.min_trust ?? config.minTrustScore
  });
  return { content: formatFactsAsText(facts) };
}

export async function handleRelated(
  store: MemoryStore,
  params: ToolParams,
  config: HolographicMemoryConfig
): Promise<DispatchToolResult> {
  if (!params.entity?.trim()) return err("Missing required parameter: entity");
  const facts = store.related(params.entity, {
    limit: params.limit ?? 5,
    minTrust: params.min_trust ?? config.minTrustScore
  });
  return { content: formatFactsAsText(facts) };
}

export async function handleReason(
  store: MemoryStore,
  params: ToolParams,
  config: HolographicMemoryConfig
): Promise<DispatchToolResult> {
  if (!Array.isArray(params.entities) || params.entities.length === 0) {
    return err("Missing required parameter: entities");
  }
  const facts = store.reason(params.entities, {
    limit: params.limit ?? 5,
    minTrust: params.min_trust ?? config.minTrustScore
  });
  return { content: formatFactsAsText(facts) };
}

export async function handleList(
  store: MemoryStore,
  params: ToolParams,
  config: HolographicMemoryConfig
): Promise<DispatchToolResult> {
  const options: { limit: number; minTrust: number; category?: string } = {
    limit: params.limit ?? 5,
    minTrust: params.min_trust ?? config.minTrustScore
  };
  if (params.category) options.category = params.category;
  const facts = store.listFacts(options);
  return { content: JSON.stringify({ facts, count: facts.length }), data: { facts, count: facts.length } };
}

export async function handleFeedback(
  store: MemoryStore,
  params: ToolParams
): Promise<DispatchToolResult> {
  if (typeof params.fact_id !== "number" || typeof params.helpful !== "boolean") {
    return err("Missing required parameters: fact_id and helpful");
  }
  const result = store.recordFeedback(params.fact_id, params.helpful);
  return { content: JSON.stringify(result), data: result };
}

export async function handleAdd(
  store: MemoryStore,
  params: ToolParams
): Promise<DispatchToolResult> {
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

export async function handleUpdate(
  store: MemoryStore,
  params: ToolParams
): Promise<DispatchToolResult> {
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

export async function handleRemove(
  store: MemoryStore,
  params: ToolParams
): Promise<DispatchToolResult> {
  if (typeof params.fact_id !== "number") {
    return err("Missing required parameter: fact_id");
  }
  const result = store.removeFact(params.fact_id);
  return { content: JSON.stringify(result), data: result };
}

// Handlers that only touch the SQLite store. recall_context lives in worker.ts
// because it reads ctx.state populated on agent.run.started.
export const CORE_HANDLERS: Record<string, CoreActionHandler> = {
  search: handleSearch,
  probe: handleProbe,
  related: handleRelated,
  reason: handleReason,
  list: handleList,
  feedback: handleFeedback,
  add: handleAdd,
  update: handleUpdate,
  remove: handleRemove
};

// Used by the standalone MCP server. recall_context falls back to a live
// search since plugin state is unreachable from outside the Paperclip worker.
export async function dispatchStandaloneAction(
  params: ToolParams,
  config: HolographicMemoryConfig
): Promise<DispatchToolResult> {
  const action = params.action ?? "search";

  if (READ_ACTIONS.has(action) && !config.recallEnabled) {
    return { content: "Holographic memory recall is disabled." };
  }
  if (WRITE_ACTIONS.has(action) && !config.retainEnabled) {
    return { content: "Memory retain is disabled. Set retainEnabled=true in plugin config." };
  }

  const store = getStore(config);

  if (action === "recall_context") {
    // Standalone mode: try the on-disk recall cache (written by the worker
    // on agent.run.started) for any provided scope id. If nothing matches,
    // return a structured "not cached" marker so the agent can tell the
    // difference between "the worker pre-fetched memory" and "we did a live
    // search". Per A3 decision: do NOT silently formatted-as-MEMORY-CONTEXT
    // a live search result, because the agent strategy may branch on it.
    const fileLookups: Array<[RecallCacheScope, string]> = [];
    if (params.run_id) fileLookups.push(["run", params.run_id]);
    if (params.issue_id) fileLookups.push(["issue", params.issue_id]);
    if (params.agent_id) fileLookups.push(["agent", params.agent_id]);
    for (const [scope, scopeId] of fileLookups) {
      const cached = await readRecallCache(config.dbPath, scope, scopeId);
      if (cached?.formatted) {
        return {
          content: cached.formatted,
          data: { ...cached, mode: "standalone", cached: true }
        };
      }
    }
    return {
      content:
        "recall_context is Paperclip-only. No cached context for the supplied run/issue/agent IDs. Use action='search' with your query.",
      data: { mode: "standalone", cached: false }
    };
  }

  const handler = CORE_HANDLERS[action];
  if (!handler) return err(`Unknown memory action: ${action}`);
  return handler(store, params, config);
}
