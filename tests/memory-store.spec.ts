import Database from "better-sqlite3";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractEntities, MemoryStore, toFtsQuery } from "../src/memory-store.js";

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
