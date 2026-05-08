import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { handleRunStarted } from "../src/worker.js";

function scopeKeyId(scope: { scopeKind: string; scopeId: string; namespace?: string; stateKey: string }): string {
  return `${scope.scopeKind}:${scope.scopeId}:${scope.namespace ?? "default"}:${scope.stateKey}`;
}

describe("worker", () => {
  it("writes recall state under run/issue/agent scopes", async () => {
    const dbPath = createDb();
    const state = new Map<string, unknown>();
    const ctx = {
      issues: {
        get: async () => ({
          title: "Vara wallet IDL",
          description: "Need context on IDL-aware calls."
        })
      },
      state: {
        set: async (scope: { scopeKind: string; scopeId: string; namespace?: string; stateKey: string }, value: unknown) =>
          state.set(scopeKeyId(scope), value)
      }
    };

    const result = await handleRunStarted(
      ctx,
      { issueId: "issue-1", runId: "run-1", agentId: "agent-1" },
      {
        dbPath,
        recallEnabled: true,
        retainEnabled: false,
        minTrustScore: 0.3,
        maxFactsPerRecall: 10
      }
    );

    expect(result?.formatted).toContain("MEMORY CONTEXT:");
    expect(result?.formatted).toContain("Vara wallet supports IDL-aware calls");
    expect(state.has("run:run-1:recall:context")).toBe(true);
    expect(state.has("issue:issue-1:recall:context")).toBe(true);
    expect(state.has("agent:agent-1:recall:context")).toBe(true);
  });
});

function createDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "holographic-worker-"));
  const dbPath = path.join(dir, "memory.db");
  const db = new Database(dbPath);

  db.exec(`
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
    CREATE VIRTUAL TABLE facts_fts USING fts5(content, tags, content=facts, content_rowid=fact_id);
    CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, content, tags) VALUES (new.fact_id, new.content, new.tags);
    END;
    CREATE TABLE entities (
      entity_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      entity_type TEXT DEFAULT 'unknown',
      aliases TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE fact_entities (
      fact_id INTEGER REFERENCES facts(fact_id),
      entity_id INTEGER REFERENCES entities(entity_id),
      PRIMARY KEY (fact_id, entity_id)
    );
    INSERT INTO facts (content, category, tags, trust_score)
      VALUES ('Vara wallet supports IDL-aware calls', 'project', 'vara-wallet,idl', 0.8);
  `);
  db.close();

  return dbPath;
}
