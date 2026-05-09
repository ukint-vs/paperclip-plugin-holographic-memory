import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyClaudeUninstallViaCli,
  applyClaudeViaCli,
  applyCodex,
  applyCodexUninstall,
  applyCodexUninstallViaCli,
  applyCodexViaCli,
  buildClaudeEntry,
  buildClaudeMcpAddArgs,
  buildCodexBlock,
  buildCodexMcpAddArgs,
  hasUnmarkedCodexEntry,
  mergeClaudeSettings,
  mergeClaudeUninstall,
  mergeCodexConfig,
  mergeCodexUninstall,
  migrateLegacyClaudeSettings,
  parseArgs,
  shouldUseClaudeCli,
  shouldUseCodexCli,
  validateClaudeSettings,
  type CliOptions,
  type ExecResult,
  type ExecRunner,
  _resetExecRunnerForTests,
  _setExecRunnerForTests,
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

  it("throws on a config with BEGIN-without-END (corrupt marker)", () => {
    // Throw → run() exits 2 → automation aborts. Returning changed:false
    // would misleadingly report success and leave the entry in place,
    // dangling after `npm uninstall` removes the bin. Mirrors the
    // malformed-JSON/TOML contract.
    const existing = "# managed by paperclip-plugin-holographic-memory\nbroken = 1\n";
    expect(() => mergeCodexUninstall(existing)).toThrow(/BEGIN marker without END/);
  });

  it("throws on a config with END-without-BEGIN (corrupt marker)", () => {
    const existing = "model = 1\n# end paperclip-plugin-holographic-memory\n";
    expect(() => mergeCodexUninstall(existing)).toThrow(/END marker without BEGIN/);
  });

  it("throws on a config with END-before-BEGIN (corrupt order)", () => {
    const existing = [
      "# end paperclip-plugin-holographic-memory",
      "stuff = 1",
      "# managed by paperclip-plugin-holographic-memory",
      "",
    ].join("\n");
    expect(() => mergeCodexUninstall(existing)).toThrow(/END marker before BEGIN/);
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

// ---------------------------------------------------------------------------
// CLI shell-out tests
// ---------------------------------------------------------------------------

const DEFAULT_CLAUDE_PATH = path.join(homedir(), ".claude.json");
const DEFAULT_CODEX_PATH = path.join(homedir(), ".codex", "config.toml");

function cliDefaults(): CliOptions {
  return { ...defaults(), claudePath: DEFAULT_CLAUDE_PATH, codexPath: DEFAULT_CODEX_PATH };
}

function expectedEnvLines(): string {
  // Derive from the live builder so adding/renaming env vars doesn't drift.
  const args = buildClaudeMcpAddArgs(cliDefaults());
  return args
    .filter((_, i) => args[i - 1] === "--env")
    .join("\n");
}

describe("buildClaudeMcpAddArgs", () => {
  it("default opts produce --scope user --transport stdio + 5 --env flags + -- separator", () => {
    const args = buildClaudeMcpAddArgs(cliDefaults());
    expect(args.slice(0, 6)).toEqual(["mcp", "add", "--scope", "user", "--transport", "stdio"]);
    // 5 env vars × 2 tokens each = 10 tokens
    expect(args.filter((a) => a === "--env")).toHaveLength(5);
    // Server name precedes the "--" separator
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    expect(args[sepIdx - 1]).toBe("holographic-memory");
    expect(args.slice(sepIdx + 1)).toEqual(["npx", "-y", "--package", "paperclip-plugin-holographic-memory", "paperclip-holographic-memory-mcp"]);
  });

  it("includes all 5 PAPERCLIP_HOLO_MEMORY_* env vars with their values", () => {
    const args = buildClaudeMcpAddArgs(cliDefaults());
    const envValues = args.filter((_, i) => args[i - 1] === "--env");
    expect(envValues).toEqual([
      "PAPERCLIP_HOLO_MEMORY_DB=/tmp/h.db",
      "PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED=true",
      "PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED=true",
      "PAPERCLIP_HOLO_MEMORY_MIN_TRUST=0.3",
      "PAPERCLIP_HOLO_MEMORY_MAX_RECALL=10",
    ]);
  });

  it("custom command + empty args yields trailing -- + command, no further args", () => {
    const opts = { ...cliDefaults(), command: "/usr/local/bin/holo-mcp", args: [] };
    const args = buildClaudeMcpAddArgs(opts);
    expect(args.slice(-2)).toEqual(["--", "/usr/local/bin/holo-mcp"]);
  });
});

describe("buildCodexMcpAddArgs", () => {
  it("uses --env (long form), no --scope/--transport", () => {
    const args = buildCodexMcpAddArgs(cliDefaults());
    expect(args.slice(0, 2)).toEqual(["mcp", "add"]);
    expect(args.includes("--scope")).toBe(false);
    expect(args.includes("--transport")).toBe(false);
    expect(args.filter((a) => a === "--env")).toHaveLength(5);
    expect(args.includes("-e")).toBe(false);
  });

  it("server name precedes -- separator, command + args follow", () => {
    const args = buildCodexMcpAddArgs(cliDefaults());
    const sepIdx = args.indexOf("--");
    expect(args[sepIdx - 1]).toBe("holographic-memory");
    expect(args.slice(sepIdx + 1)).toEqual(["npx", "-y", "--package", "paperclip-plugin-holographic-memory", "paperclip-holographic-memory-mcp"]);
  });
});

describe("shouldUseClaudeCli / shouldUseCodexCli", () => {
  it("returns true for default paths", () => {
    const opts = cliDefaults();
    expect(shouldUseClaudeCli(opts)).toBe(true);
    expect(shouldUseCodexCli(opts)).toBe(true);
  });

  it("returns false when --claude-config / --codex-config overrides the path", () => {
    const opts: CliOptions = { ...cliDefaults(), claudePath: "/tmp/claude.json", codexPath: "/tmp/codex.toml" };
    expect(shouldUseClaudeCli(opts)).toBe(false);
    expect(shouldUseCodexCli(opts)).toBe(false);
  });
});

describe("hasUnmarkedCodexEntry", () => {
  it("returns false when the table is absent", () => {
    expect(hasUnmarkedCodexEntry('model = "x"\n')).toBe(false);
  });

  it("returns true when the table exists without our markers", () => {
    const config = '[mcp_servers.holographic-memory]\ncommand = "npx"\n';
    expect(hasUnmarkedCodexEntry(config)).toBe(true);
  });

  it("returns false when the table is wrapped in our markers", () => {
    expect(hasUnmarkedCodexEntry(CODEX_BLOCK + "\n")).toBe(false);
  });

  it("ignores commented-out marker text", () => {
    // Marker line referenced inside a user comment should not count as our marker.
    const config = [
      `# Note: '${"# managed by paperclip-plugin-holographic-memory"}' marker`,
      "[mcp_servers.holographic-memory]",
      'command = "npx"',
    ].join("\n");
    expect(hasUnmarkedCodexEntry(config)).toBe(true);
  });
});

// Mock exec runner that returns scripted ExecResults per invocation.
function makeMockRunner(scripts: Array<Partial<ExecResult> & { match?: (cmd: string, args: string[]) => boolean }>): {
  runner: ExecRunner;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let cursor = 0;
  const runner: ExecRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    // Find the next script that matches (or use sequential cursor if no match fn)
    const matchIdx = scripts.findIndex((s, i) => i >= cursor && (s.match ? s.match(cmd, args) : true));
    const idx = matchIdx === -1 ? cursor : matchIdx;
    const script = scripts[idx] ?? { code: 0, stdout: "", stderr: "" };
    cursor = idx + 1;
    return { code: 0, stdout: "", stderr: "", ...script };
  };
  return { runner, calls };
}

describe("applyClaudeViaCli", () => {
  beforeEach(() => _resetExecRunnerForTests());
  afterEach(() => _resetExecRunnerForTests());

  it("returns null when --claude-config overrides default path", async () => {
    const { runner, calls } = makeMockRunner([]);
    _setExecRunnerForTests(runner);
    const opts: CliOptions = { ...cliDefaults(), claudePath: "/tmp/custom.json" };
    const result = await applyClaudeViaCli(opts);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when claude CLI absent (ENOENT on --version)", async () => {
    const { runner } = makeMockRunner([{ code: -1, codeName: "ENOENT", stderr: "command not found" }]);
    _setExecRunnerForTests(runner);
    expect(await applyClaudeViaCli(cliDefaults())).toBeNull();
  });

  it("CLI present, server absent → calls add then verifies present", async () => {
    let probeCount = 0;
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") {
        probeCount++;
        // First probe: absent. Second probe (verification): present in user scope.
        if (probeCount === 1) return { code: 1, stdout: "", stderr: "No MCP server found" };
        return { code: 0, stdout: `Scope: User config\n${expectedEnvLines()}`, stderr: "" };
      }
      if (args[1] === "add") return { code: 0, stdout: "added", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    const result = await applyClaudeViaCli(cliDefaults());
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.reason).toMatch(/registered via claude mcp add/);
  });

  it("CLI present, server present in user scope, env in sync, no refresh → no-op", async () => {
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") {
        return { code: 0, stdout: `Scope: User config\n${expectedEnvLines()}`, stderr: "" };
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    };
    _setExecRunnerForTests(runner);
    const result = await applyClaudeViaCli(cliDefaults());
    expect(result!.changed).toBe(false);
    expect(result!.reason).toMatch(/already registered.*env in sync/);
  });

  it("CLI present, server present with env drift → triggers remove + add", async () => {
    let probeCount = 0;
    const calls: string[] = [];
    const runner: ExecRunner = async (cmd, args) => {
      calls.push(args.join(" "));
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") {
        probeCount++;
        // First probe: present but with stale env. Second probe (verification): present with fresh env.
        if (probeCount === 1) {
          return { code: 0, stdout: "Scope: User config\nPAPERCLIP_HOLO_MEMORY_DB=/old/path", stderr: "" };
        }
        return { code: 0, stdout: `Scope: User config\n${expectedEnvLines()}`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    const result = await applyClaudeViaCli(cliDefaults());
    expect(result!.changed).toBe(true);
    expect(result!.reason).toMatch(/refreshed.*env drift/);
    expect(calls.some((c) => c.startsWith("mcp remove --scope user"))).toBe(true);
    expect(calls.some((c) => c.startsWith("mcp add"))).toBe(true);
  });

  it("CLI present, server present in PROJECT scope → remove uses --scope project, add uses --scope user", async () => {
    // Regression test for #36 review: previously the remove was hardcoded to
    // --scope user, which would silently fail "not found" against the real
    // project-scope entry, leaving it dangling alongside the new user-scope
    // add (duplicate entries). Remove must target the actual probed scope.
    let probeCount = 0;
    const calls: string[] = [];
    const runner: ExecRunner = async (cmd, args) => {
      calls.push(args.join(" "));
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") {
        probeCount++;
        if (probeCount === 1) {
          return { code: 0, stdout: `Scope: Project config\n${expectedEnvLines()}`, stderr: "" };
        }
        return { code: 0, stdout: `Scope: User config\n${expectedEnvLines()}`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    const result = await applyClaudeViaCli(cliDefaults());
    expect(result!.changed).toBe(true);
    expect(result!.reason).toMatch(/scope mismatch/);
    expect(calls).toContain(`mcp remove --scope project ${"holographic-memory"}`);
    const addCall = calls.find((c) => c.startsWith("mcp add"));
    expect(addCall).toMatch(/--scope user/);
  });

  it("env drift: probe shows PAPERCLIP_HOLO_MEMORY_DB=/tmp/h.db.bak (substring of expected) → drift detected", async () => {
    // Regression test for #36 review: substring matching `raw.includes('K=v')`
    // would falsely report in-sync when the probe shows `K=v.bak` (since "v"
    // is a prefix of "v.bak"). Word-boundary regex must reject this.
    let probeCount = 0;
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") {
        probeCount++;
        if (probeCount === 1) {
          // Probe shows DB path = /tmp/h.db.bak; expected (cliDefaults dbPath)
          // is /tmp/h.db. Old substring check: `raw.includes("DB=/tmp/h.db")`
          // would return true (false positive). New regex must return false.
          const lines = [
            "Scope: User config",
            "PAPERCLIP_HOLO_MEMORY_DB=/tmp/h.db.bak",
            "PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED=true",
            "PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED=true",
            "PAPERCLIP_HOLO_MEMORY_MIN_TRUST=0.3",
            "PAPERCLIP_HOLO_MEMORY_MAX_RECALL=10",
          ].join("\n");
          return { code: 0, stdout: lines, stderr: "" };
        }
        return { code: 0, stdout: `Scope: User config\n${expectedEnvLines()}`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    const result = await applyClaudeViaCli(cliDefaults());
    expect(result!.changed).toBe(true);
    expect(result!.reason).toMatch(/refreshed.*env drift/);
  });

  it("LOCAL scope mismatch removes with --scope local", async () => {
    let probeCount = 0;
    const calls: string[] = [];
    const runner: ExecRunner = async (cmd, args) => {
      calls.push(args.join(" "));
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") {
        probeCount++;
        if (probeCount === 1) {
          return { code: 0, stdout: `Scope: Local config\n${expectedEnvLines()}`, stderr: "" };
        }
        return { code: 0, stdout: `Scope: User config\n${expectedEnvLines()}`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    await applyClaudeViaCli(cliDefaults());
    expect(calls.some((c) => c.startsWith("mcp remove --scope local"))).toBe(true);
  });

  it("refresh=true with stale entry: remove returns 'not found' → still proceeds with add", async () => {
    // Trigger the remove-not-found path: entry must be present at first probe
    // (so willChange triggers remove) but the remove call fails with "not found"
    // (a race or scope quirk). The code should swallow that and proceed to add.
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") return { code: 0, stdout: `Scope: User config\n${expectedEnvLines()}`, stderr: "" };
      if (args[1] === "remove") return { code: 1, stdout: "", stderr: "not found" };
      if (args[1] === "add") return { code: 0, stdout: "added", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    const result = await applyClaudeViaCli({ ...cliDefaults(), refresh: true });
    expect(result!.changed).toBe(true);
  });

  it("CLI add exits 0 but post-verification shows server absent → throws", async () => {
    let probeCount = 0;
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") {
        probeCount++;
        return { code: 1, stdout: "", stderr: "No MCP server found" };
      }
      if (args[1] === "add") return { code: 0, stdout: "added", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    await expect(applyClaudeViaCli(cliDefaults())).rejects.toThrow(/refusing to claim install succeeded/);
  });

  it("CLI add exits non-zero → throws with stderr in message", async () => {
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") return { code: 1, stdout: "", stderr: "absent" };
      if (args[1] === "add") return { code: 1, stdout: "", stderr: "permission denied to ~/.claude.json" };
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    await expect(applyClaudeViaCli(cliDefaults())).rejects.toThrow(/permission denied/);
  });

  it("CLI add returns ENOENT mid-flight (race) → returns null to fall back", async () => {
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") return { code: 1, stdout: "", stderr: "absent" };
      if (args[1] === "add") return { code: -1, codeName: "ENOENT", stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    expect(await applyClaudeViaCli(cliDefaults())).toBeNull();
  });

  it("dryRun + server absent → reports 'would run' without calling add", async () => {
    let addCalled = false;
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") return { code: 1, stdout: "", stderr: "absent" };
      if (args[1] === "add") {
        addCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    const result = await applyClaudeViaCli({ ...cliDefaults(), dryRun: true });
    expect(result!.changed).toBe(true);
    expect(result!.reason).toMatch(/would run: claude mcp add/);
    expect(addCalled).toBe(false);
  });

  it("dryRun + server present + env in sync → reports no-op (no false positive)", async () => {
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") return { code: 0, stdout: `Scope: User config\n${expectedEnvLines()}`, stderr: "" };
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    _setExecRunnerForTests(runner);
    const result = await applyClaudeViaCli({ ...cliDefaults(), dryRun: true });
    expect(result!.changed).toBe(false);
  });
});

describe("applyCodexViaCli", () => {
  beforeEach(() => _resetExecRunnerForTests());
  afterEach(() => _resetExecRunnerForTests());

  it("returns null on custom --codex-config", async () => {
    const { runner, calls } = makeMockRunner([]);
    _setExecRunnerForTests(runner);
    const opts: CliOptions = { ...cliDefaults(), codexPath: "/tmp/custom.toml" };
    expect(await applyCodexViaCli(opts)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("CLI absent → null", async () => {
    const { runner } = makeMockRunner([{ code: -1, codeName: "ENOENT", stderr: "" }]);
    _setExecRunnerForTests(runner);
    expect(await applyCodexViaCli(cliDefaults())).toBeNull();
  });

  it("CLI present, server absent → installs successfully", async () => {
    let probeCount = 0;
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "codex 0.130", stderr: "" };
      if (args[1] === "get") {
        probeCount++;
        if (probeCount === 1) return { code: 1, stdout: "", stderr: "Error: No MCP server" };
        return { code: 0, stdout: "holographic-memory\n  enabled: true\n  env: " + Object.keys(buildEnvKeys()).join("=*****, ") + "=*****", stderr: "" };
      }
      if (args[1] === "add") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    const result = await applyCodexViaCli(cliDefaults());
    expect(result!.changed).toBe(true);
  });

  it("CLI add reports success but verification fails → throws", async () => {
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "codex 0.130", stderr: "" };
      if (args[1] === "get") return { code: 1, stdout: "", stderr: "absent" };
      if (args[1] === "add") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    await expect(applyCodexViaCli(cliDefaults())).rejects.toThrow(/refusing to claim install succeeded/);
  });
});

function buildEnvKeys() {
  return {
    PAPERCLIP_HOLO_MEMORY_DB: 1,
    PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED: 1,
    PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED: 1,
    PAPERCLIP_HOLO_MEMORY_MIN_TRUST: 1,
    PAPERCLIP_HOLO_MEMORY_MAX_RECALL: 1,
  };
}

describe("applyClaudeUninstallViaCli", () => {
  beforeEach(() => _resetExecRunnerForTests());
  afterEach(() => _resetExecRunnerForTests());

  it("server absent → no-op", async () => {
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") return { code: 1, stdout: "", stderr: "absent" };
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    _setExecRunnerForTests(runner);
    const result = await applyClaudeUninstallViaCli(cliDefaults());
    expect(result!.changed).toBe(false);
    expect(result!.reason).toMatch(/absent/);
  });

  it("server present → removes and verifies", async () => {
    let probeCount = 0;
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") {
        probeCount++;
        if (probeCount === 1) return { code: 0, stdout: `Scope: User config\n${expectedEnvLines()}`, stderr: "" };
        return { code: 1, stdout: "", stderr: "absent" };
      }
      if (args[1] === "remove") return { code: 0, stdout: "removed", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    const result = await applyClaudeUninstallViaCli(cliDefaults());
    expect(result!.changed).toBe(true);
    expect(result!.reason).toMatch(/removed via claude mcp/);
  });

  it("remove succeeds but post-verification still shows entry → throws", async () => {
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "claude 2.0.0", stderr: "" };
      if (args[1] === "get") return { code: 0, stdout: `Scope: User config\n${expectedEnvLines()}`, stderr: "" };
      if (args[1] === "remove") return { code: 0, stdout: "removed", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    await expect(applyClaudeUninstallViaCli(cliDefaults())).rejects.toThrow(/still present/);
  });
});

describe("applyCodexUninstallViaCli", () => {
  beforeEach(() => _resetExecRunnerForTests());
  afterEach(() => _resetExecRunnerForTests());

  it("server absent → no-op", async () => {
    const runner: ExecRunner = async (cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "codex 0.130", stderr: "" };
      if (args[1] === "get") return { code: 1, stdout: "", stderr: "absent" };
      return { code: 0, stdout: "", stderr: "" };
    };
    _setExecRunnerForTests(runner);
    const result = await applyCodexUninstallViaCli(cliDefaults());
    expect(result!.changed).toBe(false);
  });
});

describe("migrateLegacyClaudeSettings", () => {
  let tmpDir: string;
  let target: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "setupmcp-migrate-"));
    target = path.join(tmpDir, "settings.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("missing file → no-change", async () => {
    const result = await migrateLegacyClaudeSettings(false, target);
    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/no legacy settings.json/);
  });

  it("removes our entry while preserving siblings", async () => {
    writeFileSync(
      target,
      JSON.stringify({
        permissions: { defaultMode: "auto" },
        mcpServers: {
          "holographic-memory": { command: "npx", args: ["x"] },
          "code-review-graph": { command: "uvx", args: ["code-review-graph", "serve"] },
        },
      }),
    );
    const result = await migrateLegacyClaudeSettings(false, target);
    expect(result.changed).toBe(true);
    const after = JSON.parse(readFileSync(target, "utf8"));
    expect(after.mcpServers).toEqual({
      "code-review-graph": { command: "uvx", args: ["code-review-graph", "serve"] },
    });
    expect(after.permissions.defaultMode).toBe("auto");
  });

  it("drops empty mcpServers when our entry was the only one", async () => {
    writeFileSync(
      target,
      JSON.stringify({ mcpServers: { "holographic-memory": { command: "npx" } } }),
    );
    const result = await migrateLegacyClaudeSettings(false, target);
    expect(result.changed).toBe(true);
    const after = JSON.parse(readFileSync(target, "utf8"));
    expect(after.mcpServers).toBeUndefined();
  });

  it("dryRun does not mutate the file", async () => {
    const original = JSON.stringify({ mcpServers: { "holographic-memory": { command: "npx" } } });
    writeFileSync(target, original);
    const result = await migrateLegacyClaudeSettings(true, target);
    expect(result.changed).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  it("malformed JSON → tolerant skip, file untouched", async () => {
    writeFileSync(target, "{not valid json");
    const result = await migrateLegacyClaudeSettings(false, target);
    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/malformed/);
    expect(readFileSync(target, "utf8")).toBe("{not valid json");
  });

  it("bad shape (mcpServers as string) → tolerant skip", async () => {
    writeFileSync(target, JSON.stringify({ mcpServers: "wat" }));
    const result = await migrateLegacyClaudeSettings(false, target);
    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/bad shape/);
  });

  it("entry already absent → no-change", async () => {
    writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const result = await migrateLegacyClaudeSettings(false, target);
    expect(result.changed).toBe(false);
  });
});

describe("Codex unmarked-entry collision guard (file-write path)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "setupmcp-codex-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applyCodex throws when an unmarked [mcp_servers.holographic-memory] table exists", async () => {
    const codexPath = path.join(tmpDir, "config.toml");
    writeFileSync(codexPath, '[mcp_servers.holographic-memory]\ncommand = "npx"\nargs = ["x"]\n');
    const opts: CliOptions = { ...cliDefaults(), codexPath };
    await expect(applyCodex(opts)).rejects.toThrow(/Run 'codex mcp remove holographic-memory'/);
  });

  it("applyCodexUninstall throws when an unmarked entry is present", async () => {
    const codexPath = path.join(tmpDir, "config.toml");
    writeFileSync(codexPath, '[mcp_servers.holographic-memory]\ncommand = "npx"\nargs = ["x"]\n');
    const opts: CliOptions = { ...cliDefaults(), codexPath };
    await expect(applyCodexUninstall(opts)).rejects.toThrow(/Run 'codex mcp remove holographic-memory'/);
  });

  it("applyCodex accepts a clean (empty) file", async () => {
    const codexPath = path.join(tmpDir, "config.toml");
    writeFileSync(codexPath, "");
    const opts: CliOptions = { ...cliDefaults(), codexPath };
    const outcome = await applyCodex(opts);
    expect(outcome.changed).toBe(true);
  });
});
