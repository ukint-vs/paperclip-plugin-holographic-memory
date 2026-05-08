import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { bundle, bytesToPhases, DEFAULT_HRR_DIM, encodeAtom, encodeFact, encodeText, phasesToBytes, similarity, unbind } from "./hrr.js";
import type { AddFactResult, FactFeedbackResult, MemoryFact, MemorySearchOptions, NewMemoryFact } from "./types.js";

interface FactRow {
  fact_id: number;
  content: string;
  category: string | null;
  tags: string | null;
  trust_score: number | null;
  retrieval_count: number | null;
  helpful_count: number | null;
  hrr_vector?: Buffer | null;
  score?: number;
}

interface MemoryStoreOptions {
  hrrEnabled?: boolean;
  hrrDim?: number;
}

export class MemoryStore {
  readonly dbPath: string;
  private readonly db: Database.Database;
  private readonly hrrEnabled: boolean;
  private readonly hrrDim: number;

  constructor(dbPath: string, options: MemoryStoreOptions = {}) {
    this.dbPath = dbPath;
    this.hrrEnabled = options.hrrEnabled ?? true;
    this.hrrDim = options.hrrDim ?? DEFAULT_HRR_DIM;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  search(query: string, options: MemorySearchOptions = {}): MemoryFact[] {
    const limit = normalizeLimit(options.limit);
    const minTrust = options.minTrust ?? 0;
    const ftsQuery = toFtsQuery(query);

    if (!ftsQuery) {
      return [];
    }

    const byText = this.searchFts(ftsQuery, limit * 3, minTrust);
    const remaining = Math.max(0, limit * 3 - byText.length);

    const byEntity = this.searchEntities(query, remaining, minTrust);
    const merged = new Map<number, MemoryFact>();

    for (const fact of [...byText, ...byEntity]) {
      merged.set(fact.factId, fact);
    }

    const queryTokens = tokenize(query);
    const queryVector = this.hrrEnabled ? encodeText(query, this.hrrDim) : undefined;
    const results = [...merged.values()]
      .map((fact) => scoreFact(fact, queryTokens, queryVector))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.trustScore - a.trustScore || a.factId - b.factId)
      .slice(0, limit);

    this.incrementRetrievalCounts(results.map((fact) => fact.factId));
    return results;
  }

  close(): void {
    this.db.close();
  }

  addFact(fact: NewMemoryFact): AddFactResult {
    const content = fact.content.trim();

    if (!content) {
      throw new Error("Cannot add an empty memory fact");
    }

    const existing = this.db.prepare("SELECT fact_id FROM facts WHERE content = ?").get(content) as
      | { fact_id: number }
      | undefined;
    const tags = normalizeTags(fact.tags);
    const category = fact.category?.trim() || "general";
    const trustScore = normalizeTrust(fact.trustScore);

    if (existing) {
      return { factId: existing.fact_id, inserted: false };
    }

    const result = this.db
      .prepare("INSERT INTO facts (content, category, tags, trust_score) VALUES (?, ?, ?, ?)")
      .run(content, category, tags, trustScore);
    const factId = Number(result.lastInsertRowid);
    const entities = extractEntities(content);

    for (const entity of entities) {
      const entityId = this.resolveEntity(entity);
      this.linkFactEntity(factId, entityId);
    }

    this.computeHrrVector(factId, content, entities);
    this.rebuildBank(category);
    return { factId, inserted: true };
  }

  probe(entity: string, options: MemorySearchOptions = {}): MemoryFact[] {
    return this.searchEntities(entity, normalizeLimit(options.limit), options.minTrust ?? 0);
  }

  reason(entities: string[], options: MemorySearchOptions = {}): MemoryFact[] {
    const limit = normalizeLimit(options.limit);
    const minTrust = options.minTrust ?? 0;
    const unique = entities.map((entity) => entity.trim()).filter(Boolean);

    if (!unique.length) {
      return [];
    }

    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT f.fact_id, f.content, f.category, f.tags, f.trust_score, f.retrieval_count, f.helpful_count, f.hrr_vector
         FROM facts f
         JOIN fact_entities fe ON f.fact_id = fe.fact_id
         JOIN entities e ON fe.entity_id = e.entity_id
         WHERE lower(e.name) IN (${placeholders})
           AND COALESCE(f.trust_score, 0) >= ?
         GROUP BY f.fact_id
         HAVING COUNT(DISTINCT lower(e.name)) = ?
         ORDER BY f.trust_score DESC, f.fact_id ASC
         LIMIT ?`
      )
      .all(...unique.map((entity) => entity.toLowerCase()), minTrust, unique.length, limit) as FactRow[];
    const results = rows.map(mapFactRow);
    this.incrementRetrievalCounts(results.map((fact) => fact.factId));
    return results;
  }

  related(entity: string, options: MemorySearchOptions = {}): MemoryFact[] {
    const limit = normalizeLimit(options.limit);
    const minTrust = options.minTrust ?? 0;
    const entityVector = encodeAtom(entity.toLowerCase(), this.hrrDim);
    const roleContent = encodeAtom("__hrr_role_content__", this.hrrDim);
    const rows = this.db
      .prepare(
        `SELECT fact_id, content, category, tags, trust_score, retrieval_count, helpful_count, hrr_vector
         FROM facts
         WHERE hrr_vector IS NOT NULL
           AND COALESCE(trust_score, 0) >= ?`
      )
      .all(minTrust) as FactRow[];
    const results = rows
      .map((row) => {
        const vector = bytesToPhases(row.hrr_vector ?? Buffer.alloc(0));
        const residual = unbind(vector, entityVector);
        const score = ((similarity(residual, roleContent) + 1) / 2) * (row.trust_score ?? 0);
        return { ...mapFactRow(row), score };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);

    this.incrementRetrievalCounts(results.map((fact) => fact.factId));
    return results;
  }

  listFacts(options: MemorySearchOptions & { category?: string } = {}): MemoryFact[] {
    const limit = normalizeLimit(options.limit);
    const minTrust = options.minTrust ?? 0;
    const rows = this.db
      .prepare(
        `SELECT fact_id, content, category, tags, trust_score, retrieval_count, helpful_count, hrr_vector
         FROM facts
         WHERE COALESCE(trust_score, 0) >= ?
           AND (? IS NULL OR category = ?)
         ORDER BY trust_score DESC, fact_id ASC
         LIMIT ?`
      )
      .all(minTrust, options.category ?? null, options.category ?? null, limit) as FactRow[];

    return rows.map(mapFactRow);
  }

  recordFeedback(factId: number, helpful: boolean): FactFeedbackResult {
    const row = this.db
      .prepare("SELECT fact_id, trust_score, helpful_count FROM facts WHERE fact_id = ?")
      .get(factId) as { fact_id: number; trust_score: number; helpful_count: number } | undefined;

    if (!row) {
      throw new Error(`fact_id ${factId} not found`);
    }

    const oldTrust = row.trust_score;
    const newTrust = normalizeTrust(oldTrust + (helpful ? 0.05 : -0.1));
    const helpfulIncrement = helpful ? 1 : 0;
    this.db
      .prepare(
        `UPDATE facts
         SET trust_score = ?,
             helpful_count = helpful_count + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE fact_id = ?`
      )
      .run(newTrust, helpfulIncrement, factId);

    return {
      factId,
      oldTrust,
      newTrust,
      helpfulCount: row.helpful_count + helpfulIncrement
    };
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(facts)").all() as { name: string }[]).map((column) => column.name)
    );

    if (!columns.has("helpful_count")) {
      this.db.prepare("ALTER TABLE facts ADD COLUMN helpful_count INTEGER DEFAULT 0").run();
    }

    if (!columns.has("hrr_vector")) {
      this.db.prepare("ALTER TABLE facts ADD COLUMN hrr_vector BLOB").run();
    }
  }

  private searchFts(query: string, limit: number, minTrust: number): MemoryFact[] {
    const rows = this.db
      .prepare(
        `SELECT f.fact_id, f.content, f.category, f.tags, f.trust_score, f.retrieval_count,
                f.helpful_count, f.hrr_vector
         FROM facts_fts
         JOIN facts f ON facts_fts.rowid = f.fact_id
         WHERE facts_fts MATCH ?
           AND COALESCE(f.trust_score, 0) >= ?
         ORDER BY facts_fts.rank, f.trust_score DESC, f.fact_id ASC
         LIMIT ?`
      )
      .all(query, minTrust, limit) as FactRow[];

    return rows.map(mapFactRow);
  }

  private searchEntities(query: string, limit: number, minTrust: number): MemoryFact[] {
    const terms = extractEntityTerms(query);

    if (!terms.length) {
      return [];
    }

    const results = new Map<number, MemoryFact>();
    const stmt = this.db.prepare(
      `SELECT f.fact_id, f.content, f.category, f.tags, f.trust_score, f.retrieval_count,
              f.helpful_count, f.hrr_vector
       FROM facts f
       JOIN fact_entities fe ON f.fact_id = fe.fact_id
       JOIN entities e ON fe.entity_id = e.entity_id
       WHERE (e.name LIKE ? OR e.aliases LIKE ?)
         AND COALESCE(f.trust_score, 0) >= ?
       ORDER BY f.trust_score DESC, f.fact_id ASC
       LIMIT ?`
    );

    for (const term of terms) {
      const pattern = `%${term}%`;
      const rows = stmt.all(pattern, pattern, minTrust, limit) as FactRow[];

      for (const row of rows) {
        results.set(row.fact_id, mapFactRow(row));
      }
    }

    return [...results.values()]
      .sort((a, b) => b.trustScore - a.trustScore || a.factId - b.factId)
      .slice(0, limit);
  }

  private resolveEntity(name: string): number {
    const existing = this.db
      .prepare("SELECT entity_id FROM entities WHERE lower(name) = lower(?)")
      .get(name) as { entity_id: number } | undefined;

    if (existing) {
      return existing.entity_id;
    }

    const result = this.db.prepare("INSERT INTO entities (name) VALUES (?)").run(name);
    return Number(result.lastInsertRowid);
  }

  private linkFactEntity(factId: number, entityId: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?, ?)")
      .run(factId, entityId);
  }

  private computeHrrVector(factId: number, content: string, entities: string[]): void {
    if (!this.hrrEnabled) {
      return;
    }

    const vector = encodeFact(content, entities, this.hrrDim);
    this.db.prepare("UPDATE facts SET hrr_vector = ? WHERE fact_id = ?").run(phasesToBytes(vector), factId);
  }

  private rebuildBank(category: string): void {
    if (!this.hrrEnabled) {
      return;
    }

    const rows = this.db
      .prepare("SELECT hrr_vector FROM facts WHERE category = ? AND hrr_vector IS NOT NULL")
      .all(category) as { hrr_vector: Buffer }[];
    const bankName = `cat:${category}`;

    if (!rows.length) {
      this.db.prepare("DELETE FROM memory_banks WHERE bank_name = ?").run(bankName);
      return;
    }

    const bankVector = bundle(...rows.map((row) => bytesToPhases(row.hrr_vector)));
    this.db
      .prepare(
        `INSERT INTO memory_banks (bank_name, vector, dim, fact_count, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(bank_name) DO UPDATE SET
           vector = excluded.vector,
           dim = excluded.dim,
           fact_count = excluded.fact_count,
           updated_at = excluded.updated_at`
      )
      .run(bankName, phasesToBytes(bankVector), this.hrrDim, rows.length);
  }

  private incrementRetrievalCounts(factIds: number[]): void {
    if (!factIds.length) {
      return;
    }

    const placeholders = factIds.map(() => "?").join(", ");
    this.db.prepare(`UPDATE facts SET retrieval_count = retrieval_count + 1 WHERE fact_id IN (${placeholders})`).run(
      ...factIds
    );
  }
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facts (
  fact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL UNIQUE,
  category TEXT DEFAULT 'general',
  tags TEXT DEFAULT '',
  trust_score REAL DEFAULT 0.5,
  retrieval_count INTEGER DEFAULT 0,
  helpful_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  hrr_vector BLOB
);

CREATE INDEX IF NOT EXISTS idx_facts_trust ON facts(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
  USING fts5(content, tags, content=facts, content_rowid=fact_id);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, content, tags)
    VALUES (new.fact_id, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content, tags)
    VALUES ('delete', old.fact_id, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content, tags)
    VALUES ('delete', old.fact_id, old.content, old.tags);
  INSERT INTO facts_fts(rowid, content, tags)
    VALUES (new.fact_id, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS entities (
  entity_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  entity_type TEXT DEFAULT 'unknown',
  aliases TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

CREATE TABLE IF NOT EXISTS fact_entities (
  fact_id INTEGER REFERENCES facts(fact_id),
  entity_id INTEGER REFERENCES entities(entity_id),
  PRIMARY KEY (fact_id, entity_id)
);

CREATE TABLE IF NOT EXISTS memory_banks (
  bank_id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_name TEXT NOT NULL UNIQUE,
  vector BLOB NOT NULL,
  dim INTEGER NOT NULL,
  fact_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

function mapFactRow(row: FactRow): MemoryFact {
  const fact: MemoryFact = {
    factId: row.fact_id,
    content: row.content,
    category: row.category ?? "general",
    tags: row.tags ?? "",
    trustScore: row.trust_score ?? 0,
    retrievalCount: row.retrieval_count ?? 0,
    helpfulCount: row.helpful_count ?? 0
  };

  if (typeof row.score === "number") {
    fact.score = row.score;
  }

  return fact;
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 5;
  }

  return Math.max(1, Math.min(50, Math.floor(value)));
}

function normalizeTrust(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

function normalizeTags(tags: string | string[] | undefined): string {
  if (Array.isArray(tags)) {
    return tags
      .map((tag) => tag.trim())
      .filter(Boolean)
      .join(", ");
  }

  return tags?.trim() ?? "";
}

export function toFtsQuery(query: string): string {
  const tokens = query
    .split(/[^A-Za-z0-9_.:/-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12)
    .map(escapeFtsToken);

  return tokens.join(" OR ");
}

function escapeFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

function extractEntityTerms(query: string): string[] {
  const terms = new Set<string>();
  const rawTerms = query.match(/[A-Za-z0-9][A-Za-z0-9_.:/-]{2,}/g) ?? [];

  for (const term of rawTerms) {
    if (term.length >= 3) {
      terms.add(term);
    }
  }

  return [...terms].slice(0, 8);
}

export function extractEntities(text: string): string[] {
  const seen = new Set<string>();
  const entities: string[] = [];
  const patterns = [
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    /"([^"]+)"/g,
    /'([^']+)'/g,
    /(\w+(?:\s+\w+)*)\s+(?:aka|also known as)\s+(\w+(?:\s+\w+)*)/gi
  ];

  const add = (value: string) => {
    const entity = value.trim();
    const key = entity.toLowerCase();

    if (entity && !seen.has(key)) {
      seen.add(key);
      entities.push(entity);
    }
  };

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      add(match[1] ?? "");

      if (match[2]) {
        add(match[2]);
      }
    }
  }

  return entities;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_.:/-]+/)
      .filter((token) => token.length > 1)
  );
}

function scoreFact(fact: MemoryFact, queryTokens: Set<string>, queryVector?: Float64Array): MemoryFact {
  const factTokens = tokenize(`${fact.content} ${fact.tags}`);
  const overlap = [...queryTokens].filter((token) => factTokens.has(token)).length;
  const union = new Set([...queryTokens, ...factTokens]).size || 1;
  const jaccard = overlap / union;
  const relevance = queryVector ? 0.7 * jaccard + 0.3 * 0.5 : jaccard;

  return {
    ...fact,
    score: relevance * fact.trustScore
  };
}
