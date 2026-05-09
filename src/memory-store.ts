import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { bundle, bytesToPhases, DEFAULT_HRR_DIM, encodeAtom, encodeFact, encodeText, phasesToBytes, similarity, unbind } from "./hrr.js";
import type {
  AddFactResult,
  FactFeedbackResult,
  MemoryFact,
  MemorySearchOptions,
  NewMemoryFact,
  RemoveFactResult,
  UpdateFactPartial,
  UpdateFactResult
} from "./types.js";

interface FactRow {
  fact_id: number;
  content: string;
  category: string | null;
  tags: string | null;
  trust_score: number | null;
  retrieval_count: number | null;
  helpful_count: number | null;
  hrr_vector?: Buffer | null;
  source?: string | null;
  agent_id?: string | null;
  run_id?: string | null;
  company_id?: string | null;
  // Epoch seconds projected via SQL `unixepoch(COALESCE(last_accessed_at,
  // created_at))`. We compute age in JS, but parsing SQLite's
  // "YYYY-MM-DD HH:MM:SS" with Date.parse treats it as local time, which
  // silently corrupts ranking outside UTC; integer epoch sidesteps that.
  last_touched_unix?: number | null;
  score?: number;
  fts_rank_raw?: number | null;
}

// Internal scoring shape — vector + raw FTS rank carried through the
// search pipeline, stripped before results leave the store.
interface ScorableFact extends MemoryFact {
  hrrVector?: Float64Array;
  ftsRankRaw?: number;
  lastTouchedUnix?: number;
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
    // Multiple processes (worker + per-spawn MCP servers) can hold writers
    // when the standalone MCP bridge is wired up. With WAL we serialize on
    // the writer lock; busy_timeout makes contended writes wait up to 5s
    // for the lock instead of throwing SQLITE_BUSY immediately. Real-world
    // contention is microseconds; 5s is generous headroom.
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  search(query: string, options: MemorySearchOptions = {}): MemoryFact[] {
    const limit = normalizeLimit(options.limit);
    const minTrust = options.minTrust ?? 0;
    const companyId = options.companyId;
    const halfLifeDays = options.halfLifeDays ?? 0;
    const ftsQuery = toFtsQuery(query);

    if (!ftsQuery) {
      return [];
    }

    const byText = this.searchFts(ftsQuery, limit * 3, minTrust, companyId);
    const remaining = Math.max(0, limit * 3 - byText.length);

    const byEntity = this.searchEntities(query, remaining, minTrust, companyId);
    // FTS branch wins on collision: it carries both the vector and the rank.
    const merged = new Map<number, ScorableFact>();
    for (const fact of byEntity) merged.set(fact.factId, fact);
    for (const fact of byText) merged.set(fact.factId, fact);

    // Normalize FTS rank across the candidate batch. FTS5 rank is negative
    // (lower = better); abs(rank)/maxAbs produces [0, 1] where best = 1.
    // 1e-6 floor prevents NaN when only entity-branch hits (no rank) exist.
    const candidates = [...merged.values()];
    const maxAbsRank = Math.max(
      ...candidates.map((c) => Math.abs(c.ftsRankRaw ?? 0)),
      1e-6
    );
    const ftsLookup = (fact: ScorableFact): number =>
      fact.ftsRankRaw == null ? 0 : Math.abs(fact.ftsRankRaw) / maxAbsRank;

    const queryTokens = tokenize(query);
    const queryVector = this.hrrEnabled ? encodeText(query, this.hrrDim) : undefined;
    const nowSec = Date.now() / 1000;

    const scored = candidates
      .map((fact) => scoreFact(fact, queryTokens, queryVector, ftsLookup, halfLifeDays, nowSec))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.trustScore - a.trustScore || a.factId - b.factId)
      .slice(0, limit);

    this.incrementRetrievalCounts(scored.map((fact) => fact.factId));
    return scored.map(stripScoringFields);
  }

  close(): void {
    this.db.close();
  }

  countFacts(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number };
    return row?.n ?? 0;
  }

  addFact(fact: NewMemoryFact): AddFactResult {
    const content = fact.content.trim();

    if (!content) {
      throw new Error("Cannot add an empty memory fact");
    }

    const tags = normalizeTags(fact.tags);
    const category = fact.category?.trim() || "general";
    const trustScore = normalizeTrust(fact.trustScore);
    const source = normalizeProvenance(fact.source);
    const agentId = normalizeProvenance(fact.agentId);
    const runId = normalizeProvenance(fact.runId);
    const companyId = normalizeProvenance(fact.companyId);

    const run = this.db.transaction((): AddFactResult => {
      // Dedup is per (content, company_id) so two companies can hold the
      // same fact text; treat NULL as a sentinel value, not "unknown".
      const existing = this.db
        .prepare("SELECT fact_id FROM facts WHERE content = ? AND COALESCE(company_id, '') = COALESCE(?, '')")
        .get(content, companyId) as { fact_id: number } | undefined;

      if (existing) {
        return { factId: existing.fact_id, inserted: false };
      }

      // The dedup SELECT above guarantees content novelty per
      // (content, companyId), so the table-level UNIQUE on `content`
      // only fires on a cross-tenant collision over a shared dbPath
      // — the SQLite error propagates to the caller as-is.
      const result = this.db
        .prepare(
          "INSERT INTO facts (content, category, tags, trust_score, source, agent_id, run_id, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(content, category, tags, trustScore, source, agentId, runId, companyId);
      const factId = Number(result.lastInsertRowid);
      const entities = extractEntities(content);

      for (const entity of entities) {
        const entityId = this.resolveEntity(entity);
        this.linkFactEntity(factId, entityId);
      }

      this.computeHrrVector(factId, content, entities);
      this.rebuildBank(category);
      return { factId, inserted: true };
    });

    return run();
  }

  updateFact(factId: number, partial: UpdateFactPartial): UpdateFactResult {
    const run = this.db.transaction((): UpdateFactResult => {
      const row = this.db
        .prepare("SELECT fact_id, category, trust_score FROM facts WHERE fact_id = ?")
        .get(factId) as { fact_id: number; category: string; trust_score: number } | undefined;

      if (!row) {
        return { updated: false, reason: "not_found" };
      }

      const oldCategory = row.category ?? "general";
      const newContent = typeof partial.content === "string" ? partial.content.trim() : undefined;
      const contentChanged = newContent !== undefined && newContent.length > 0;
      const newCategory = partial.category?.trim();
      const categoryChanged = typeof newCategory === "string" && newCategory.length > 0 && newCategory !== oldCategory;
      const newTags = partial.tags === undefined ? undefined : normalizeTags(partial.tags);
      const newTrust =
        typeof partial.trustDelta === "number" && !Number.isNaN(partial.trustDelta)
          ? normalizeTrust(row.trust_score + partial.trustDelta)
          : undefined;

      const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
      const params: unknown[] = [];

      if (contentChanged) {
        sets.push("content = ?");
        params.push(newContent!);
      }
      if (categoryChanged) {
        sets.push("category = ?");
        params.push(newCategory!);
      }
      if (newTags !== undefined) {
        sets.push("tags = ?");
        params.push(newTags);
      }
      if (newTrust !== undefined) {
        sets.push("trust_score = ?");
        params.push(newTrust);
      }

      params.push(factId);

      try {
        this.db.prepare(`UPDATE facts SET ${sets.join(", ")} WHERE fact_id = ?`).run(...params);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return { updated: false, reason: "duplicate_content" };
        }
        throw error;
      }

      const finalCategory = categoryChanged ? newCategory! : oldCategory;

      if (contentChanged) {
        this.db.prepare("DELETE FROM fact_entities WHERE fact_id = ?").run(factId);
        const entities = extractEntities(newContent!);
        for (const entity of entities) {
          const entityId = this.resolveEntity(entity);
          this.linkFactEntity(factId, entityId);
        }
        this.computeHrrVector(factId, newContent!, entities);
      }

      if (contentChanged || categoryChanged) {
        if (categoryChanged) this.rebuildBank(oldCategory);
        this.rebuildBank(finalCategory);
      }

      return { updated: true };
    });

    return run();
  }

  removeFact(factId: number): RemoveFactResult {
    const run = this.db.transaction((): RemoveFactResult => {
      const row = this.db.prepare("SELECT fact_id, category FROM facts WHERE fact_id = ?").get(factId) as
        | { fact_id: number; category: string }
        | undefined;

      if (!row) {
        return { removed: false };
      }

      this.db.prepare("DELETE FROM fact_entities WHERE fact_id = ?").run(factId);
      this.db.prepare("DELETE FROM facts WHERE fact_id = ?").run(factId);
      this.rebuildBank(row.category ?? "general");
      return { removed: true };
    });

    return run();
  }

  probe(entity: string, options: MemorySearchOptions = {}): MemoryFact[] {
    return this.searchEntities(
      entity,
      normalizeLimit(options.limit),
      options.minTrust ?? 0,
      options.companyId
    );
  }

  reason(entities: string[], options: MemorySearchOptions = {}): MemoryFact[] {
    const limit = normalizeLimit(options.limit);
    const minTrust = options.minTrust ?? 0;
    const companyId = options.companyId;
    const unique = entities.map((entity) => entity.trim()).filter(Boolean);

    if (!unique.length) {
      return [];
    }

    const placeholders = unique.map(() => "?").join(", ");
    const companyClause = companyId ? "AND (f.company_id = ? OR f.company_id IS NULL)" : "";
    const params: unknown[] = [...unique.map((entity) => entity.toLowerCase()), minTrust];
    if (companyId) params.push(companyId);
    params.push(unique.length, limit);

    const rows = this.db
      .prepare(
        `SELECT f.fact_id, f.content, f.category, f.tags, f.trust_score, f.retrieval_count, f.helpful_count, f.hrr_vector, f.source, f.agent_id, f.run_id, f.company_id
         FROM facts f
         JOIN fact_entities fe ON f.fact_id = fe.fact_id
         JOIN entities e ON fe.entity_id = e.entity_id
         WHERE lower(e.name) IN (${placeholders})
           AND COALESCE(f.trust_score, 0) >= ?
           ${companyClause}
         GROUP BY f.fact_id
         HAVING COUNT(DISTINCT lower(e.name)) = ?
         ORDER BY f.trust_score DESC, f.fact_id ASC
         LIMIT ?`
      )
      .all(...params) as FactRow[];
    const results = rows.map(mapFactRow);
    this.incrementRetrievalCounts(results.map((fact) => fact.factId));
    return results;
  }

  related(entity: string, options: MemorySearchOptions = {}): MemoryFact[] {
    const limit = normalizeLimit(options.limit);
    const minTrust = options.minTrust ?? 0;
    const companyId = options.companyId;
    const halfLifeDays = options.halfLifeDays ?? 0;
    const entityVector = encodeAtom(entity.toLowerCase(), this.hrrDim);
    const roleContent = encodeAtom("__hrr_role_content__", this.hrrDim);
    const companyClause = companyId ? "AND (company_id = ? OR company_id IS NULL)" : "";
    const params: unknown[] = [minTrust];
    if (companyId) params.push(companyId);
    const rows = this.db
      .prepare(
        `SELECT fact_id, content, category, tags, trust_score, retrieval_count, helpful_count, hrr_vector,
                source, agent_id, run_id, company_id,
                COALESCE(unixepoch(last_accessed_at), unixepoch(created_at)) AS last_touched_unix
         FROM facts
         WHERE hrr_vector IS NOT NULL
           AND COALESCE(trust_score, 0) >= ?
           ${companyClause}`
      )
      .all(...params) as FactRow[];
    const nowSec = Date.now() / 1000;
    const results = rows
      .map((row) => {
        const vector = bytesToPhases(row.hrr_vector ?? Buffer.alloc(0));
        const residual = unbind(vector, entityVector);
        const trust = row.trust_score ?? 0;
        const ageDays = ageDaysFromUnix(row.last_touched_unix, nowSec);
        const score =
          ((similarity(residual, roleContent) + 1) / 2) *
          decayedTrust(trust, ageDays, halfLifeDays);
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
    const companyId = options.companyId;
    const companyClause = companyId ? "AND (company_id = ? OR company_id IS NULL)" : "";
    const params: unknown[] = [minTrust, options.category ?? null, options.category ?? null];
    if (companyId) params.push(companyId);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT fact_id, content, category, tags, trust_score, retrieval_count, helpful_count, hrr_vector, source, agent_id, run_id, company_id
         FROM facts
         WHERE COALESCE(trust_score, 0) >= ?
           AND (? IS NULL OR category = ?)
           ${companyClause}
         ORDER BY trust_score DESC, fact_id ASC
         LIMIT ?`
      )
      .all(...params) as FactRow[];

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
    // Positive feedback also resets the decay clock — the user told us this
    // fact is still good. Negative feedback does NOT bump last_accessed_at:
    // a freshly-penalised fact should still age cleanly so the penalty
    // doesn't get diluted by a "last touched" reset.
    if (helpful) {
      this.db
        .prepare(
          `UPDATE facts
           SET trust_score = ?,
               helpful_count = helpful_count + ?,
               updated_at = CURRENT_TIMESTAMP,
               last_accessed_at = CURRENT_TIMESTAMP
           WHERE fact_id = ?`
        )
        .run(newTrust, helpfulIncrement, factId);
    } else {
      this.db
        .prepare(
          `UPDATE facts
           SET trust_score = ?,
               helpful_count = helpful_count + ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE fact_id = ?`
        )
        .run(newTrust, helpfulIncrement, factId);
    }

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

    // Idempotent column-add shim — collapses into a real migration when
    // the migration framework (#9) lands.
    const addColumnIfMissing = (name: string, type: string): void => {
      if (!columns.has(name)) {
        this.db.prepare(`ALTER TABLE facts ADD COLUMN ${name} ${type}`).run();
      }
    };

    addColumnIfMissing("helpful_count", "INTEGER DEFAULT 0");
    addColumnIfMissing("hrr_vector", "BLOB");
    addColumnIfMissing("source", "TEXT");
    addColumnIfMissing("agent_id", "TEXT");
    addColumnIfMissing("run_id", "TEXT");
    // Cross-tenant scoping: NULL = global (visible to all companies) so
    // legacy curated/seed rows keep working without a backfill. New writes
    // always pass companyId from the event/runCtx envelope.
    addColumnIfMissing("company_id", "TEXT");
    // Last-touched timestamp for trust decay (#8). Bumped on read via
    // incrementRetrievalCounts and on positive feedback. Migrated rows leave
    // this NULL; scoring falls back to created_at via SQL COALESCE so they
    // age from the only timestamp the system has for them.
    addColumnIfMissing("last_accessed_at", "TIMESTAMP");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_company ON facts(company_id);");
  }

  private searchFts(query: string, limit: number, minTrust: number, companyId?: string): ScorableFact[] {
    const companyClause = companyId ? "AND (f.company_id = ? OR f.company_id IS NULL)" : "";
    const params: unknown[] = [query, minTrust];
    if (companyId) params.push(companyId);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT f.fact_id, f.content, f.category, f.tags, f.trust_score, f.retrieval_count,
                f.helpful_count, f.hrr_vector, f.source, f.agent_id, f.run_id, f.company_id,
                COALESCE(unixepoch(f.last_accessed_at), unixepoch(f.created_at)) AS last_touched_unix,
                facts_fts.rank AS fts_rank_raw
         FROM facts_fts
         JOIN facts f ON facts_fts.rowid = f.fact_id
         WHERE facts_fts MATCH ?
           AND COALESCE(f.trust_score, 0) >= ?
           ${companyClause}
         ORDER BY facts_fts.rank, f.trust_score DESC, f.fact_id ASC
         LIMIT ?`
      )
      .all(...params) as FactRow[];

    return rows.map(mapFactRowWithVector);
  }

  private searchEntities(query: string, limit: number, minTrust: number, companyId?: string): ScorableFact[] {
    const terms = extractEntityTerms(query);

    if (!terms.length) {
      return [];
    }

    const results = new Map<number, ScorableFact>();
    const companyClause = companyId ? "AND (f.company_id = ? OR f.company_id IS NULL)" : "";
    // last_touched_unix is projected so search()'s scoring path can apply
    // decay; probe() uses the same SELECT but does not call scoreFact, so
    // probe ranking is unaffected by the projection.
    const stmt = this.db.prepare(
      `SELECT f.fact_id, f.content, f.category, f.tags, f.trust_score, f.retrieval_count,
              f.helpful_count, f.hrr_vector, f.source, f.agent_id, f.run_id, f.company_id,
              COALESCE(unixepoch(f.last_accessed_at), unixepoch(f.created_at)) AS last_touched_unix
       FROM facts f
       JOIN fact_entities fe ON f.fact_id = fe.fact_id
       JOIN entities e ON fe.entity_id = e.entity_id
       WHERE (e.name LIKE ? OR e.aliases LIKE ?)
         AND COALESCE(f.trust_score, 0) >= ?
         ${companyClause}
       ORDER BY f.trust_score DESC, f.fact_id ASC
       LIMIT ?`
    );

    for (const term of terms) {
      const pattern = `%${term}%`;
      const params: unknown[] = [pattern, pattern, minTrust];
      if (companyId) params.push(companyId);
      params.push(limit);
      const rows = stmt.all(...params) as FactRow[];

      for (const row of rows) {
        results.set(row.fact_id, mapFactRowWithVector(row));
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
    // last_accessed_at bump piggybacks on the existing retrieval-count UPDATE
    // so search/probe/reason/related all reset the decay clock through this
    // single chokepoint. listFacts() deliberately does NOT call this — it's
    // inspection, not reinforcement (Codex review #5).
    this.db
      .prepare(
        `UPDATE facts
         SET retrieval_count = retrieval_count + 1,
             last_accessed_at = CURRENT_TIMESTAMP
         WHERE fact_id IN (${placeholders})`
      )
      .run(...factIds);
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
  hrr_vector BLOB,
  company_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_facts_trust ON facts(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
-- idx_facts_company is created in migrate() AFTER the column-add shim,
-- so legacy DBs that lack company_id at SCHEMA_SQL time don't crash.

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
    helpfulCount: row.helpful_count ?? 0,
    // Explicit null (not undefined) for unset provenance — matches
    // SQLite NULL so consumers can `fact.source === null` unambiguously.
    source: row.source ?? null,
    agentId: row.agent_id ?? null,
    runId: row.run_id ?? null,
    companyId: row.company_id ?? null
  };

  if (typeof row.score === "number") {
    fact.score = row.score;
  }

  return fact;
}

function mapFactRowWithVector(row: FactRow): ScorableFact {
  const fact: ScorableFact = mapFactRow(row);
  if (row.hrr_vector) {
    fact.hrrVector = bytesToPhases(row.hrr_vector);
  }
  if (typeof row.fts_rank_raw === "number") {
    fact.ftsRankRaw = row.fts_rank_raw;
  }
  if (typeof row.last_touched_unix === "number") {
    fact.lastTouchedUnix = row.last_touched_unix;
  }
  return fact;
}

function stripScoringFields(scorable: ScorableFact): MemoryFact {
  const { hrrVector: _v, ftsRankRaw: _r, lastTouchedUnix: _t, ...rest } = scorable;
  return rest;
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

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}

function normalizeProvenance(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

// Trust decay (#8). Half-life formula: at ageDays = halfLife, value is half
// the original. halfLife <= 0 short-circuits to the input — that's the
// default config and should stay zero-cost.
export function decayedTrust(trust: number, ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return trust;
  if (ageDays <= 0) return trust;
  return trust * Math.pow(0.5, ageDays / halfLifeDays);
}

// SQL projects last_touched_unix as integer epoch seconds via
// `unixepoch(COALESCE(last_accessed_at, created_at))`. This avoids
// Date.parse on SQLite's "YYYY-MM-DD HH:MM:SS" format, which V8 treats as
// local time and silently shifts ages by the local TZ offset. NULL only
// when both timestamps are missing (impossible for inserted rows).
export function ageDaysFromUnix(lastTouchedUnix: number | null | undefined, nowSec: number): number {
  if (typeof lastTouchedUnix !== "number") return 0;
  return Math.max(0, (nowSec - lastTouchedUnix) / 86400);
}

// Hermes-aligned blend: 40% FTS rank + 30% Jaccard + 30% HRR similarity,
// then weighted by trust (decayed if halfLifeDays > 0). Mirrors
// retrieval.py:91-94 in the Hermes plugin.
//
// TODO(hrr-unbind-variant): Stored fact vectors come from `encodeFact`,
// which binds content to `__hrr_role_content__`. We're comparing a raw
// `encodeText(query)` to the bundled fact vector — strictly the math
// would prefer `similarity(qVec, unbind(fact.hrrVector, role_content))`.
// Hermes does the raw form too; revisit once we have real recall data.
function scoreFact(
  fact: ScorableFact,
  queryTokens: Set<string>,
  queryVector: Float64Array | undefined,
  ftsLookup: (fact: ScorableFact) => number,
  halfLifeDays: number,
  nowSec: number
): ScorableFact {
  const factTokens = tokenize(`${fact.content} ${fact.tags}`);
  const overlap = [...queryTokens].filter((token) => factTokens.has(token)).length;
  const union = new Set([...queryTokens, ...factTokens]).size || 1;
  const jaccard = overlap / union;

  const hrr =
    queryVector && fact.hrrVector
      ? (similarity(queryVector, fact.hrrVector) + 1) / 2
      : 0.5;
  const fts = ftsLookup(fact);
  const relevance = 0.4 * fts + 0.3 * jaccard + 0.3 * hrr;

  const ageDays = ageDaysFromUnix(fact.lastTouchedUnix, nowSec);
  return { ...fact, score: relevance * decayedTrust(fact.trustScore, ageDays, halfLifeDays) };
}
