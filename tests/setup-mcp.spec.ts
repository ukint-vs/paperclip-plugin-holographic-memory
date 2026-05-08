import { describe, expect, it } from "vitest";
import {
  buildClaudeEntry,
  buildCodexBlock,
  mergeClaudeSettings,
  mergeCodexConfig,
  type CliOptions,
} from "../scripts/setup-mcp.js";

// Build the fixtures from the real production builders so this spec validates
// the actual block shape the script writes. Earlier this test had a hand-
// authored CODEX_BLOCK with a single env var, while production emits five —
// the merge tests passed against the simpler shape and missed shape changes
// in the production output.
function defaults(): CliOptions {
  return {
    print: false,
    dryRun: false,
    refresh: false,
    scope: "both",
    dbPath: "/tmp/h.db",
    recallEnabled: true,
    retainEnabled: true,
    minTrust: 0.3,
    maxRecall: 10,
    command: "npx",
    args: ["paperclip-holographic-memory-mcp"],
    claudePath: "/tmp/claude.json",
    codexPath: "/tmp/codex.toml",
  };
}

const ENTRY = buildClaudeEntry(defaults());
const CODEX_BLOCK = buildCodexBlock(defaults());

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

  it("emits all five env vars in the Claude entry", () => {
    // Guard against fixture drift: if production starts emitting a different
    // set of env vars, this test forces the spec to update with intent.
    expect(Object.keys((ENTRY as { env: Record<string, string> }).env)).toEqual([
      "PAPERCLIP_HOLO_MEMORY_DB",
      "PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED",
      "PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED",
      "PAPERCLIP_HOLO_MEMORY_MIN_TRUST",
      "PAPERCLIP_HOLO_MEMORY_MAX_RECALL",
    ]);
  });
});

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
    const newBlock = buildCodexBlock({ ...defaults(), dbPath: "/tmp/changed.db" });
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

  it("production block contains all five env keys inline", () => {
    expect(CODEX_BLOCK).toContain("PAPERCLIP_HOLO_MEMORY_DB");
    expect(CODEX_BLOCK).toContain("PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED");
    expect(CODEX_BLOCK).toContain("PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED");
    expect(CODEX_BLOCK).toContain("PAPERCLIP_HOLO_MEMORY_MIN_TRUST");
    expect(CODEX_BLOCK).toContain("PAPERCLIP_HOLO_MEMORY_MAX_RECALL");
  });
});
