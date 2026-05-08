import Database from "better-sqlite3";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "holographic-memory-"));
  return path.join(dir, "memory.db");
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
