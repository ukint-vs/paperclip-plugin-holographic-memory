#!/usr/bin/env node
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { atomicWrite } from "../src/atomic-write.js";
import { isInvokedAsScript } from "../src/invoked-as-script.js";

// Idempotent merger that registers (or removes) the holographic-memory MCP
// server in the user's Claude Code (~/.claude/settings.json -> mcpServers)
// and Codex (~/.codex/config.toml -> [mcp_servers.holographic-memory]) configs.
//
// Behavior matrix:
//   missing file       -> create with mode 0600 (install) / no-op (uninstall)
//   valid file         -> backup .bak, atomic merge (tmp + rename)
//   malformed (parse)  -> abort exit 2 with diagnostic, never touch the file
//   malformed (shape)  -> abort exit 2 (e.g. mcpServers is a string/array/null)
//   symlink            -> resolved write
//   --print            -> stdout only, no writes (install OR uninstall snippets)
//   --dry-run          -> diff-style preview, no writes
//   --refresh          -> rewrite the entry even if marker present (install-only)
//   --uninstall        -> remove the entry from both configs (mirror of install)
//
// Concurrent runs: unsupported. The .bak rotation + atomic-rename pair is
// not transactional across processes; running install + uninstall (or two
// installs) at once against the same target file races. Single-user dev is
// the only supported usage today.
//
// Partial-success: if --scope=both writes Claude OK then Codex fails (or vice
// versa), the run aborts at exit 2 with the second target untouched. Rerun
// is safe — both install and uninstall are idempotent so the recovery path
// is "fix whatever broke and rerun the same command."

const SERVER_NAME = "holographic-memory";
const PACKAGE_NAME = "paperclip-plugin-holographic-memory";
const BIN_NAME = "paperclip-holographic-memory-mcp";
const TOML_MARKER_BEGIN = `# managed by paperclip-plugin-${SERVER_NAME}`;
const TOML_MARKER_END = `# end paperclip-plugin-${SERVER_NAME}`;
const DEFAULT_DB_PATH = "~/.paperclip/instances/default/hermes-memory.db";
const DEFAULT_COMMAND = "npx";
// `-y` suppresses npx's install prompt. `--package <PACKAGE_NAME>` tells npx
// which package to install before running the bin — without it, npx assumes
// the bin name equals the package name and either fails or installs a
// squatter package matching the bin name. Bin name and package name diverge
// here (paperclip-plugin-holographic-memory vs paperclip-holographic-memory-mcp)
// so --package is load-bearing.
const DEFAULT_ARGS = ["-y", "--package", PACKAGE_NAME, BIN_NAME];

export interface CliOptions {
  print: boolean;
  dryRun: boolean;
  refresh: boolean;
  uninstall: boolean;
  scope: "claude" | "codex" | "both";
  dbPath: string;
  recallEnabled: boolean;
  retainEnabled: boolean;
  minTrust: number;
  maxRecall: number;
  command: string;
  args: string[];
  claudePath: string;
  codexPath: string;
}

// Aliases for canonical flag names. `--command` accepted as alias for
// `--command-path` because earlier docs/blog posts referenced the shorter
// spelling; silent ignore on the canonical name would corrupt setup
// invocations users copy-pasted from older sources.
const FLAG_ALIASES: Record<string, readonly string[]> = {
  "command-path": ["command"],
};

// parseFlag accepts both space (`--name VALUE`) and equals (`--name=VALUE`)
// forms. Equals form is what GNU long-option convention sets users' fingers
// to type; space form was the original implementation. Both must work or
// silent misconfig.
function parseFlag<T>(argv: string[], name: string, parse: (raw: string) => T): T | undefined {
  const dashed = `--${name}`;
  // Equals form first: --name=VALUE
  for (const arg of argv) {
    if (arg.startsWith(`${dashed}=`)) {
      return parse(arg.slice(dashed.length + 1));
    }
  }
  // Space form: --name VALUE
  const idx = argv.indexOf(dashed);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return parse(value);
}

function parseFlagWithAliases<T>(argv: string[], canonical: string, parse: (raw: string) => T): T | undefined {
  const direct = parseFlag(argv, canonical, parse);
  if (direct !== undefined) return direct;
  for (const alias of FLAG_ALIASES[canonical] ?? []) {
    const aliased = parseFlag(argv, alias, parse);
    if (aliased !== undefined) return aliased;
  }
  return undefined;
}

// Accept the same boolean spellings the env-var parser in mcp-server.ts does
// so `--recall 1` / `--recall yes` don't silently turn it off (the previous
// `s === "true"` parser returned false for everything except "true").
function parseBoolFlag(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// hasFlag also recognizes `--name=anything` form.
function hasFlag(argv: string[], name: string): boolean {
  if (argv.includes(`--${name}`)) return true;
  return argv.some((arg) => arg.startsWith(`--${name}=`));
}

export function parseArgs(argv: string[]): CliOptions {
  const has = (name: string) => hasFlag(argv, name);
  const scopeRaw = parseFlag(argv, "scope", (s) => s) ?? "both";
  if (!["claude", "codex", "both"].includes(scopeRaw)) {
    throw new Error(`--scope must be one of claude|codex|both, got "${scopeRaw}"`);
  }
  const uninstall = has("uninstall");
  const refresh = has("refresh");
  if (uninstall && refresh) {
    // --refresh is install-only semantics ("rewrite the entry even if already
    // present"). Pairing it with --uninstall has no defined meaning.
    throw new Error("--uninstall and --refresh cannot be combined; --refresh is install-only.");
  }
  const dbPath =
    parseFlag(argv, "db-path", (s) => s) ?? process.env.PAPERCLIP_HOLO_MEMORY_DB ?? DEFAULT_DB_PATH;
  const command = parseFlagWithAliases(argv, "command-path", (s) => s) ?? DEFAULT_COMMAND;
  // Empty `--args=` yields an empty array, useful when overriding to a
  // direct global-install bin invocation that takes no npx-prefix args.
  const argsFlag = parseFlag(argv, "args", (s) =>
    s.length === 0 ? [] : s.split(",").map((part) => part.trim()).filter(Boolean),
  );
  return {
    print: has("print"),
    dryRun: has("dry-run"),
    refresh,
    uninstall,
    scope: scopeRaw as "claude" | "codex" | "both",
    dbPath,
    recallEnabled: parseFlag(argv, "recall", parseBoolFlag) ?? true,
    retainEnabled: parseFlag(argv, "retain", parseBoolFlag) ?? true,
    minTrust: parseFlag(argv, "min-trust", (s) => Number(s)) ?? 0.3,
    maxRecall: parseFlag(argv, "max-recall", (s) => Number(s)) ?? 10,
    command,
    args: argsFlag ?? DEFAULT_ARGS,
    claudePath: parseFlag(argv, "claude-config", (s) => s) ?? path.join(homedir(), ".claude", "settings.json"),
    codexPath: parseFlag(argv, "codex-config", (s) => s) ?? path.join(homedir(), ".codex", "config.toml"),
  };
}

function buildEnv(opts: CliOptions): Record<string, string> {
  return {
    PAPERCLIP_HOLO_MEMORY_DB: opts.dbPath,
    PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED: String(opts.recallEnabled),
    PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED: String(opts.retainEnabled),
    PAPERCLIP_HOLO_MEMORY_MIN_TRUST: String(opts.minTrust),
    PAPERCLIP_HOLO_MEMORY_MAX_RECALL: String(opts.maxRecall),
  };
}

export function buildClaudeEntry(opts: CliOptions): Record<string, unknown> {
  return {
    command: opts.command,
    args: opts.args,
    env: buildEnv(opts),
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function backup(target: string): Promise<void> {
  if (!(await pathExists(target))) return;
  // Preserve any existing .bak as .bak.prev so users keep a one-step recovery
  // history. Without this, two consecutive `pnpm setup:mcp` runs (e.g. user
  // edited config between them) overwrite the original-state .bak with the
  // post-first-run state, destroying the only recovery point.
  const bakPath = `${target}.bak`;
  if (await pathExists(bakPath)) {
    await fs.rename(bakPath, `${target}.bak.prev`).catch(() => undefined);
  }
  await fs.copyFile(target, bakPath);
}

// Resolve a path through any symlinks so we write to the real file, not
// replace the symlink with a regular file. Dotfile managers (stow, chezmoi,
// nix home-manager) put settings.json/config.toml as symlinks; the previous
// implementation called fs.rename(tmp, target) which replaces the symlink
// itself, silently disconnecting the dotfile repo from the live config.
// Falls back to the original path when realpath fails (e.g. file doesn't
// exist yet — atomicWrite will create it as a regular file).
async function resolveTarget(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

interface MergeOutcome {
  changed: boolean;
  reason: string;
  output: string;
}

// ---------------------------------------------------------------------------
// Claude Code: ~/.claude/settings.json
// JSON merge into the top-level mcpServers field. Preserves all sibling keys.
// ---------------------------------------------------------------------------

export interface ClaudeSettingsLike {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

// Validate the top-level shape of settings.json before mutation. Without
// this, `mcpServers` set to a string/array/null would spread blindly and
// corrupt the user's config silently. Throws with a diagnostic on
// semantic malformation; the caller catches and exits 2.
// Exported for unit testing (called from applyClaude + applyClaudeUninstall).
export function validateClaudeSettings(parsed: unknown, target: string): ClaudeSettingsLike {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const what =
      parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`;
    throw new Error(
      `Refusing to touch ${target}: top-level value is ${what}, expected an object. Fix the file or pass --print and copy manually.`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if ("mcpServers" in obj) {
    const ms = obj.mcpServers;
    if (ms === null || typeof ms !== "object" || Array.isArray(ms)) {
      const what = ms === null ? "null" : Array.isArray(ms) ? "an array" : `a ${typeof ms}`;
      throw new Error(
        `Refusing to touch ${target}: mcpServers is ${what}, expected an object. Fix the file or pass --print and copy manually.`,
      );
    }
  }
  return obj as ClaudeSettingsLike;
}

export function mergeClaudeSettings(
  existing: ClaudeSettingsLike | null,
  entry: Record<string, unknown>,
  refresh: boolean,
): MergeOutcome {
  const base: ClaudeSettingsLike = existing ?? {};
  const servers = { ...(base.mcpServers ?? {}) };
  const current = servers[SERVER_NAME];
  const same = current !== undefined && JSON.stringify(current) === JSON.stringify(entry);
  if (same && !refresh) {
    return {
      changed: false,
      reason: `mcpServers.${SERVER_NAME} already up to date`,
      output: JSON.stringify(base, null, 2) + "\n",
    };
  }
  servers[SERVER_NAME] = entry;
  const merged: ClaudeSettingsLike = { ...base, mcpServers: servers };
  return {
    changed: true,
    reason: current === undefined ? `add mcpServers.${SERVER_NAME}` : `refresh mcpServers.${SERVER_NAME}`,
    output: JSON.stringify(merged, null, 2) + "\n",
  };
}

export function mergeClaudeUninstall(existing: ClaudeSettingsLike | null): MergeOutcome {
  if (existing === null) {
    return { changed: false, reason: "no settings file present", output: "" };
  }
  if (!existing.mcpServers || !(SERVER_NAME in existing.mcpServers)) {
    // Output is unused on no-change paths in run() — match the empty-output
    // shape of the "no settings file" branch above (and mergeCodexUninstall's
    // already-absent branch) instead of re-stringifying for nothing.
    return { changed: false, reason: `mcpServers.${SERVER_NAME} already absent`, output: "" };
  }
  const servers: Record<string, unknown> = { ...existing.mcpServers };
  delete servers[SERVER_NAME];
  // Drop the mcpServers key entirely if removing our entry empties it,
  // rather than leaving a dangling `"mcpServers": {}` that wasn't there
  // before this plugin was installed.
  const merged: ClaudeSettingsLike = { ...existing };
  if (Object.keys(servers).length === 0) {
    delete merged.mcpServers;
  } else {
    merged.mcpServers = servers;
  }
  return {
    changed: true,
    reason: `remove mcpServers.${SERVER_NAME}`,
    output: JSON.stringify(merged, null, 2) + "\n",
  };
}

async function applyClaude(opts: CliOptions): Promise<MergeOutcome> {
  const entry = buildClaudeEntry(opts);
  let existing: ClaudeSettingsLike | null = null;
  if (await pathExists(opts.claudePath)) {
    const raw = await fs.readFile(opts.claudePath, "utf8");
    if (raw.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        const message = (error as Error).message;
        throw new Error(`Refusing to overwrite ${opts.claudePath}: invalid JSON (${message}). Fix the file or pass --print and copy manually.`);
      }
      existing = validateClaudeSettings(parsed, opts.claudePath);
    }
  }
  return mergeClaudeSettings(existing, entry, opts.refresh);
}

async function applyClaudeUninstall(opts: CliOptions): Promise<MergeOutcome> {
  if (!(await pathExists(opts.claudePath))) {
    return { changed: false, reason: "no settings file present", output: "" };
  }
  const raw = await fs.readFile(opts.claudePath, "utf8");
  if (raw.trim().length === 0) {
    return { changed: false, reason: "settings file empty", output: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Refusing to overwrite ${opts.claudePath}: invalid JSON (${(error as Error).message}). Fix the file or pass --print and copy manually.`,
    );
  }
  const validated = validateClaudeSettings(parsed, opts.claudePath);
  return mergeClaudeUninstall(validated);
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/config.toml
// Marker-block append. Never round-trips the user's TOML through a parser
// (would lose comments). Validates that the resulting file parses cleanly.
// ---------------------------------------------------------------------------

export function buildCodexBlock(opts: CliOptions): string {
  // Inline-table env keeps the block compact and one-paste; matches the
  // style of the [mcp_servers.context7] block already in the user's config.
  const argsLiteral = JSON.stringify(opts.args);
  const env = buildEnv(opts);
  const envInline = Object.entries(env)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(", ");
  return [
    TOML_MARKER_BEGIN,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(opts.command)}`,
    `args = ${argsLiteral}`,
    `env = { ${envInline} }`,
    TOML_MARKER_END,
  ].join("\n");
}

// Marker regexes are anchored to start-of-line (with the `m` flag) so we can't
// false-positive match the literal marker text appearing inside a user's own
// commented-out block. Otherwise an `indexOf` on `# managed by ...` would
// pick up commented-out marker prose and stitch across user content.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `[ \t]*` (not `\s*`) for the trailing slack — `\s` matches newlines too,
// which under the `m` flag would let the match consume past end-of-line and
// throw off the slice boundary used to extract the existing block.
const TOML_MARKER_BEGIN_RE = new RegExp(`^${escapeRegExp(TOML_MARKER_BEGIN)}[ \\t]*$`, "m");
const TOML_MARKER_END_RE = new RegExp(`^${escapeRegExp(TOML_MARKER_END)}[ \\t]*$`, "m");

export function mergeCodexConfig(existing: string, block: string, refresh: boolean): MergeOutcome {
  const startMatch = TOML_MARKER_BEGIN_RE.exec(existing);
  const endMatch = TOML_MARKER_END_RE.exec(existing);
  if (startMatch && endMatch && endMatch.index > startMatch.index) {
    const startIdx = startMatch.index;
    const endIdx = endMatch.index + endMatch[0].length;
    const beforeBlock = existing.slice(0, startIdx);
    const afterBlock = existing.slice(endIdx);
    const currentBlock = existing.slice(startIdx, endIdx);
    if (currentBlock === block && !refresh) {
      return { changed: false, reason: "[mcp_servers.holographic-memory] already up to date", output: existing };
    }
    const stitched = `${beforeBlock}${block}${afterBlock}`;
    return { changed: true, reason: "refresh [mcp_servers.holographic-memory] block", output: stitched };
  }
  // Append as a new block. Ensure exactly one blank line of separation
  // between the user's existing content and our marker, and exactly one
  // trailing newline.
  const trimmed = existing.replace(/\s+$/, "");
  const separator = trimmed.length === 0 ? "" : "\n\n";
  const output = `${trimmed}${separator}${block}\n`;
  return { changed: true, reason: "append [mcp_servers.holographic-memory] block", output };
}

export function mergeCodexUninstall(existing: string): MergeOutcome {
  const startMatch = TOML_MARKER_BEGIN_RE.exec(existing);
  const endMatch = TOML_MARKER_END_RE.exec(existing);
  if (!startMatch && !endMatch) {
    return { changed: false, reason: "marker block already absent", output: existing };
  }
  // Partial-marker corruption: BEGIN-without-END, END-without-BEGIN, or
  // END-before-BEGIN. Throw so run() exits 2 instead of falsely reporting
  // a clean uninstall — otherwise `setup --uninstall && npm uninstall`
  // automation succeeds with the entry still wired up, dangling after
  // npm-uninstall removes the bin. The malformed-JSON/TOML guard paths
  // throw for the same reason; mirror that contract here.
  if (!startMatch || !endMatch || endMatch.index < startMatch.index) {
    const which = !startMatch
      ? "END marker without BEGIN"
      : !endMatch
        ? "BEGIN marker without END"
        : "END marker before BEGIN";
    throw new Error(
      `Refusing to uninstall: marker block corrupt (${which}). Hand-fix the markers in the codex config or use --print to regenerate.`,
    );
  }
  // Strip from BEGIN line through END line, including the END's trailing
  // newline if present so we don't leave an orphan blank line.
  const startIdx = startMatch.index;
  const endIdx = endMatch.index + endMatch[0].length;
  const trailingNewline = existing[endIdx] === "\n" ? 1 : 0;
  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + trailingNewline);
  // Collapse the separator that the install path inserted: a leading "\n\n"
  // before the block becomes a single "\n" after removal.
  const beforeTrimmed = before.replace(/\n\s*$/, "");
  const beforeOut = beforeTrimmed.length === 0 ? "" : beforeTrimmed + "\n";
  const afterOut = after.replace(/^\s*\n/, "");
  const output = beforeOut + afterOut;
  return { changed: true, reason: `remove [mcp_servers.${SERVER_NAME}] block`, output };
}

async function applyCodex(opts: CliOptions): Promise<MergeOutcome> {
  const block = buildCodexBlock(opts);
  let existing = "";
  if (await pathExists(opts.codexPath)) {
    existing = await fs.readFile(opts.codexPath, "utf8");
  }
  // Guard #1: refuse to touch a malformed existing file. Otherwise the
  // marker-block append would silently clobber the user's broken-but-fixable
  // edits with our overlay on top.
  if (existing.trim().length > 0) {
    try {
      TOML.parse(existing);
    } catch (error) {
      throw new Error(
        `Refusing to overwrite ${opts.codexPath}: existing TOML is malformed (${(error as Error).message}). Fix the file or pass --print and copy manually.`,
      );
    }
  }
  const outcome = mergeCodexConfig(existing, block, opts.refresh);
  // Guard #2: validate the resulting TOML parses cleanly. We never write
  // the parsed output (that would strip comments); we only use the parser
  // as a syntax guard so a buggy block doesn't render the user's Codex
  // unstartable.
  if (outcome.changed) {
    try {
      TOML.parse(outcome.output);
    } catch (error) {
      throw new Error(
        `Refusing to write ${opts.codexPath}: resulting TOML would not parse (${(error as Error).message}). This is a bug in setup-mcp.ts; pass --print and copy manually.`,
      );
    }
  }
  return outcome;
}

async function applyCodexUninstall(opts: CliOptions): Promise<MergeOutcome> {
  if (!(await pathExists(opts.codexPath))) {
    return { changed: false, reason: "no codex config present", output: "" };
  }
  const existing = await fs.readFile(opts.codexPath, "utf8");
  if (existing.trim().length === 0) {
    return { changed: false, reason: "codex config empty", output: "" };
  }
  // Same parse guard as install: don't touch malformed TOML.
  try {
    TOML.parse(existing);
  } catch (error) {
    throw new Error(
      `Refusing to overwrite ${opts.codexPath}: existing TOML is malformed (${(error as Error).message}). Fix the file or pass --print and copy manually.`,
    );
  }
  const outcome = mergeCodexUninstall(existing);
  // Validate the post-removal TOML still parses (it should — we only
  // strip lines, never add). Guards against accidental bracket damage
  // from the slice math.
  if (outcome.changed && outcome.output.trim().length > 0) {
    try {
      TOML.parse(outcome.output);
    } catch (error) {
      throw new Error(
        `Refusing to write ${opts.codexPath}: post-uninstall TOML would not parse (${(error as Error).message}). This is a bug in setup-mcp.ts; pass --print and copy manually.`,
      );
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printSnippets(opts: CliOptions): void {
  const claudeEntry = buildClaudeEntry(opts);
  const claudeSnippet = JSON.stringify({ mcpServers: { [SERVER_NAME]: claudeEntry } }, null, 2);
  process.stdout.write(`# Add to ${opts.claudePath} (merge into mcpServers):\n${claudeSnippet}\n\n`);
  process.stdout.write(`# Add to ${opts.codexPath} (append):\n${buildCodexBlock(opts)}\n`);
}

function printUninstallSnippets(opts: CliOptions): void {
  process.stdout.write(`# Remove from ${opts.claudePath} (delete this key under mcpServers):\n  "${SERVER_NAME}"\n\n`);
  process.stdout.write(
    `# Remove from ${opts.codexPath} (delete from BEGIN through END marker, inclusive):\n${TOML_MARKER_BEGIN}\n[mcp_servers.${SERVER_NAME}]\n... (config lines) ...\n${TOML_MARKER_END}\n`,
  );
}

async function run(opts: CliOptions): Promise<number> {
  if (opts.print) {
    if (opts.uninstall) {
      printUninstallSnippets(opts);
    } else {
      printSnippets(opts);
    }
    return 0;
  }

  type Apply = () => Promise<MergeOutcome>;
  const tasks: Array<["claude" | "codex", string, Apply]> = [];
  if (opts.scope === "claude" || opts.scope === "both") {
    tasks.push([
      "claude",
      opts.claudePath,
      opts.uninstall ? () => applyClaudeUninstall(opts) : () => applyClaude(opts),
    ]);
  }
  if (opts.scope === "codex" || opts.scope === "both") {
    tasks.push([
      "codex",
      opts.codexPath,
      opts.uninstall ? () => applyCodexUninstall(opts) : () => applyCodex(opts),
    ]);
  }

  let allClean = true;
  for (const [label, target, fn] of tasks) {
    let outcome: MergeOutcome;
    try {
      outcome = await fn();
    } catch (error) {
      process.stderr.write(`[${label}] ${(error as Error).message}\n`);
      return 2;
    }
    if (!outcome.changed) {
      process.stdout.write(`[${label}] ${target}: ${outcome.reason} (no change)\n`);
      continue;
    }
    allClean = false;
    if (opts.dryRun) {
      // outcome.reason already names the action ("add"/"remove"/"refresh"),
      // so the prefix is just "would" regardless of install vs uninstall.
      process.stdout.write(`[${label}] ${target}: would ${outcome.reason}\n`);
      process.stdout.write(`---- ${target} (preview) ----\n${outcome.output}---- end preview ----\n`);
      continue;
    }
    // Resolve symlinks so we update the real file (the dotfile-repo source
    // for stow / chezmoi / nix-home-manager users) instead of replacing the
    // symlink with a regular file via fs.rename. Backup also operates on
    // the resolved path so the .bak sits next to the real source.
    const realTarget = await resolveTarget(target);
    await backup(realTarget);
    await atomicWrite(realTarget, outcome.output, 0o600);
    const noteSuffix = realTarget !== target ? ` (resolved from ${target})` : "";
    process.stdout.write(`[${label}] ${realTarget}${noteSuffix}: ${outcome.reason}; backup at ${realTarget}.bak\n`);
  }

  if (opts.dryRun && allClean) {
    process.stdout.write("dry-run: nothing to change\n");
  }
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`Usage: setup-mcp [options]

Registers (or removes) the holographic-memory MCP server in:
  ~/.claude/settings.json   (Claude Code mcpServers)
  ~/.codex/config.toml      ([mcp_servers.holographic-memory])

Options:
  --print               Print snippets to stdout, no writes
                        (with --uninstall: print "remove" instructions)
  --dry-run             Show what would change, no writes
  --refresh             Rewrite entries even if already present (install-only)
  --uninstall           Remove the entry from both configs (mirror of install)
  --scope <s>           claude | codex | both (default: both)
  --db-path <path>      DB path (default: ${DEFAULT_DB_PATH})
  --command-path <bin>  MCP command (default: ${DEFAULT_COMMAND})
                        Alias: --command
  --args a,b,c          Comma-separated args (also accepts --args=a,b,c)
                        Default: ${DEFAULT_ARGS.join(",")}
                        Empty (--args=) for direct global-bin invocation.
  --recall true|false   recallEnabled in MCP mode (default: true)
  --retain true|false   retainEnabled in MCP mode (default: true)
  --min-trust <num>     minTrustScore (default: 0.3)
  --max-recall <num>    maxFactsPerRecall (default: 10)
  --claude-config <p>   override ~/.claude/settings.json path
  --codex-config <p>    override ~/.codex/config.toml path
`);
    return;
  }

  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  }
  const code = await run(opts);
  if (code !== 0) process.exit(code);
}

// Helper resolves symlinks so npm-bin invocations
// (/usr/local/bin/paperclip-holographic-memory-setup → dist/setup-mcp.js)
// are detected correctly. 0.4.0 shipped a regex-on-argv1 guard that missed
// every npm-bin user.
if (isInvokedAsScript(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`setup-mcp failed: ${(error as Error).message}\n`);
    process.exit(2);
  });
}
