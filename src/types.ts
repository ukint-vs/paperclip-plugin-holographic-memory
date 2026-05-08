export interface HolographicMemoryConfig {
  dbPath: string;
  recallEnabled: boolean;
  retainEnabled: boolean;
  minTrustScore: number;
  maxFactsPerRecall: number;
}

export interface MemoryFact {
  factId: number;
  content: string;
  category: string;
  tags: string;
  trustScore: number;
  retrievalCount: number;
  helpfulCount: number;
  score?: number;
  // Provenance columns (D11). NULL on curated facts; populated on
  // auto-extracted ones so SQL filters like `WHERE source = 'auto'`
  // work without a tags-string scan.
  source: string | null;
  agentId: string | null;
  runId: string | null;
}

export interface MemorySearchOptions {
  limit?: number;
  minTrust?: number;
}

export interface NewMemoryFact {
  content: string;
  category?: string;
  tags?: string | string[];
  trustScore?: number;
  source?: string;
  agentId?: string;
  runId?: string;
}

// Shared envelope shape pulled from `agent.run.started` and
// `agent.run.finished` plugin events. The SDK ships `PluginEvent<T>` with
// IDs at the top level (entityId/actorId/companyId) and a typed payload
// underneath; we duck-type both. The `started`/`finished` envelopes
// expose the same envelope-level fields, so one type covers both
// handlers (decision 2A). `startedAt`/`finishedAt` come from the
// `finished` payload and are required by the time-window filter (D13).
export interface AgentRunEvent {
  runId?: string;
  agentId?: string;
  issueId?: string;
  companyId?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AddFactResult {
  factId: number;
  inserted: boolean;
}

export interface UpdateFactPartial {
  content?: string;
  category?: string;
  tags?: string | string[];
  trustDelta?: number;
}

export interface UpdateFactResult {
  updated: boolean;
  reason?: "not_found" | "duplicate_content";
}

export interface RemoveFactResult {
  removed: boolean;
}

export interface FactFeedbackResult {
  factId: number;
  oldTrust: number;
  newTrust: number;
  helpfulCount: number;
}

export interface RecallState {
  issueId?: string;
  runId?: string;
  query: string;
  facts: MemoryFact[];
  formatted: string;
  createdAt: string;
}
