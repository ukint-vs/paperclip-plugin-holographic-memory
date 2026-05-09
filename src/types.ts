export interface HolographicMemoryConfig {
  dbPath: string;
  recallEnabled: boolean;
  retainEnabled: boolean;
  minTrustScore: number;
  maxFactsPerRecall: number;
  // Half-life for trust decay, in days. 0 (default) disables decay so existing
  // ranking is preserved on upgrade. When > 0, a fact's effective trust at
  // scoring time is `trustScore * 0.5^(ageDays / trustHalfLifeDays)`, where
  // ageDays is computed from the fact's last_accessed_at (falling back to
  // created_at via SQL COALESCE). Decay applies only on the scored read paths
  // (search, related); list/probe/reason keep raw trust ordering.
  trustHalfLifeDays: number;
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
  // Provenance — NULL on curated facts, populated on auto-extracted
  // ones so `WHERE source = 'auto'` works without a tags-string scan.
  source: string | null;
  agentId: string | null;
  runId: string | null;
  // Cross-tenant scoping. NULL = global (visible to all companies);
  // populated rows are isolated to their writing company.
  companyId: string | null;
}

export interface MemorySearchOptions {
  limit?: number;
  minTrust?: number;
  // Scope reads to this company plus NULL (global) rows. Omit only
  // for trusted server-side audits.
  companyId?: string;
  // Trust half-life in days for the scored ranking paths (search, related).
  // 0 / omitted means no decay (default). Per-call rather than constructor-
  // injected so a Settings UI toggle propagates without store-registry
  // invalidation, matching the pattern used by minTrust / limit / companyId.
  halfLifeDays?: number;
}

export interface NewMemoryFact {
  content: string;
  category?: string;
  tags?: string | string[];
  trustScore?: number;
  source?: string;
  agentId?: string;
  runId?: string;
  companyId?: string;
}

// Shared envelope shape duck-typed from `agent.run.started` and
// `agent.run.finished`. `startedAt`/`finishedAt` only populated for
// finished events; the time-window filter requires them.
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
