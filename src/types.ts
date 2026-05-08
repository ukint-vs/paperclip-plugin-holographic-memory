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
  // Provenance — NULL on curated facts, populated on auto-extracted
  // ones so `WHERE source = 'auto'` works without a tags-string scan.
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
