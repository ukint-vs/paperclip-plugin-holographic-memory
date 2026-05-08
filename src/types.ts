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
}

export interface AddFactResult {
  factId: number;
  inserted: boolean;
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
