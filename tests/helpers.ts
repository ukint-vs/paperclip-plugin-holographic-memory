import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import type { HolographicMemoryConfig } from "../src/types.js";

// Shared test helpers. The previous duplication across worker.spec, dispatch.spec,
// memory-store.spec, recall-cache.spec, and mcp-server.spec accumulated four near-
// identical `tempDb()`/`tempDbPath()` and two identical `baseConfig()` definitions —
// this file is the single source.

export function tempDb(prefix = "holographic-memory-"): string {
  return path.join(mkdtempSync(path.join(tmpdir(), prefix)), "memory.db");
}

// Alias used by older specs that named the helper differently. Kept so we don't
// have to touch unrelated test files; new tests should prefer `tempDb`.
export const tempDbPath = tempDb;

export function baseConfig(
  dbPath: string,
  overrides: Partial<HolographicMemoryConfig> = {},
): HolographicMemoryConfig {
  return {
    dbPath,
    recallEnabled: true,
    retainEnabled: true,
    minTrustScore: 0.3,
    maxFactsPerRecall: 10,
    trustHalfLifeDays: 0,
    ...overrides,
  };
}

// Minimal ToolRunContext for tests that only exercise the companyId
// scoping path. The cast is unavoidable because ToolRunContext requires
// fields the handlers under test never read.
export function fakeRunCtx(companyId: string): ToolRunContext {
  return { companyId } as ToolRunContext;
}
