import Database from "better-sqlite3";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ageDaysFromUnix, decayedTrust, extractEntities, MemoryStore, toFtsQuery } from "../src/memory-store.js";

const dbs: Database.Database[] = [];
const stores: MemoryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }

  for (const db of dbs.splice(0)) {
    db.close();
  }
});

describe("MemoryStore", () => {
  it("searches facts through FTS5 and filters trust", () => {
    const dbPath = tempDbPath();

    const store = new MemoryStore(dbPath);
    stores.push(store);
    store.addFact({
      content: "Vara wallet supports IDL-aware calls",
      category: "project",
      tags: ["vara-wallet", "idl"],
      trustScore: 0.8
    });
    store.addFact({
      content: "Untrusted note about Vara wallet",
      category: "scratch",
      tags: ["vara-wallet"],
      trustScore: 0.1
    });

    const results = store.search("vara wallet idl", { limit: 10, minTrust: 0.3 });

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("Vara wallet supports IDL-aware calls");
  });

  it("falls back to entity-linked facts", () => {
    const dbPath = tempDbPath();
    const store = new MemoryStore(dbPath);
    stores.push(store);
    const result = store.addFact({
      content: "Entity-linked memory for OpenClaw",
      category: "project",
      trustScore: 0.7
    });
    store.close();
    stores.pop();
    insertEntity(dbPath, result.factId, "OpenClaw", "project", "oc");

    const readStore = new MemoryStore(dbPath);
    stores.push(readStore);

    const results = readStore.search("OpenClaw", { limit: 5, minTrust: 0.3 });

    expect(results[0]?.content).toBe("Entity-linked memory for OpenClaw");
  });

  it("creates a missing DB file and preserves duplicate facts", () => {
    const dbPath = tempDbPath();
    const store = new MemoryStore(dbPath);
    stores.push(store);

    const first = store.addFact({ content: "Paperclip owns a separate memory DB", trustScore: 0.4 });
    const second = store.addFact({
      content: "Paperclip owns a separate memory DB",
      category: "paperclip:workflow",
      tags: "paperclip,sqlite",
      trustScore: 0.8
    });

    expect(existsSync(dbPath)).toBe(true);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.factId).toBe(first.factId);
    expect(store.search("separate memory", { limit: 1 })[0]?.trustScore).toBe(0.4);
  });

  it("extracts entities, writes HRR vectors, and rebuilds category banks", () => {
    const dbPath = tempDbPath();
    const store = new MemoryStore(dbPath);
    stores.push(store);

    const result = store.addFact({
      content: 'OpenClaw uses "Vara Network" also known as Gear Protocol',
      category: "paperclip:workflow",
      trustScore: 0.7
    });

    expect(result.inserted).toBe(true);
    expect(store.probe("Vara Network", { limit: 5 })[0]?.factId).toBe(result.factId);

    const db = new Database(dbPath);
    dbs.push(db);
    const factRow = db.prepare("SELECT length(hrr_vector) AS len FROM facts WHERE fact_id = ?").get(result.factId) as {
      len: number;
    };
    const bankRow = db.prepare("SELECT fact_count, length(vector) AS len FROM memory_banks WHERE bank_name = ?").get(
      "cat:paperclip:workflow"
    ) as { fact_count: number; len: number };

    expect(factRow.len).toBe(8192);
    expect(bankRow.fact_count).toBe(1);
    expect(bankRow.len).toBe(8192);
  });

  it("increments retrieval count and records feedback", () => {
    const dbPath = tempDbPath();
    const store = new MemoryStore(dbPath);
    stores.push(store);
    const result = store.addFact({ content: "Paperclip agents recall durable memory", trustScore: 0.5 });

    expect(store.search("durable memory", { limit: 1 })[0]?.retrievalCount).toBe(0);
    expect(store.listFacts({ limit: 1 })[0]?.retrievalCount).toBe(1);

    const feedback = store.recordFeedback(result.factId, true);
    expect(feedback.oldTrust).toBe(0.5);
    expect(feedback.newTrust).toBe(0.55);
    expect(feedback.helpfulCount).toBe(1);
  });

  it("reasons across multiple entities", () => {
    const dbPath = tempDbPath();
    const store = new MemoryStore(dbPath);
    stores.push(store);

    store.addFact({ content: '"OpenClaw" integrates with "Vara Network"', trustScore: 0.7 });
    store.addFact({ content: '"OpenClaw" has local tests', trustScore: 0.7 });

    const results = store.reason(["OpenClaw", "Vara Network"], { limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("integrates");
  });

  it("escapes FTS query terms", () => {
    expect(toFtsQuery('paperclip "memory"')).toBe('"paperclip" OR "memory"');
  });

  it("extracts Hermes-style entities", () => {
    expect(extractEntities('OpenClaw uses "Vara Network" aka Gear Protocol')).toContain("Vara Network");
    expect(extractEntities("OpenClaw uses 'Sails IDL'")).toContain("Sails IDL");
  });

  it("counts facts", () => {
    const store = freshStore();
    expect(store.countFacts()).toBe(0);
    store.addFact({ content: "alpha" });
    store.addFact({ content: "beta" });
    expect(store.countFacts()).toBe(2);
  });

  describe("updateFact", () => {
    it("updates content, re-extracts entities, and recomputes HRR", () => {
      const store = freshStore();
      const dbPath = store.dbPath;
      const r = store.addFact({
        content: 'OpenClaw bonded to "Vara Network"',
        category: "project",
        trustScore: 0.6
      });

      const before = readVector(dbPath, r.factId);
      const result = store.updateFact(r.factId, {
        content: 'OpenClaw bonded to "Gear Protocol"'
      });
      expect(result).toEqual({ updated: true });

      const probe = store.probe("Gear Protocol", { limit: 5 });
      expect(probe[0]?.factId).toBe(r.factId);
      expect(store.probe("Vara Network", { limit: 5 })).toHaveLength(0);

      const after = readVector(dbPath, r.factId);
      expect(after).not.toBe(before);
    });

    it("applies trustDelta only and clamps to [0,1]", () => {
      const store = freshStore();
      const r = store.addFact({ content: "trust target", trustScore: 0.5 });

      expect(store.updateFact(r.factId, { trustDelta: 0.3 })).toEqual({ updated: true });
      expect(store.listFacts({ limit: 5 })[0]?.trustScore).toBeCloseTo(0.8, 5);

      expect(store.updateFact(r.factId, { trustDelta: 0.9 })).toEqual({ updated: true });
      expect(store.listFacts({ limit: 5 })[0]?.trustScore).toBe(1);

      expect(store.updateFact(r.factId, { trustDelta: -10 })).toEqual({ updated: true });
      expect(store.listFacts({ limit: 5 })[0]?.trustScore).toBe(0);
    });

    it("returns not_found when fact_id is unknown", () => {
      const store = freshStore();
      expect(store.updateFact(9999, { content: "x" })).toEqual({
        updated: false,
        reason: "not_found"
      });
    });

    it("rebuilds BOTH old and new banks on category change", () => {
      const store = freshStore();
      const dbPath = store.dbPath;
      const r1 = store.addFact({ content: "in old category", category: "old" });
      store.addFact({ content: "another in old", category: "old" });
      store.addFact({ content: "first in new", category: "new" });

      expect(bankCount(dbPath, "cat:old")).toBe(2);
      expect(bankCount(dbPath, "cat:new")).toBe(1);

      const result = store.updateFact(r1.factId, { category: "new" });
      expect(result).toEqual({ updated: true });

      expect(bankCount(dbPath, "cat:old")).toBe(1);
      expect(bankCount(dbPath, "cat:new")).toBe(2);
    });

    it("returns duplicate_content when content collides with another fact", () => {
      const store = freshStore();
      const a = store.addFact({ content: "fact a" });
      store.addFact({ content: "fact b" });

      const result = store.updateFact(a.factId, { content: "fact b" });
      expect(result).toEqual({ updated: false, reason: "duplicate_content" });

      // a's row is unchanged
      const after = store.listFacts({ limit: 10 }).find((f) => f.factId === a.factId);
      expect(after?.content).toBe("fact a");
    });

    it("rolls back the transaction when an inner write throws", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);

      const seed = store.addFact({ content: "stable", category: "general" });
      const beforeCount = store.countFacts();

      const spy = vi
        .spyOn(MemoryStore.prototype as any, "rebuildBank")
        .mockImplementationOnce(() => {
          throw new Error("boom");
        });

      expect(() =>
        store.updateFact(seed.factId, { content: "stable v2", category: "fresh" })
      ).toThrow("boom");

      // Verify rollback: row content + category unchanged.
      const row = store.listFacts({ limit: 10 }).find((f) => f.factId === seed.factId);
      expect(row?.content).toBe("stable");
      expect(row?.category).toBe("general");
      expect(store.countFacts()).toBe(beforeCount);

      spy.mockRestore();
    });
  });

  describe("removeFact", () => {
    it("hard-deletes the fact and its entity links", () => {
      const store = freshStore();
      const r = store.addFact({ content: 'remove me with "Some Entity"' });
      expect(store.probe("Some Entity", { limit: 5 })[0]?.factId).toBe(r.factId);

      const result = store.removeFact(r.factId);
      expect(result).toEqual({ removed: true });

      expect(store.search("remove", { limit: 5 })).toHaveLength(0);
      expect(store.probe("Some Entity", { limit: 5 })).toHaveLength(0);
    });

    it("returns removed:false when fact_id is unknown", () => {
      const store = freshStore();
      expect(store.removeFact(9999)).toEqual({ removed: false });
    });

    it("deletes the bank when removing the last fact in a category", () => {
      const store = freshStore();
      const r = store.addFact({ content: "only in solo", category: "solo" });

      expect(bankCount(store.dbPath, "cat:solo")).toBe(1);
      store.removeFact(r.factId);
      expect(bankRow(store.dbPath, "cat:solo")).toBeUndefined();
    });
  });

  describe("addFact transaction wrap", () => {
    it("rolls back on inner failure and leaves the store empty", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);

      const spy = vi
        .spyOn(MemoryStore.prototype as any, "computeHrrVector")
        .mockImplementationOnce(() => {
          throw new Error("encode fail");
        });

      expect(() => store.addFact({ content: "doomed write" })).toThrow("encode fail");
      expect(store.countFacts()).toBe(0);

      spy.mockRestore();
    });
  });

  describe("provenance columns (#11 / D11)", () => {
    it("schema shim is idempotent on a fresh DB (open twice)", () => {
      const dbPath = tempDbPath();
      const a = new MemoryStore(dbPath);
      a.addFact({ content: "first" });
      a.close();

      // Second open re-runs migrate() — must not throw or duplicate columns.
      const b = new MemoryStore(dbPath);
      stores.push(b);
      expect(b.countFacts()).toBe(1);

      const db = new Database(dbPath);
      dbs.push(db);
      const cols = (db.prepare("PRAGMA table_info(facts)").all() as { name: string }[]).map(
        (c) => c.name
      );
      // Each provenance column appears exactly once.
      expect(cols.filter((c) => c === "source")).toHaveLength(1);
      expect(cols.filter((c) => c === "agent_id")).toHaveLength(1);
      expect(cols.filter((c) => c === "run_id")).toHaveLength(1);
    });

    it("schema shim adds columns to an existing DB created without them", () => {
      const dbPath = tempDbPath();
      // Pre-create the facts table WITHOUT the new columns to simulate
      // an older schema in the wild.
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE facts (
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
        INSERT INTO facts (content) VALUES ('legacy fact');
      `);
      seed.close();

      // Opening the store runs migrate(), which should add the missing
      // provenance columns via ALTER TABLE.
      const store = new MemoryStore(dbPath);
      stores.push(store);

      const db = new Database(dbPath);
      dbs.push(db);
      const cols = new Set(
        (db.prepare("PRAGMA table_info(facts)").all() as { name: string }[]).map((c) => c.name)
      );
      expect(cols.has("source")).toBe(true);
      expect(cols.has("agent_id")).toBe(true);
      expect(cols.has("run_id")).toBe(true);
    });

    it("addFact persists source/agentId/runId and search round-trips them", () => {
      const store = freshStore();
      store.addFact({
        content: "auto-fact with provenance",
        category: "project",
        trustScore: 0.5,
        source: "auto",
        agentId: "agent-77",
        runId: "run-77"
      });

      const [hit] = store.search("auto-fact", { limit: 1, minTrust: 0 });
      expect(hit?.source).toBe("auto");
      expect(hit?.agentId).toBe("agent-77");
      expect(hit?.runId).toBe("run-77");
    });

    it("addFact without provenance fields leaves columns NULL (not undefined)", () => {
      const store = freshStore();
      store.addFact({ content: "curated fact, no provenance" });

      const [hit] = store.listFacts({ limit: 1, minTrust: 0 });
      // Explicit null check (C12): consumers can rely on `=== null`,
      // not have to remember `=== undefined`.
      expect(hit?.source).toBeNull();
      expect(hit?.agentId).toBeNull();
      expect(hit?.runId).toBeNull();
    });

    it("dedup on second addFact returns inserted:false even when provenance differs", () => {
      // C8 relocation: dedup is a MemoryStore concern, not auto-extract.
      const store = freshStore();
      const first = store.addFact({
        content: "we decided to use SQLite",
        category: "project",
        source: "auto",
        agentId: "agent-1",
        runId: "run-1"
      });
      const second = store.addFact({
        content: "we decided to use SQLite",
        category: "project",
        source: "auto",
        agentId: "agent-2",
        runId: "run-2"
      });
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.factId).toBe(first.factId);
    });
  });

  describe("search HRR + FTS blend", () => {
    it("normalizes FTS rank without NaN when only entity branch hits exist", () => {
      const store = freshStore();
      // No textual match for the query, but the entity matches.
      store.addFact({ content: '"Vara Network" entity-only fact', trustScore: 0.6 });
      store.addFact({ content: "completely unrelated cooking note", trustScore: 0.6 });

      const results = store.search("Vara Network", { limit: 5, minTrust: 0 });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toBeDefined();
      // Score must be a real finite number — divide-by-zero would produce NaN.
      const score = results[0]?.score ?? 0;
      expect(Number.isFinite(score)).toBe(true);
    });

    it("ranks the FTS-best (most negative rank) candidate ahead of weaker matches", () => {
      const store = freshStore();
      store.addFact({
        content: "vara wallet idl integration documented",
        category: "project",
        trustScore: 0.6
      });
      store.addFact({
        content: "wallet support added in the past",
        category: "project",
        trustScore: 0.6
      });

      const results = store.search("vara wallet idl", { limit: 5, minTrust: 0 });
      expect(results[0]?.content).toBe("vara wallet idl integration documented");
    });

    it("strips internal scoring fields (no hrrVector / ftsRankRaw on returned facts)", () => {
      const store = freshStore();
      store.addFact({ content: "leak guard", trustScore: 0.6 });

      const [first] = store.search("leak guard", { limit: 1, minTrust: 0 });
      expect(first).toBeDefined();
      expect(first as unknown as Record<string, unknown>).not.toHaveProperty("hrrVector");
      expect(first as unknown as Record<string, unknown>).not.toHaveProperty("ftsRankRaw");
    });
  });

  describe("cross-tenant scoping", () => {
    it("isolates search results by companyId, with NULL = global", () => {
      const store = freshStore();
      store.addFact({ content: "Company A: vara wallet decision", category: "project", trustScore: 0.8, companyId: "co-A" });
      store.addFact({ content: "Company B: vara wallet decision", category: "project", trustScore: 0.8, companyId: "co-B" });
      store.addFact({ content: "Global vara wallet primer", category: "project", trustScore: 0.8 });

      const aResults = store.search("vara wallet", { limit: 10, minTrust: 0.3, companyId: "co-A" });
      const aContent = aResults.map((f) => f.content).sort();
      expect(aContent).toEqual([
        "Company A: vara wallet decision",
        "Global vara wallet primer"
      ].sort());

      const bResults = store.search("vara wallet", { limit: 10, minTrust: 0.3, companyId: "co-B" });
      const bContent = bResults.map((f) => f.content).sort();
      expect(bContent).toEqual([
        "Company B: vara wallet decision",
        "Global vara wallet primer"
      ].sort());

      // Without companyId (server audit), every row is visible.
      const all = store.search("vara wallet", { limit: 10, minTrust: 0.3 });
      expect(all).toHaveLength(3);
    });

    it("throws on cross-tenant content collision", () => {
      // Shared-dbPath multi-tenant misuse only — see addFact comment.
      const store = freshStore();
      const a = store.addFact({ content: "Same fact text", category: "project", trustScore: 0.8, companyId: "co-A" });
      expect(a.inserted).toBe(true);
      expect(() =>
        store.addFact({ content: "Same fact text", category: "project", trustScore: 0.8, companyId: "co-B" })
      ).toThrow(/UNIQUE constraint failed/);
    });

    it("addFact returns existing factId when same (content, companyId) is re-inserted", () => {
      const store = freshStore();
      const first = store.addFact({ content: "Repeat fact", category: "project", companyId: "co-A" });
      expect(first.inserted).toBe(true);
      const again = store.addFact({ content: "Repeat fact", category: "project", companyId: "co-A" });
      expect(again.inserted).toBe(false);
      expect(again.factId).toBe(first.factId);
    });

    it("populates companyId on returned facts", () => {
      const store = freshStore();
      store.addFact({ content: "Tagged fact for co-A", category: "project", trustScore: 0.8, companyId: "co-A" });
      const [fact] = store.search("tagged", { limit: 5, minTrust: 0, companyId: "co-A" });
      expect(fact?.companyId).toBe("co-A");
    });

    it("listFacts honors companyId scope", () => {
      const store = freshStore();
      store.addFact({ content: "List A", category: "project", companyId: "co-A" });
      store.addFact({ content: "List B", category: "project", companyId: "co-B" });
      store.addFact({ content: "List global", category: "project" });

      const a = store.listFacts({ minTrust: 0, limit: 10, companyId: "co-A" });
      const aContent = a.map((f) => f.content).sort();
      expect(aContent).toEqual(["List A", "List global"].sort());
    });
  });

  describe("multi-process write contention (busy_timeout)", () => {
    it("opens two MemoryStore instances on the same DB without throwing", () => {
      const dbPath = tempDbPath();
      const a = new MemoryStore(dbPath);
      stores.push(a);
      a.addFact({ content: "first", category: "general" });

      const b = new MemoryStore(dbPath);
      stores.push(b);
      b.addFact({ content: "second", category: "general" });

      // Both writers shared the same DB; with WAL + busy_timeout=5000 no
      // SQLITE_BUSY surfaces on serialized writes from the same process tree.
      const facts = a.listFacts({ limit: 10, minTrust: 0 });
      expect(facts).toHaveLength(2);
    });

    it("reports busy_timeout pragma is set", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      const db = new Database(dbPath);
      dbs.push(db);
      const result = db.pragma("busy_timeout") as Array<{ timeout: number }>;
      expect(result[0]?.timeout).toBe(5000);
    });
  });

  // -------------------------------------------------------------------------
  // Trust decay over time (#8). Tests cover the pure decay helper, the SQL
  // unixepoch projection (TZ-safe), the scoring path, the read-side
  // last_accessed_at bump, the recordFeedback split, and the migration
  // fallback to created_at for legacy rows.
  // -------------------------------------------------------------------------
  describe("trust decay (#8)", () => {
    it("decayedTrust(): halfLife <= 0 returns trust unchanged (fast path)", () => {
      expect(decayedTrust(0.8, 30, 0)).toBe(0.8);
      expect(decayedTrust(0.8, 30, -1)).toBe(0.8);
    });

    it("decayedTrust(): ageDays = 0 returns trust unchanged", () => {
      expect(decayedTrust(0.8, 0, 90)).toBe(0.8);
    });

    it("decayedTrust(): ageDays = halfLife returns trust * 0.5", () => {
      expect(decayedTrust(0.8, 30, 30)).toBeCloseTo(0.4, 10);
    });

    it("decayedTrust(): many half-lives drives trust toward zero", () => {
      // ~33 half-lives → ~1.16e-10 of input
      expect(decayedTrust(0.8, 1000, 30)).toBeLessThan(1e-9);
    });

    it("CRITICAL REGRESSION: halfLifeDays = 0 preserves prior ranking", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      const fresh = store.addFact({ content: "alpha vara wallet idl", trustScore: 0.8 });
      const stale = store.addFact({ content: "beta vara wallet idl", trustScore: 0.6 });
      // Backdate the higher-trust fact 365 days. With halfLifeDays = 0
      // (default), age must not affect ranking — trust 0.8 still beats 0.6.
      const db = new Database(dbPath);
      dbs.push(db);
      db.prepare("UPDATE facts SET last_accessed_at = datetime('now', '-365 days') WHERE fact_id = ?")
        .run(fresh.factId);

      const results = store.search("vara wallet idl", { limit: 5, minTrust: 0, halfLifeDays: 0 });
      expect(results[0]?.factId).toBe(fresh.factId);
      expect(results[1]?.factId).toBe(stale.factId);
    });

    it("halfLifeDays > 0: stale fact ranks below fresh fact at same trust", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      const stale = store.addFact({ content: "alpha vara wallet idl", trustScore: 0.7 });
      const fresh = store.addFact({ content: "beta vara wallet idl", trustScore: 0.7 });
      const db = new Database(dbPath);
      dbs.push(db);
      // 60 days ≈ 2 half-lives at halfLifeDays=30 → ~0.25 of original trust.
      db.prepare("UPDATE facts SET last_accessed_at = datetime('now', '-60 days') WHERE fact_id = ?")
        .run(stale.factId);

      const results = store.search("vara wallet idl", { limit: 5, minTrust: 0, halfLifeDays: 30 });
      expect(results[0]?.factId).toBe(fresh.factId);
      expect(results[1]?.factId).toBe(stale.factId);
    });

    it("related() applies decay on its scored output", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      // Two facts referencing the same entity; same trust; one aged out.
      const stale = store.addFact({
        content: '"OpenClaw" stale relationship note',
        trustScore: 0.7
      });
      const fresh = store.addFact({
        content: '"OpenClaw" fresh relationship note',
        trustScore: 0.7
      });
      const db = new Database(dbPath);
      dbs.push(db);
      db.prepare("UPDATE facts SET last_accessed_at = datetime('now', '-90 days') WHERE fact_id = ?")
        .run(stale.factId);

      const results = store.related("OpenClaw", { limit: 5, minTrust: 0, halfLifeDays: 30 });
      expect(results.length).toBeGreaterThanOrEqual(1);
      // Fresh outranks stale once decay is on.
      const idxFresh = results.findIndex((r) => r.factId === fresh.factId);
      const idxStale = results.findIndex((r) => r.factId === stale.factId);
      if (idxFresh >= 0 && idxStale >= 0) {
        expect(idxFresh).toBeLessThan(idxStale);
      }
    });

    it("TZ correctness: unixepoch projection is independent of process.env.TZ", () => {
      // SQLite's CURRENT_TIMESTAMP emits "YYYY-MM-DD HH:MM:SS" in UTC with no
      // marker. Date.parse treats that as local time and silently shifts
      // ages by the local TZ offset. The unixepoch projection in the SELECT
      // sidesteps this — running the same scoring under a non-UTC TZ must
      // produce identical results.
      const ageDaysAt = (tz: string): number => {
        const prev = process.env.TZ;
        process.env.TZ = tz;
        try {
          // Fixed nowSec and lastTouched — values are in UTC seconds, JS
          // does not interpret them as wall-clock strings, so the helper
          // must be TZ-invariant.
          const nowSec = 1_700_000_000;
          const lastTouched = nowSec - 30 * 86400;
          return ageDaysFromUnix(lastTouched, nowSec);
        } finally {
          process.env.TZ = prev;
        }
      };
      expect(ageDaysAt("UTC")).toBe(30);
      expect(ageDaysAt("Asia/Tbilisi")).toBe(30);
      expect(ageDaysAt("America/Los_Angeles")).toBe(30);
    });

    it("probe() does NOT apply decay (raw trust ordering preserved)", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      // Two entity-linked facts; the higher-trust one is also stale.
      const staleHighTrust = store.addFact({
        content: '"GearProtocol" canonical reference',
        trustScore: 0.9
      });
      store.addFact({
        content: '"GearProtocol" recent low-trust note',
        trustScore: 0.3
      });
      const db = new Database(dbPath);
      dbs.push(db);
      db.prepare("UPDATE facts SET last_accessed_at = datetime('now', '-365 days') WHERE fact_id = ?")
        .run(staleHighTrust.factId);

      // probe routes through searchEntities ORDER BY trust_score DESC. Even
      // if the caller could request decay, probe currently does not pass
      // halfLifeDays through to the scoring path — by design.
      const results = store.probe("GearProtocol", { limit: 5, minTrust: 0, halfLifeDays: 30 });
      expect(results[0]?.factId).toBe(staleHighTrust.factId);
    });

    it("search() bumps last_accessed_at on returned facts", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      const added = store.addFact({ content: "alpha read-bump test", trustScore: 0.8 });
      const db = new Database(dbPath);
      dbs.push(db);
      db.prepare("UPDATE facts SET last_accessed_at = NULL WHERE fact_id = ?").run(added.factId);

      store.search("alpha read-bump test", { limit: 1, minTrust: 0 });

      const row = db
        .prepare("SELECT last_accessed_at FROM facts WHERE fact_id = ?")
        .get(added.factId) as { last_accessed_at: string | null };
      expect(row.last_accessed_at).not.toBeNull();
    });

    it("recordFeedback(helpful=true) bumps last_accessed_at", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      const added = store.addFact({ content: "feedback positive bump", trustScore: 0.5 });
      const db = new Database(dbPath);
      dbs.push(db);
      db.prepare("UPDATE facts SET last_accessed_at = NULL WHERE fact_id = ?").run(added.factId);

      store.recordFeedback(added.factId, true);

      const row = db
        .prepare("SELECT last_accessed_at FROM facts WHERE fact_id = ?")
        .get(added.factId) as { last_accessed_at: string | null };
      expect(row.last_accessed_at).not.toBeNull();
    });

    it("EDGE CASE: recordFeedback(helpful=false) does NOT bump last_accessed_at", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      const added = store.addFact({ content: "feedback negative no-bump", trustScore: 0.5 });
      const db = new Database(dbPath);
      dbs.push(db);
      // Force a known-stale timestamp so we can detect any unwanted touch.
      db.prepare("UPDATE facts SET last_accessed_at = datetime('now', '-30 days') WHERE fact_id = ?")
        .run(added.factId);
      const before = (
        db.prepare("SELECT last_accessed_at FROM facts WHERE fact_id = ?").get(added.factId) as {
          last_accessed_at: string;
        }
      ).last_accessed_at;

      store.recordFeedback(added.factId, false);

      const after = (
        db.prepare("SELECT last_accessed_at FROM facts WHERE fact_id = ?").get(added.factId) as {
          last_accessed_at: string;
        }
      ).last_accessed_at;
      expect(after).toBe(before);
    });

    it("minTrust filters facts whose effective (decayed) trust drops below the threshold", () => {
      // Fact has raw trust 0.7 — passes the SQL gate at minTrust=0.3 — but
      // after 90d at halfLife=30 (3 half-lives) its effective trust is
      // ~0.0875, well below the cutoff. Without the post-decay filter the
      // fact would still surface; with it, search returns empty.
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      const stale = store.addFact({ content: "alpha effective minTrust filter", trustScore: 0.7 });
      const db = new Database(dbPath);
      dbs.push(db);
      db.prepare("UPDATE facts SET last_accessed_at = datetime('now', '-90 days') WHERE fact_id = ?")
        .run(stale.factId);

      const results = store.search("alpha effective minTrust filter", {
        limit: 5,
        minTrust: 0.3,
        halfLifeDays: 30,
      });
      expect(results).toHaveLength(0);

      // Same query with decay disabled returns the fact (raw trust 0.7 > 0.3).
      const baseline = store.search("alpha effective minTrust filter", {
        limit: 5,
        minTrust: 0.3,
        halfLifeDays: 0,
      });
      expect(baseline).toHaveLength(1);
    });

    it("related() applies the same effective-minTrust filter and tie-breakers as search()", () => {
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      // Two related facts at trust 0.7; one is decayed past minTrust.
      const stale = store.addFact({
        content: '"BetaProtocol" stale entry',
        trustScore: 0.7,
      });
      const fresh = store.addFact({
        content: '"BetaProtocol" fresh entry',
        trustScore: 0.7,
      });
      const db = new Database(dbPath);
      dbs.push(db);
      db.prepare("UPDATE facts SET last_accessed_at = datetime('now', '-90 days') WHERE fact_id = ?")
        .run(stale.factId);

      const results = store.related("BetaProtocol", {
        limit: 5,
        minTrust: 0.3,
        halfLifeDays: 30,
      });
      // Stale fact (effective trust ~0.0875) filtered out; fresh remains.
      expect(results.find((f) => f.factId === stale.factId)).toBeUndefined();
      expect(results.find((f) => f.factId === fresh.factId)).toBeDefined();
    });

    it("over-fetches candidates when decay is enabled so stale top-rank matches don't starve fresh matches", () => {
      // Codex PR review caught: with halfLifeDays=0 the SQL pre-fetch caps at
      // limit*3 candidates, which is fine. With decay on and many top-rank
      // matches stale, that cap can wipe the entire candidate pool via the
      // post-decay filter — fresh rows beyond the cap never get a chance.
      // Verify search returns the fresh rows when 30 stale ones come first
      // in FTS rank order with a limit of 5.
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);

      const staleIds: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        staleIds.push(
          store.addFact({ content: `stale candidate alpha bravo ${i}`, trustScore: 0.7 }).factId,
        );
      }
      const freshIds: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        freshIds.push(
          store.addFact({ content: `fresh candidate alpha bravo ${i}`, trustScore: 0.7 }).factId,
        );
      }

      const db = new Database(dbPath);
      dbs.push(db);
      const placeholders = staleIds.map(() => "?").join(",");
      db.prepare(
        `UPDATE facts SET last_accessed_at = datetime('now', '-365 days') WHERE fact_id IN (${placeholders})`,
      ).run(...staleIds);

      const results = store.search("alpha bravo", {
        limit: 5,
        minTrust: 0.3,
        halfLifeDays: 30,
      });
      // All 5 fresh rows should be returned. Without the wider candidate
      // pool, the top-15 (limit*3) would have been the stale rows, all
      // filtered out, and `results` would have been empty.
      expect(results).toHaveLength(5);
      for (const r of results) {
        expect(freshIds).toContain(r.factId);
      }
    });

    it("migration: legacy rows without last_accessed_at decay from created_at via COALESCE", () => {
      // Open a DB with the modern schema (so migrate() runs), insert a row,
      // then NULL out last_accessed_at and backdate created_at to simulate a
      // pre-migration row. Decay should then key off created_at.
      const dbPath = tempDbPath();
      const store = new MemoryStore(dbPath);
      stores.push(store);
      const stale = store.addFact({ content: "alpha legacy migration", trustScore: 0.7 });
      const fresh = store.addFact({ content: "beta legacy migration", trustScore: 0.7 });
      const db = new Database(dbPath);
      dbs.push(db);
      // Stale row: no last_accessed_at, but created 90 days ago (2 half-lives).
      db.prepare(
        "UPDATE facts SET last_accessed_at = NULL, created_at = datetime('now', '-90 days') WHERE fact_id = ?"
      ).run(stale.factId);

      const results = store.search("legacy migration", { limit: 5, minTrust: 0, halfLifeDays: 30 });
      // Fresh outranks stale because COALESCE picked up the backdated created_at.
      expect(results[0]?.factId).toBe(fresh.factId);
      expect(results[1]?.factId).toBe(stale.factId);
    });
  });
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "holographic-memory-"));
  return path.join(dir, "memory.db");
}

function freshStore(): MemoryStore {
  const store = new MemoryStore(tempDbPath());
  stores.push(store);
  return store;
}

function readVector(dbPath: string, factId: number): string | null {
  const db = new Database(dbPath);
  dbs.push(db);
  const row = db.prepare("SELECT hex(hrr_vector) AS v FROM facts WHERE fact_id = ?").get(factId) as
    | { v: string | null }
    | undefined;
  return row?.v ?? null;
}

function bankRow(dbPath: string, bankName: string): { fact_count: number } | undefined {
  const db = new Database(dbPath);
  dbs.push(db);
  return db
    .prepare("SELECT fact_count FROM memory_banks WHERE bank_name = ?")
    .get(bankName) as { fact_count: number } | undefined;
}

function bankCount(dbPath: string, bankName: string): number {
  return bankRow(dbPath, bankName)?.fact_count ?? 0;
}

function insertEntity(dbPath: string, factId: number, name: string, type: string, aliases: string): void {
  const db = new Database(dbPath);
  dbs.push(db);

  const result = db
    .prepare("INSERT INTO entities (name, entity_type, aliases) VALUES (?, ?, ?)")
    .run(name, type, aliases);
  db.prepare("INSERT INTO fact_entities (fact_id, entity_id) VALUES (?, ?)").run(
    factId,
    Number(result.lastInsertRowid)
  );
}
