import { describe, expect, it } from "vitest";
import {
  buildClaudeEntry,
  buildCodexBlock,
  mergeClaudeSettings,
  mergeClaudeUninstall,
  mergeCodexConfig,
  mergeCodexUninstall,
  parseArgs,
  validateClaudeSettings,
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
    uninstall: false,
    scope: "both",
    dbPath: "/tmp/h.db",
    recallEnabled: true,
    retainEnabled: true,
    minTrust: 0.3,
    maxRecall: 10,
    command: "npx",
    // The new default args use --package because npx without it can't find
    // the bin (package name and bin name diverge). See setup-mcp.ts header
    // comment for full rationale.
    args: ["-y", "--package", "paperclip-plugin-holographic-memory", "paperclip-holographic-memory-mcp"],
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

  it("default args use npx --package form so npx can find the bin", () => {
    // Regression guard: if someone reverts to bare ["paperclip-holographic-memory-mcp"],
    // npx will try to install a package with that exact name (which doesn't
    // exist on npm) and silently misconfig every user. This test pins the
    // canonical shape.
    const opts = defaults();
    expect(opts.args).toEqual([
      "-y",
      "--package",
      "paperclip-plugin-holographic-memory",
      "paperclip-holographic-memory-mcp",
    ]);
  });

  it("migration: install over old default args overwrites with new args", () => {
    // Pre-0.4.0 default was ["paperclip-holographic-memory-mcp"] — broken.
    // Re-running install (without --refresh) on a config wired with the old
    // default must overwrite cleanly with the new --package args.
    const oldEntry = {
      command: "npx",
      args: ["paperclip-holographic-memory-mcp"],
      env: (ENTRY as { env: Record<string, string> }).env,
    };
    const settings = { mcpServers: { "holographic-memory": oldEntry } };
    const outcome = mergeClaudeSettings(settings, ENTRY, false);
    expect(outcome.changed).toBe(true);
    expect(outcome.reason).toMatch(/^refresh /);
    const merged = JSON.parse(outcome.output);
    expect(merged.mcpServers["holographic-memory"].args).toEqual(ENTRY.args);
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

  it("does not false-match marker text inside a user-quoted comment", () => {
    // Adversarial review caught this: indexOf would have found the marker
    // string inside a user's own commented-out reference to it and stitched
    // across user content. The anchored ^...$ regex with the m flag rejects
    // anything that isn't a marker on its own line.
    const userComment = [
      "# Note: '# managed by paperclip-plugin-holographic-memory' is a marker",
      'model = "gpt-5.5"',
      "# end paperclip-plugin-holographic-memory should be left alone in this prose comment",
      "",
    ].join("\n");
    const outcome = mergeCodexConfig(userComment, CODEX_BLOCK, false);
    expect(outcome.changed).toBe(true);
    // The user comment line must survive intact.
    expect(outcome.output).toContain("# Note: '# managed by");
    // Our managed block must be appended cleanly, not stitched into the comment.
    expect(outcome.output).toContain("[mcp_servers.holographic-memory]");
    expect(outcome.output.indexOf("# managed by paperclip-plugin-holographic-memory\n[mcp_servers")).toBeGreaterThan(0);
  });

  it("production block contains all five env keys inline", () => {
    expect(CODEX_BLOCK).toContain("PAPERCLIP_HOLO_MEMORY_DB");
    expect(CODEX_BLOCK).toContain("PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED");
    expect(CODEX_BLOCK).toContain("PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED");
    expect(CODEX_BLOCK).toContain("PAPERCLIP_HOLO_MEMORY_MIN_TRUST");
    expect(CODEX_BLOCK).toContain("PAPERCLIP_HOLO_MEMORY_MAX_RECALL");
  });
});

describe("mergeClaudeUninstall", () => {
  it("removes mcpServers[holographic-memory] when present", () => {
    const settings = {
      mcpServers: {
        "holographic-memory": ENTRY,
        "code-review-graph": { command: "uvx", args: ["code-review-graph", "serve"] },
      },
    };
    const outcome = mergeClaudeUninstall(settings);
    expect(outcome.changed).toBe(true);
    expect(outcome.reason).toMatch(/^remove /);
    const merged = JSON.parse(outcome.output);
    expect(merged.mcpServers["holographic-memory"]).toBeUndefined();
    // Sibling entries survive.
    expect(merged.mcpServers["code-review-graph"]).toEqual({ command: "uvx", args: ["code-review-graph", "serve"] });
  });

  it("is idempotent when entry is already absent", () => {
    const settings = { mcpServers: { "code-review-graph": { command: "uvx", args: ["x"] } } };
    const outcome = mergeClaudeUninstall(settings);
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/already absent/);
  });

  it("is a no-op when mcpServers key is absent (fresh config)", () => {
    const outcome = mergeClaudeUninstall({ permissions: { defaultMode: "auto" } });
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/already absent/);
  });

  it("returns no-change when settings is null (no file)", () => {
    const outcome = mergeClaudeUninstall(null);
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/no settings file/);
  });

  it("drops the mcpServers key entirely when removing leaves it empty", () => {
    // Don't leave a dangling `"mcpServers": {}` that wasn't there pre-install.
    const settings = { mcpServers: { "holographic-memory": ENTRY } };
    const outcome = mergeClaudeUninstall(settings);
    expect(outcome.changed).toBe(true);
    const merged = JSON.parse(outcome.output);
    expect(merged.mcpServers).toBeUndefined();
  });

  it("preserves sibling top-level keys", () => {
    const settings = {
      permissions: { defaultMode: "auto" },
      mcpServers: { "holographic-memory": ENTRY },
    };
    const outcome = mergeClaudeUninstall(settings);
    expect(outcome.changed).toBe(true);
    const merged = JSON.parse(outcome.output);
    expect(merged.permissions.defaultMode).toBe("auto");
  });
});

describe("mergeCodexUninstall", () => {
  it("strips the marker block from a config that has it", () => {
    const existing = ['model = "gpt-5.5"', "", CODEX_BLOCK, "", "post = 1"].join("\n");
    const outcome = mergeCodexUninstall(existing);
    expect(outcome.changed).toBe(true);
    expect(outcome.reason).toMatch(/^remove /);
    expect(outcome.output).not.toContain("[mcp_servers.holographic-memory]");
    expect(outcome.output).not.toContain("# managed by paperclip-plugin");
    expect(outcome.output).toContain('model = "gpt-5.5"');
    expect(outcome.output).toContain("post = 1");
  });

  it("is idempotent when marker block is absent", () => {
    const existing = ['model = "gpt-5.5"', ""].join("\n");
    const outcome = mergeCodexUninstall(existing);
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/already absent/);
    expect(outcome.output).toBe(existing);
  });

  it("is idempotent when string is empty", () => {
    const outcome = mergeCodexUninstall("");
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/already absent/);
  });

  it("refuses to touch a config with BEGIN-without-END (corrupt marker)", () => {
    const existing = "# managed by paperclip-plugin-holographic-memory\nbroken = 1\n";
    const outcome = mergeCodexUninstall(existing);
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/corrupt/);
    expect(outcome.reason).toMatch(/BEGIN.*without.*END/);
    // File untouched.
    expect(outcome.output).toBe(existing);
  });

  it("refuses to touch a config with END-without-BEGIN (corrupt marker)", () => {
    const existing = "model = 1\n# end paperclip-plugin-holographic-memory\n";
    const outcome = mergeCodexUninstall(existing);
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/corrupt/);
    expect(outcome.reason).toMatch(/END.*without.*BEGIN/);
  });

  it("refuses to touch a config with END-before-BEGIN (corrupt order)", () => {
    const existing = [
      "# end paperclip-plugin-holographic-memory",
      "stuff = 1",
      "# managed by paperclip-plugin-holographic-memory",
      "",
    ].join("\n");
    const outcome = mergeCodexUninstall(existing);
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/corrupt/);
    expect(outcome.reason).toMatch(/END.*before.*BEGIN/);
  });

  it("does not match marker text inside a user-quoted comment", () => {
    // Same anti-stitching guarantee as install-side.
    const existing = [
      "# Note about '# managed by paperclip-plugin-holographic-memory' marker",
      'model = "gpt-5.5"',
      "",
    ].join("\n");
    const outcome = mergeCodexUninstall(existing);
    // No real marker on its own line → treated as already-absent.
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/already absent/);
  });
});

describe("validateClaudeSettings", () => {
  it("accepts a plain object as the top level", () => {
    expect(() => validateClaudeSettings({ permissions: {} }, "/tmp/x.json")).not.toThrow();
  });

  it("accepts mcpServers as an object (record)", () => {
    expect(() =>
      validateClaudeSettings({ mcpServers: { foo: { command: "bar" } } }, "/tmp/x.json"),
    ).not.toThrow();
  });

  it("rejects null at the top level", () => {
    expect(() => validateClaudeSettings(null, "/tmp/x.json")).toThrow(/null/);
  });

  it("rejects an array at the top level", () => {
    expect(() => validateClaudeSettings([], "/tmp/x.json")).toThrow(/array/);
  });

  it("rejects a primitive (string) at the top level", () => {
    expect(() => validateClaudeSettings("not an object", "/tmp/x.json")).toThrow(/string/);
  });

  it("rejects mcpServers as a string", () => {
    expect(() => validateClaudeSettings({ mcpServers: "wat" }, "/tmp/x.json")).toThrow(/mcpServers.*string/);
  });

  it("rejects mcpServers as an array", () => {
    expect(() => validateClaudeSettings({ mcpServers: [] }, "/tmp/x.json")).toThrow(/mcpServers.*array/);
  });

  it("rejects mcpServers as null", () => {
    expect(() => validateClaudeSettings({ mcpServers: null }, "/tmp/x.json")).toThrow(/mcpServers.*null/);
  });
});

describe("parseArgs", () => {
  it("defaults uninstall=false when --uninstall is absent", () => {
    expect(parseArgs([]).uninstall).toBe(false);
  });

  it("sets uninstall=true when --uninstall is present", () => {
    expect(parseArgs(["--uninstall"]).uninstall).toBe(true);
  });

  it("rejects --uninstall + --refresh combination", () => {
    expect(() => parseArgs(["--uninstall", "--refresh"])).toThrow(/cannot be combined/);
  });

  it("accepts --command as alias for --command-path", () => {
    const opts = parseArgs(["--command", "/usr/local/bin/holo-mcp"]);
    expect(opts.command).toBe("/usr/local/bin/holo-mcp");
  });

  it("accepts --command-path canonical form", () => {
    const opts = parseArgs(["--command-path", "/usr/local/bin/holo-mcp"]);
    expect(opts.command).toBe("/usr/local/bin/holo-mcp");
  });

  it("accepts --args=VALUE equals form", () => {
    const opts = parseArgs(["--args=a,b,c"]);
    expect(opts.args).toEqual(["a", "b", "c"]);
  });

  it("accepts --args VALUE space form (legacy)", () => {
    const opts = parseArgs(["--args", "a,b,c"]);
    expect(opts.args).toEqual(["a", "b", "c"]);
  });

  it("treats empty --args= as empty array (for direct global-bin invocation)", () => {
    const opts = parseArgs(["--args="]);
    expect(opts.args).toEqual([]);
  });

  it("falls back to DEFAULT_ARGS when --args is omitted", () => {
    const opts = parseArgs([]);
    expect(opts.args).toEqual([
      "-y",
      "--package",
      "paperclip-plugin-holographic-memory",
      "paperclip-holographic-memory-mcp",
    ]);
  });

  it("respects --scope claude", () => {
    expect(parseArgs(["--scope", "claude"]).scope).toBe("claude");
  });

  it("respects --scope codex", () => {
    expect(parseArgs(["--scope", "codex"]).scope).toBe("codex");
  });

  it("rejects invalid --scope values", () => {
    expect(() => parseArgs(["--scope", "neither"])).toThrow(/--scope must be one of/);
  });
});

describe("idempotency round-trip", () => {
  it("install → uninstall → uninstall is a no-op the second time", () => {
    // Compose the helpers end-to-end as a contract test.
    const empty: { mcpServers?: Record<string, unknown>; [k: string]: unknown } = {};
    const installed = mergeClaudeSettings(empty, ENTRY, false);
    expect(installed.changed).toBe(true);

    const afterInstall = JSON.parse(installed.output);
    const firstUninstall = mergeClaudeUninstall(afterInstall);
    expect(firstUninstall.changed).toBe(true);

    // After first uninstall, the mcpServers key should be gone (since
    // installing into an empty config left only our entry, removing it
    // empties mcpServers and we drop the key entirely).
    const afterFirstUninstall = JSON.parse(firstUninstall.output);
    expect(afterFirstUninstall.mcpServers).toBeUndefined();

    const secondUninstall = mergeClaudeUninstall(afterFirstUninstall);
    expect(secondUninstall.changed).toBe(false);
    expect(secondUninstall.reason).toMatch(/already absent/);
  });

  it("codex install → uninstall → uninstall is idempotent", () => {
    const installed = mergeCodexConfig("", CODEX_BLOCK, false);
    expect(installed.changed).toBe(true);

    const firstUninstall = mergeCodexUninstall(installed.output);
    expect(firstUninstall.changed).toBe(true);

    const secondUninstall = mergeCodexUninstall(firstUninstall.output);
    expect(secondUninstall.changed).toBe(false);
    expect(secondUninstall.reason).toMatch(/already absent/);
  });
});
