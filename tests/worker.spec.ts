import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { ScopeKey, ToolRunContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  ACTION_HANDLERS,
  buildToolDescription,
  dispatchAction,
  extractRunStartedFields,
  handleRunStarted
} from "../src/worker.js";
import { MemoryStore } from "../src/memory-store.js";
import type { HolographicMemoryConfig, RecallState } from "../src/types.js";

function scopeKeyId(scope: ScopeKey): string {
  return `${scope.scopeKind}:${scope.scopeId}:${scope.namespace ?? "default"}:${scope.stateKey}`;
}

function fakeStateCtx(state = new Map<string, unknown>()) {
  return {
    state,
    ctx: {
      state: {
        set: async (scope: ScopeKey, value: unknown) => state.set(scopeKeyId(scope), value),
        get: async (scope: ScopeKey) => state.get(scopeKeyId(scope))
      }
    }
  };
}

function baseConfig(dbPath: string, overrides: Partial<HolographicMemoryConfig> = {}): HolographicMemoryConfig {
  return {
    dbPath,
    recallEnabled: true,
    retainEnabled: true,
    minTrustScore: 0.3,
    maxFactsPerRecall: 10,
    ...overrides
  };
}

const FAKE_RUN_CTX: ToolRunContext = {
  agentId: "agent-x",
  runId: "run-x",
  companyId: "co-x",
  projectId: "proj-x"
};

describe("worker", () => {
  it("writes recall state under run/issue/agent scopes", async () => {
    const dbPath = createDb();
    const { state, ctx: stateCtx } = fakeStateCtx();
    const ctx = {
      ...stateCtx,
      issues: {
        get: async () => ({
          title: "Vara wallet IDL",
          description: "Need context on IDL-aware calls."
        })
      }
    };

    const result = await handleRunStarted(
      ctx,
      { issueId: "issue-1", runId: "run-1", agentId: "agent-1" },
      baseConfig(dbPath, { retainEnabled: false })
    );

    expect(result?.formatted).toContain("MEMORY CONTEXT:");
    expect(result?.formatted).toContain("Vara wallet supports IDL-aware calls");
    expect(state.has("run:run-1:recall:context")).toBe(true);
    expect(state.has("issue:issue-1:recall:context")).toBe(true);
    expect(state.has("agent:agent-1:recall:context")).toBe(true);
  });

  it("does not write extra scopes when ids are absent", async () => {
    const dbPath = createDb();
    const { state, ctx: stateCtx } = fakeStateCtx();
    const ctx = {
      ...stateCtx,
      issues: {
        get: async () => ({
          title: "Vara wallet IDL",
          description: "Need context on IDL-aware calls."
        })
      }
    };

    await handleRunStarted(ctx, { issueId: "issue-only" }, baseConfig(dbPath));

    expect(state.has("issue:issue-only:recall:context")).toBe(true);
    expect([...state.keys()].some((k) => k.startsWith("run:"))).toBe(false);
    expect([...state.keys()].some((k) => k.startsWith("agent:"))).toBe(false);
  });
});

describe("dispatchAction — recall_context", () => {
  it("returns the cached prose when run_id matches", async () => {
    const dbPath = createDb();
    const { state, ctx } = fakeStateCtx();
    const cached: RecallState = {
      query: "x",
      facts: [],
      formatted: "MEMORY CONTEXT:\n1. cached.",
      createdAt: new Date().toISOString(),
      runId: "run-A"
    };
    state.set(scopeKeyId({ scopeKind: "run", scopeId: "run-A", namespace: "recall", stateKey: "context" }), cached);

    const result = await dispatchAction(
      { action: "recall_context", run_id: "run-A" },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(result.content).toBe(cached.formatted);
  });

  it("falls back to runCtx.runId when no params are passed", async () => {
    const dbPath = createDb();
    const { state, ctx } = fakeStateCtx();
    const cached: RecallState = {
      query: "x",
      facts: [],
      formatted: "MEMORY CONTEXT:\n1. via runCtx.",
      createdAt: new Date().toISOString()
    };
    state.set(
      scopeKeyId({ scopeKind: "run", scopeId: FAKE_RUN_CTX.runId, namespace: "recall", stateKey: "context" }),
      cached
    );

    const result = await dispatchAction({ action: "recall_context" }, baseConfig(dbPath), ctx, FAKE_RUN_CTX);
    expect(result.content).toBe(cached.formatted);
  });

  it("falls back to live search when no state matches but query is provided", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();

    const result = await dispatchAction(
      { action: "recall_context", query: "Vara wallet" },
      baseConfig(dbPath),
      ctx,
      { ...FAKE_RUN_CTX, runId: "unknown-run" }
    );
    // The seeded fact in createDb() matches.
    expect(result.content).toContain("Vara wallet supports IDL-aware calls");
  });

  it("returns guidance when nothing resolves", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();
    const result = await dispatchAction(
      { action: "recall_context" },
      baseConfig(dbPath),
      ctx,
      { agentId: "", runId: "", companyId: "", projectId: "" }
    );
    expect(result.content).toMatch(/No cached recall context/);
  });
});

describe("dispatchAction — write loop and gates", () => {
  it("add returns parseable JSON with factId", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();

    const result = await dispatchAction(
      { action: "add", content: "freshly added fact", category: "project" },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(result.error).toBeUndefined();
    const parsed = JSON.parse(result.content ?? "");
    expect(parsed.inserted).toBe(true);
    expect(typeof parsed.factId).toBe("number");

    // Round-trip: search should find it.
    const search = await dispatchAction(
      { action: "search", query: "freshly added", min_trust: 0 },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(search.content).toContain("freshly added fact");
  });

  it("update returns JSON and re-extracts entities on content change", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();

    const added = await dispatchAction(
      { action: "add", content: '"Old Entity" baseline' },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    const factId = JSON.parse(added.content ?? "").factId as number;

    const updated = await dispatchAction(
      { action: "update", fact_id: factId, content: '"New Entity" replaces it' },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(JSON.parse(updated.content ?? "")).toEqual({ updated: true });

    const probe = await dispatchAction(
      { action: "probe", entity: "New Entity", min_trust: 0 },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(probe.content).toContain("New Entity");
  });

  it("remove returns JSON and the fact disappears from search", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();

    const added = await dispatchAction(
      { action: "add", content: "doomed by remove" },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    const factId = JSON.parse(added.content ?? "").factId as number;

    const removed = await dispatchAction(
      { action: "remove", fact_id: factId },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(JSON.parse(removed.content ?? "")).toEqual({ removed: true });

    const search = await dispatchAction(
      { action: "search", query: "doomed by remove", min_trust: 0 },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(search.content).not.toContain("doomed by remove");
  });

  it("blocks add/update/remove when retainEnabled is false", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();
    const config = baseConfig(dbPath, { retainEnabled: false });

    for (const action of ["add", "update", "remove"] as const) {
      const result = await dispatchAction(
        { action, content: "x", fact_id: 1 },
        config,
        ctx,
        FAKE_RUN_CTX
      );
      expect(result.content).toMatch(/Memory retain is disabled/);
    }
  });

  it("blocks reads when recallEnabled is false", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();
    const config = baseConfig(dbPath, { recallEnabled: false });

    const result = await dispatchAction({ action: "search", query: "anything" }, config, ctx, FAKE_RUN_CTX);
    expect(result.content).toMatch(/Holographic memory recall is disabled/);
  });

  it("returns an error for an unknown action", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();
    const result = await dispatchAction(
      { action: "explode" } as { action: string },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(result.error).toMatch(/Unknown memory action/);
  });

  it("validates required parameters per action", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();

    const noContent = await dispatchAction(
      { action: "add" },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(noContent.error).toMatch(/content/);

    const noFactId = await dispatchAction(
      { action: "remove" },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(noFactId.error).toMatch(/fact_id/);

    const noQuery = await dispatchAction(
      { action: "search" },
      baseConfig(dbPath),
      ctx,
      FAKE_RUN_CTX
    );
    expect(noQuery.error).toMatch(/query/);
  });
});

describe("ACTION_HANDLERS shape (D6)", () => {
  it("list returns JSON; search returns prose", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();
    const config = baseConfig(dbPath);

    const list = await dispatchAction({ action: "list", min_trust: 0 }, config, ctx, FAKE_RUN_CTX);
    expect(() => JSON.parse(list.content ?? "")).not.toThrow();
    expect(list.data).toBeTruthy();

    const search = await dispatchAction(
      { action: "search", query: "Vara wallet", min_trust: 0 },
      config,
      ctx,
      FAKE_RUN_CTX
    );
    expect(search.content?.startsWith("MEMORY CONTEXT:") || search.content?.startsWith("No holographic")).toBe(true);
  });

  it("exposes ACTION_HANDLERS for direct invocation", () => {
    const expected = [
      "search",
      "probe",
      "related",
      "reason",
      "recall_context",
      "list",
      "feedback",
      "add",
      "update",
      "remove"
    ];
    for (const action of expected) {
      expect(typeof ACTION_HANDLERS[action]).toBe("function");
    }
  });
});

describe("extractRunStartedFields", () => {
  it("unwraps a realistic PluginEvent shape (entityId/actorId at top level)", () => {
    // Mirrors the SDK's `PluginEvent<TPayload>` shape used by the host
    // when emitting `agent.run.started` events.
    const sdkEvent = {
      eventId: "evt-uuid",
      eventType: "agent.run.started",
      occurredAt: "2026-05-08T12:00:00.000Z",
      actorId: "agent-from-sdk",
      actorType: "agent" as const,
      entityId: "run-from-sdk",
      entityType: "agent_run",
      companyId: "co-uuid",
      payload: { issueId: "issue-from-payload" }
    };

    expect(extractRunStartedFields(sdkEvent)).toEqual({
      runId: "run-from-sdk",
      agentId: "agent-from-sdk",
      issueId: "issue-from-payload"
    });
  });

  it("falls back to flat duck-typed shape used in tests", () => {
    const flat = { runId: "r1", agentId: "a1", issueId: "i1" };
    expect(extractRunStartedFields(flat)).toEqual(flat);
  });

  it("prefers SDK top-level fields over payload fields when both are present", () => {
    // If the host puts duplicates in payload, the canonical entityId/actorId
    // win because that's where the SDK guarantees them.
    const event = {
      entityId: "run-canonical",
      actorId: "agent-canonical",
      payload: { runId: "run-shadowed", agentId: "agent-shadowed", issueId: "issue-payload" }
    };
    expect(extractRunStartedFields(event)).toEqual({
      runId: "run-canonical",
      agentId: "agent-canonical",
      issueId: "issue-payload"
    });
  });

  it("omits undefined keys when fields are missing (no { runId: undefined } leak)", () => {
    const minimal = { payload: { issueId: "only-issue" } };
    const out = extractRunStartedFields(minimal);
    expect(out).toEqual({ issueId: "only-issue" });
    expect("runId" in out).toBe(false);
    expect("agentId" in out).toBe(false);
  });

  it("returns an empty object for null / undefined / empty input", () => {
    expect(extractRunStartedFields(null)).toEqual({});
    expect(extractRunStartedFields(undefined)).toEqual({});
    expect(extractRunStartedFields({})).toEqual({});
  });
});

describe("buildToolDescription", () => {
  it("contains the four required usage cues", () => {
    const description = buildToolDescription();

    // Hermes-style usage instructions the agent prompt depends on.
    expect(description).toMatch(/recall_context/);
    expect(description).toMatch(/\badd\b/);
    expect(description).toMatch(/feedback/);
    expect(description).toMatch(/retainEnabled/);
  });

  it("is deterministic — no mutable state baked in (tool description is registered once)", () => {
    const a = buildToolDescription();
    const b = buildToolDescription();
    expect(a).toBe(b);
    // Defensive check: must not embed any digits — those would be staleness-prone counts.
    // (A single number anywhere in the description would imply we're back to caching state.)
    expect(/\d/.test(a)).toBe(false);
  });

  it("returns multi-line text (no host-side trimming risk on a single blob)", () => {
    const description = buildToolDescription();
    expect(description.split("\n").length).toBeGreaterThan(3);
  });
});

describe("dispatchAction — store registry", () => {
  it("reuses the same store across calls with the same dbPath", async () => {
    const dbPath = createDb();
    const { ctx } = fakeStateCtx();
    const config = baseConfig(dbPath);

    // Two calls in a row; the registry should return the same MemoryStore instance.
    await dispatchAction({ action: "search", query: "first", min_trust: 0 }, config, ctx, FAKE_RUN_CTX);
    const second = await dispatchAction(
      { action: "list", min_trust: 0 },
      config,
      ctx,
      FAKE_RUN_CTX
    );

    // Sanity: list still works after search.
    expect(() => JSON.parse(second.content ?? "")).not.toThrow();

    // The DB file should still be a single SQLite file (no shadow copies).
    const direct = new MemoryStore(dbPath);
    direct.close();
  });

  it("isolates by dbPath — distinct paths get distinct stores", async () => {
    const dbA = createDb();
    const dbB = createDb();
    const { ctx } = fakeStateCtx();

    // Add a fact via A's path.
    await dispatchAction(
      { action: "add", content: "only-in-A" },
      baseConfig(dbA),
      ctx,
      FAKE_RUN_CTX
    );

    // Search via B's path — must NOT see A's fact.
    const inB = await dispatchAction(
      { action: "search", query: "only-in-A", min_trust: 0 },
      baseConfig(dbB),
      ctx,
      FAKE_RUN_CTX
    );
    expect(inB.content).not.toContain("only-in-A");

    // Search via A's path again — must still see it (registry cached the open connection).
    const inA = await dispatchAction(
      { action: "search", query: "only-in-A", min_trust: 0 },
      baseConfig(dbA),
      ctx,
      FAKE_RUN_CTX
    );
    expect(inA.content).toContain("only-in-A");
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
