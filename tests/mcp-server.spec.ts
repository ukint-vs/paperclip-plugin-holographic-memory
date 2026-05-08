import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeStores } from "../src/dispatch.js";
import { createServer, resolveStandaloneConfig } from "../src/mcp-server.js";

function tempDb(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "mcp-server-")), "memory.db");
}

afterEach(() => {
  closeStores();
});

describe("resolveStandaloneConfig", () => {
  it("uses defaults when env is empty", () => {
    const config = resolveStandaloneConfig({});
    expect(config.dbPath).toMatch(/hermes-memory\.db$/);
    expect(config.recallEnabled).toBe(true);
    expect(config.retainEnabled).toBe(true);
    expect(config.minTrustScore).toBe(0.3);
    expect(config.maxFactsPerRecall).toBe(10);
  });

  it("respects PAPERCLIP_HOLO_MEMORY_DB", () => {
    const config = resolveStandaloneConfig({
      PAPERCLIP_HOLO_MEMORY_DB: "/tmp/custom.db",
    });
    expect(config.dbPath).toBe("/tmp/custom.db");
  });

  it("expands ~ home prefix", () => {
    const config = resolveStandaloneConfig({
      PAPERCLIP_HOLO_MEMORY_DB: "~/foo.db",
    });
    expect(config.dbPath).not.toMatch(/^~/);
    expect(config.dbPath.endsWith("/foo.db")).toBe(true);
  });

  it("parses boolean env vars (truthy and falsy)", () => {
    const yes = resolveStandaloneConfig({ PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED: "false" });
    expect(yes.retainEnabled).toBe(false);
    const no = resolveStandaloneConfig({ PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED: "0" });
    expect(no.recallEnabled).toBe(false);
    // Garbage env values fall back to default.
    const garbage = resolveStandaloneConfig({ PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED: "lol" });
    expect(garbage.recallEnabled).toBe(true);
  });

  it("clamps numeric env vars to valid ranges", () => {
    const clamped = resolveStandaloneConfig({
      PAPERCLIP_HOLO_MEMORY_MIN_TRUST: "5",
      PAPERCLIP_HOLO_MEMORY_MAX_RECALL: "999",
    });
    expect(clamped.minTrustScore).toBe(1);
    expect(clamped.maxFactsPerRecall).toBe(50);
    const negClamped = resolveStandaloneConfig({
      PAPERCLIP_HOLO_MEMORY_MIN_TRUST: "-3",
      PAPERCLIP_HOLO_MEMORY_MAX_RECALL: "0",
    });
    expect(negClamped.minTrustScore).toBe(0);
    expect(negClamped.maxFactsPerRecall).toBe(1);
  });
});

describe("createServer", () => {
  it("constructs an MCP server with the holographic_memory_search tool", () => {
    const config = resolveStandaloneConfig({ PAPERCLIP_HOLO_MEMORY_DB: tempDb() });
    const server = createServer(config);
    // The McpServer instance does not expose a public registry getter; we
    // confirm the server was created without throwing. The end-to-end tool
    // round-trip lives in tests/mcp-smoke.spec.ts (spawn-based), which
    // exercises tools/list + tools/call against this same factory.
    expect(server).toBeDefined();
  });
});
