import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeStores,
  dispatchStandaloneAction,
  getStore,
  handleAdd,
  handleSearch,
} from "../src/dispatch.js";
import { writeRecallCache } from "../src/recall-cache.js";
import type { HolographicMemoryConfig, RecallState } from "../src/types.js";
import { baseConfig, fakeRunCtx, tempDb } from "./helpers.js";
import type { MemoryStore } from "../src/memory-store.js";

afterEach(() => {
  closeStores();
});

describe("dispatchStandaloneAction — read actions", () => {
  it("search returns no-match text on empty store", async () => {
    const config = baseConfig(tempDb());
    const result = await dispatchStandaloneAction({ action: "search", query: "anything" }, config);
    expect(result.content).toContain("No holographic memory facts");
    expect(result.error).toBeUndefined();
  });

  it("search reports missing query", async () => {
    const config = baseConfig(tempDb());
    const result = await dispatchStandaloneAction({ action: "search" }, config);
    expect(result.error).toBe("Missing required parameter: query");
  });

  it("list returns JSON shape with count", async () => {
    const config = baseConfig(tempDb());
    const result = await dispatchStandaloneAction({ action: "list", min_trust: 0 }, config);
    const parsed = JSON.parse(result.content);
    expect(parsed).toEqual({ facts: [], count: 0 });
    expect(result.data).toEqual({ facts: [], count: 0 });
  });

  it("probe and related require entity", async () => {
    const config = baseConfig(tempDb());
    expect((await dispatchStandaloneAction({ action: "probe" }, config)).error).toMatch(/entity/);
    expect((await dispatchStandaloneAction({ action: "related" }, config)).error).toMatch(/entity/);
  });

  it("reason rejects empty entities", async () => {
    const config = baseConfig(tempDb());
    const result = await dispatchStandaloneAction({ action: "reason", entities: [] }, config);
    expect(result.error).toBe("Missing required parameter: entities");
  });
});

describe("dispatchStandaloneAction — write actions", () => {
  it("add round-trips and search finds it", async () => {
    const config = baseConfig(tempDb());
    const added = await dispatchStandaloneAction(
      { action: "add", content: "Vara wallet supports IDL-aware calls", category: "project", tags: "vara,wallet" },
      config,
    );
    expect(added.error).toBeUndefined();
    const data = JSON.parse(added.content);
    expect(data.factId).toBeGreaterThan(0);

    const search = await dispatchStandaloneAction({ action: "search", query: "vara wallet IDL", min_trust: 0 }, config);
    expect(search.content).toContain("Vara wallet supports IDL-aware calls");
  });

  it("add is idempotent on identical content", async () => {
    const config = baseConfig(tempDb());
    const first = JSON.parse((await dispatchStandaloneAction({ action: "add", content: "dup" }, config)).content);
    const second = JSON.parse((await dispatchStandaloneAction({ action: "add", content: "dup" }, config)).content);
    expect(second.factId).toBe(first.factId);
    expect(second.inserted).toBe(false);
  });

  it("update + remove round-trip", async () => {
    const config = baseConfig(tempDb());
    const added = JSON.parse((await dispatchStandaloneAction({ action: "add", content: "stale fact" }, config)).content);
    const updated = JSON.parse(
      (await dispatchStandaloneAction({ action: "update", fact_id: added.factId, content: "fresh fact" }, config))
        .content,
    );
    expect(updated.updated).toBe(true);
    const removed = JSON.parse(
      (await dispatchStandaloneAction({ action: "remove", fact_id: added.factId }, config)).content,
    );
    expect(removed.removed).toBe(true);
  });

  it("feedback updates trust", async () => {
    const config = baseConfig(tempDb());
    const added = JSON.parse((await dispatchStandaloneAction({ action: "add", content: "fb fact" }, config)).content);
    const fb = JSON.parse(
      (await dispatchStandaloneAction({ action: "feedback", fact_id: added.factId, helpful: true }, config)).content,
    );
    expect(fb.factId).toBe(added.factId);
    expect(fb.newTrust).toBeGreaterThan(fb.oldTrust);
  });

  it("write actions report missing fact_id", async () => {
    const config = baseConfig(tempDb());
    expect((await dispatchStandaloneAction({ action: "update" }, config)).error).toMatch(/fact_id/);
    expect((await dispatchStandaloneAction({ action: "remove" }, config)).error).toMatch(/fact_id/);
  });

  it("add requires content", async () => {
    const config = baseConfig(tempDb());
    expect((await dispatchStandaloneAction({ action: "add" }, config)).error).toMatch(/content/);
  });
});

describe("dispatchStandaloneAction — gates", () => {
  it("read actions are blocked when recallEnabled=false", async () => {
    const config = baseConfig(tempDb(), { recallEnabled: false });
    const result = await dispatchStandaloneAction({ action: "search", query: "x" }, config);
    expect(result.content).toMatch(/recall is disabled/);
    expect(result.error).toBeUndefined();
  });

  it("write actions are blocked when retainEnabled=false", async () => {
    const config = baseConfig(tempDb(), { retainEnabled: false });
    const result = await dispatchStandaloneAction({ action: "add", content: "x" }, config);
    expect(result.content).toMatch(/retain is disabled/);
  });

  it("feedback is gated by retainEnabled (mutates trust_score)", async () => {
    // Codex caught this: feedback writes to the DB (trust_score / helpful_count
    // / updated_at via MemoryStore.recordFeedback) but used to be classified
    // as a read action. With retainEnabled=false the call must now be blocked.
    const config = baseConfig(tempDb(), { retainEnabled: false });
    const result = await dispatchStandaloneAction(
      { action: "feedback", fact_id: 1, helpful: true },
      config,
    );
    expect(result.content).toMatch(/retain is disabled/);
  });

  it("unknown action returns error", async () => {
    const config = baseConfig(tempDb());
    const result = await dispatchStandaloneAction({ action: "bogus" }, config);
    expect(result.error).toBe("Unknown memory action: bogus");
  });

  it("search propagates trustHalfLifeDays from config (decay applied end-to-end)", async () => {
    // Verify the dispatch → readOptions → store.search path actually carries
    // halfLifeDays. We set up a stale + fresh fact at the same trust, enable
    // a 30-day half-life via config, and confirm the dispatched search
    // returns fresh-first. Without the propagation, the order would collapse
    // back to insertion order at trust 0.7 (tie-break by factId).
    const config = baseConfig(tempDb(), { trustHalfLifeDays: 30, retainEnabled: true });
    const store = getStore(config);
    const stale = store.addFact({ content: "alpha decay propagation", trustScore: 0.7 });
    const fresh = store.addFact({ content: "beta decay propagation", trustScore: 0.7 });
    backdateLastAccessed(config.dbPath, stale.factId, 90);

    const result = await dispatchStandaloneAction(
      { action: "search", query: "decay propagation", min_trust: 0 },
      config,
    );
    const idxFresh = result.content.indexOf(`id=${fresh.factId};`);
    const idxStale = result.content.indexOf(`id=${stale.factId};`);
    expect(idxFresh).toBeGreaterThanOrEqual(0);
    expect(idxStale).toBeGreaterThanOrEqual(0);
    expect(idxFresh).toBeLessThan(idxStale);
  });

  it("feedback {helpful:true} bumps last_accessed_at end-to-end through dispatcher", async () => {
    const config = baseConfig(tempDb(), { retainEnabled: true });
    const added = JSON.parse(
      (await dispatchStandaloneAction({ action: "add", content: "fb decay bump" }, config)).content,
    );
    backdateLastAccessed(config.dbPath, added.factId, 7);
    const before = readLastAccessed(config.dbPath, added.factId);

    await dispatchStandaloneAction(
      { action: "feedback", fact_id: added.factId, helpful: true },
      config,
    );

    const after = readLastAccessed(config.dbPath, added.factId);
    expect(after).not.toBe(before);
    expect(after).not.toBeNull();
  });
});

function readLastAccessed(dbPath: string, factId: number): string | null {
  const db = new Database(dbPath);
  try {
    const row = db.prepare("SELECT last_accessed_at FROM facts WHERE fact_id = ?").get(factId) as
      | { last_accessed_at: string | null }
      | undefined;
    return row?.last_accessed_at ?? null;
  } finally {
    db.close();
  }
}

function backdateLastAccessed(dbPath: string, factId: number, daysAgo: number): void {
  const db = new Database(dbPath);
  try {
    db.prepare(`UPDATE facts SET last_accessed_at = datetime('now', '-${daysAgo} days') WHERE fact_id = ?`)
      .run(factId);
  } finally {
    db.close();
  }
}

describe("dispatchStandaloneAction — recall_context (A3)", () => {
  it("returns standalone marker when no IDs provided", async () => {
    const config = baseConfig(tempDb());
    const result = await dispatchStandaloneAction({ action: "recall_context" }, config);
    expect(result.content).toMatch(/Paperclip-only/);
    expect(result.data).toEqual({ mode: "standalone", cached: false });
  });

  it("reads from on-disk cache when run_id is supplied", async () => {
    const config = baseConfig(tempDb());
    // Open the store so the dbPath dir is materialized, then write a cache
    // file directly via the helper the worker uses.
    getStore(config);
    const state: RecallState = {
      query: "test",
      facts: [],
      formatted: "MEMORY CONTEXT:\n1. cached entry",
      createdAt: new Date().toISOString(),
      runId: "run-fixture",
    };
    await writeRecallCache(config.dbPath, state, { runId: "run-fixture" });
    const result = await dispatchStandaloneAction({ action: "recall_context", run_id: "run-fixture" }, config);
    expect(result.content).toContain("MEMORY CONTEXT");
    expect(result.content).toContain("cached entry");
    const data = result.data as { mode: string; cached: boolean };
    expect(data.cached).toBe(true);
    expect(data.mode).toBe("standalone");
  });

  it("returns marker when run_id is supplied but cache is missing", async () => {
    const config = baseConfig(tempDb());
    const result = await dispatchStandaloneAction({ action: "recall_context", run_id: "no-such-run" }, config);
    expect(result.data).toEqual({ mode: "standalone", cached: false });
  });
});

describe("CoreActionHandler — companyId pass-through", () => {
  // The Paperclip worker passes runCtx into each handler via adaptCore;
  // the standalone MCP server passes no runCtx (companyId is undefined).
  // These tests pin both shapes at the dispatch layer so the cross-tenant
  // path can't silently regress when the dispatch refactor is touched again.
  let config: HolographicMemoryConfig;
  let store: MemoryStore;

  beforeEach(() => {
    config = baseConfig(tempDb());
    store = getStore(config);
  });

  it("handleSearch with runCtx.companyId scopes to that company plus NULL", async () => {
    store.addFact({ content: "Co-A only fact about widgets", companyId: "co-A" });
    store.addFact({ content: "Co-B only fact about widgets", companyId: "co-B" });
    store.addFact({ content: "Global fact about widgets" });

    const result = await handleSearch(
      store,
      { query: "widgets", min_trust: 0 },
      config,
      fakeRunCtx("co-A"),
    );

    expect(result.content).toContain("Co-A only fact");
    expect(result.content).toContain("Global fact");
    expect(result.content).not.toContain("Co-B only fact");
  });

  it("handleSearch with no runCtx (MCP standalone shape) sees every company", async () => {
    store.addFact({ content: "Co-A widget fact", companyId: "co-A" });
    store.addFact({ content: "Co-B widget fact", companyId: "co-B" });

    const result = await handleSearch(store, { query: "widget", min_trust: 0 }, config);

    expect(result.content).toContain("Co-A widget fact");
    expect(result.content).toContain("Co-B widget fact");
  });

  it("handleAdd persists runCtx.companyId on the new fact", async () => {
    const result = await handleAdd(
      store,
      { content: "stored under co-A scope" },
      config,
      fakeRunCtx("co-A"),
    );
    const data = JSON.parse(result.content) as { factId: number };

    const [persisted] = store.search("stored under", { limit: 1, minTrust: 0 });
    expect(persisted?.factId).toBe(data.factId);
    expect(persisted?.companyId).toBe("co-A");
  });
});
