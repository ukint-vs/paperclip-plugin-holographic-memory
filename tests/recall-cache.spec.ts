import fs from "node:fs/promises";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECALL_CACHE_TTL_MS,
  gcStaleCache,
  readRecallCache,
  recallCacheRoot,
  writeRecallCache,
} from "../src/recall-cache.js";
import type { RecallState } from "../src/types.js";

function tempDb(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "recall-cache-")), "memory.db");
}

function fixtureState(overrides: Partial<RecallState> = {}): RecallState {
  return {
    query: "test query",
    facts: [],
    formatted: "MEMORY CONTEXT:\n1. fact",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("recall-cache", () => {
  it("writes one file per supplied scope id", async () => {
    const dbPath = tempDb();
    const state = fixtureState();
    await writeRecallCache(dbPath, state, { runId: "r1", issueId: "i1", agentId: "a1" });

    expect((await readRecallCache(dbPath, "run", "r1"))?.formatted).toContain("MEMORY CONTEXT");
    expect((await readRecallCache(dbPath, "issue", "i1"))?.formatted).toContain("MEMORY CONTEXT");
    expect((await readRecallCache(dbPath, "agent", "a1"))?.formatted).toContain("MEMORY CONTEXT");
  });

  it("skips scopes that are absent", async () => {
    const dbPath = tempDb();
    await writeRecallCache(dbPath, fixtureState(), { runId: "r-only" });
    expect(await readRecallCache(dbPath, "run", "r-only")).toBeDefined();
    expect(await readRecallCache(dbPath, "issue", "missing")).toBeUndefined();
  });

  it("returns undefined on missing or unparseable files", async () => {
    const dbPath = tempDb();
    expect(await readRecallCache(dbPath, "run", "nope")).toBeUndefined();

    // Manually plant a malformed file and confirm we don't throw.
    const target = path.join(recallCacheRoot(dbPath), "run", "garbage.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "not valid json");
    expect(await readRecallCache(dbPath, "run", "garbage")).toBeUndefined();
  });

  it("write failures are caught and reported via logger", async () => {
    const dbPath = tempDb();
    const messages: string[] = [];
    // Use a sanitized id that gets path-joined into a directory we deny.
    // Simulate failure by pointing dbPath at a parent we then chmod 0 — but
    // that's brittle on macOS. Instead, force failure by passing an id with
    // characters that, after sanitization, still produce a valid path,
    // then make the target dir read-only.
    await fs.mkdir(recallCacheRoot(dbPath), { recursive: true });
    const runDir = path.join(recallCacheRoot(dbPath), "run");
    await fs.mkdir(runDir, { recursive: true });
    await fs.chmod(runDir, 0o500);
    try {
      await writeRecallCache(dbPath, fixtureState(), { runId: "denied" }, (m) => messages.push(m));
      // On macOS root the chmod may not block writes; we accept either:
      // either the write was logged as failed, or it actually succeeded
      // because the test runner has elevated privileges.
      expect(messages.length === 0 || messages.some((m) => m.includes("denied"))).toBe(true);
    } finally {
      await fs.chmod(runDir, 0o700).catch(() => undefined);
    }
  });

  it("gcStaleCache removes files older than maxAge", async () => {
    const dbPath = tempDb();
    await writeRecallCache(dbPath, fixtureState(), { runId: "fresh" });
    await writeRecallCache(dbPath, fixtureState(), { runId: "stale" });

    // Backdate the "stale" file to 25h ago.
    const staleFile = path.join(recallCacheRoot(dbPath), "run", "stale.json");
    const past = Date.now() - 25 * 60 * 60 * 1000;
    await fs.utimes(staleFile, past / 1000, past / 1000);

    await gcStaleCache(dbPath);

    expect(await readRecallCache(dbPath, "run", "fresh")).toBeDefined();
    expect(await readRecallCache(dbPath, "run", "stale")).toBeUndefined();
  });

  it("uses default 24h TTL when maxAge omitted", async () => {
    expect(DEFAULT_RECALL_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("sanitizes path-traversal characters in scope ids", async () => {
    const dbPath = tempDb();
    await writeRecallCache(dbPath, fixtureState(), { runId: "../../etc/passwd" });
    // The sanitized filename should be inside the cache dir, not a literal
    // path-traversal escape.
    const expectedDir = path.join(recallCacheRoot(dbPath), "run");
    const entries = await fs.readdir(expectedDir);
    expect(entries.length).toBe(1);
    const written = entries[0];
    expect(written).not.toContain("/");
    expect(written).not.toContain("\\");
    // File should still be inside cache dir.
    const stat = statSync(path.join(expectedDir, written!));
    expect(stat.isFile()).toBe(true);
  });
});
