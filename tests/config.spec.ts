import { describe, expect, it } from "vitest";
import { expandHome, resolvePluginConfig } from "../src/config.js";

describe("config", () => {
  it("prefers explicit config and clamps numeric values", () => {
    const config = resolvePluginConfig({
      dbPath: "/tmp/explicit.db",
      minTrustScore: 2,
      maxFactsPerRecall: 200
    });

    expect(config.dbPath).toBe("/tmp/explicit.db");
    expect(config.minTrustScore).toBe(1);
    expect(config.maxFactsPerRecall).toBe(50);
  });

  it("defaults to the isolated Paperclip memory store", () => {
    const config = resolvePluginConfig();

    expect(config.dbPath).toMatch(/\.paperclip\/instances\/default\/hermes-memory\.db$/);
  });

  it("expands home paths", () => {
    expect(expandHome("~/memory.db")).toMatch(/memory\.db$/);
    expect(expandHome("/tmp/memory.db")).toBe("/tmp/memory.db");
  });
});
