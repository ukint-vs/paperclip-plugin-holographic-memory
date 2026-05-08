import { describe, expect, it } from "vitest";
import { mergeClaudeSettings, mergeCodexConfig } from "../scripts/setup-mcp.js";

const ENTRY = {
  command: "npx",
  args: ["paperclip-holographic-memory-mcp"],
  env: {
    PAPERCLIP_HOLO_MEMORY_DB: "/tmp/h.db",
    PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED: "true",
    PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED: "true",
    PAPERCLIP_HOLO_MEMORY_MIN_TRUST: "0.3",
    PAPERCLIP_HOLO_MEMORY_MAX_RECALL: "10",
  },
};

describe("mergeClaudeSettings", () => {
  it("adds the entry to a settings file with no mcpServers", () => {
    const outcome = mergeClaudeSettings({ permissions: { defaultMode: "auto" } }, ENTRY, false);
    expect(outcome.changed).toBe(true);
    expect(outcome.reason).toMatch(/^add /);
    const merged = JSON.parse(outcome.output);
    expect(merged.mcpServers["holographic-memory"]).toEqual(ENTRY);
    expect(merged.permissions.defaultMode).toBe("auto");
  });

  it("preserves sibling mcpServers entries", () => {
    const outcome = mergeClaudeSettings(
      {
        mcpServers: {
          "code-review-graph": { command: "uvx", args: ["code-review-graph", "serve"] },
        },
      },
      ENTRY,
      false,
    );
    expect(outcome.changed).toBe(true);
    const merged = JSON.parse(outcome.output);
    expect(merged.mcpServers["code-review-graph"]).toEqual({ command: "uvx", args: ["code-review-graph", "serve"] });
    expect(merged.mcpServers["holographic-memory"]).toEqual(ENTRY);
  });

  it("is idempotent when entry is identical", () => {
    const settings = { mcpServers: { "holographic-memory": ENTRY } };
    const outcome = mergeClaudeSettings(settings, ENTRY, false);
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/up to date/);
  });

  it("--refresh forces a rewrite even when identical", () => {
    const settings = { mcpServers: { "holographic-memory": ENTRY } };
    const outcome = mergeClaudeSettings(settings, ENTRY, true);
    expect(outcome.changed).toBe(true);
    expect(outcome.reason).toMatch(/^refresh /);
  });

  it("creates mcpServers when input is null", () => {
    const outcome = mergeClaudeSettings(null, ENTRY, false);
    expect(outcome.changed).toBe(true);
    const merged = JSON.parse(outcome.output);
    expect(merged.mcpServers["holographic-memory"]).toEqual(ENTRY);
  });
});

const CODEX_BLOCK = [
  "# managed by paperclip-plugin-holographic-memory",
  "[mcp_servers.holographic-memory]",
  'command = "npx"',
  'args = ["paperclip-holographic-memory-mcp"]',
  'env = { PAPERCLIP_HOLO_MEMORY_DB = "/tmp/h.db" }',
  "# end paperclip-plugin-holographic-memory",
].join("\n");

describe("mergeCodexConfig", () => {
  it("appends the marker block to a non-empty existing TOML, preserving comments", () => {
    const existing = [
      'model = "gpt-5.5"',
      "# user comment that must survive",
      "",
      "[mcp_servers.context7]",
      'command = "npx"',
      "",
    ].join("\n");
    const outcome = mergeCodexConfig(existing, CODEX_BLOCK, false);
    expect(outcome.changed).toBe(true);
    expect(outcome.output).toContain("# user comment that must survive");
    expect(outcome.output).toContain("[mcp_servers.context7]");
    expect(outcome.output).toContain("[mcp_servers.holographic-memory]");
    expect(outcome.output.endsWith("\n")).toBe(true);
  });

  it("appends to an empty file without leading blank lines", () => {
    const outcome = mergeCodexConfig("", CODEX_BLOCK, false);
    expect(outcome.changed).toBe(true);
    expect(outcome.output.startsWith("# managed by")).toBe(true);
  });

  it("is idempotent when the marker block already matches exactly", () => {
    const existing = ["existing = 1", "", CODEX_BLOCK, ""].join("\n");
    const outcome = mergeCodexConfig(existing, CODEX_BLOCK, false);
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/up to date/);
  });

  it("--refresh rewrites the marker block in place", () => {
    const existing = ["pre = 1", "", CODEX_BLOCK, "post = 2"].join("\n");
    const newBlock = CODEX_BLOCK.replace("/tmp/h.db", "/tmp/changed.db");
    const outcome = mergeCodexConfig(existing, newBlock, true);
    expect(outcome.changed).toBe(true);
    expect(outcome.output).toContain("/tmp/changed.db");
    expect(outcome.output).not.toContain("/tmp/h.db");
    expect(outcome.output).toContain("pre = 1");
    expect(outcome.output).toContain("post = 2");
  });

  it("only matches markers when both begin and end are present", () => {
    // Only the begin marker (no end) — treat as not-present and append.
    const existing = "# managed by paperclip-plugin-holographic-memory\nbroken = 1\n";
    const outcome = mergeCodexConfig(existing, CODEX_BLOCK, false);
    expect(outcome.changed).toBe(true);
    expect(outcome.output).toContain("[mcp_servers.holographic-memory]");
  });
});
