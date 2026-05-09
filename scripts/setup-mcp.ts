#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import TOML from "@iarna/toml";
import { atomicWrite } from "../src/atomic-write.js";
import { isInvokedAsScript } from "../src/invoked-as-script.js";

// Registers (or removes) the holographic-memory MCP server via the official
// CLIs (`claude mcp add --scope user`, `codex mcp add`), falling back to
// direct file writes (~/.claude.json, ~/.codex/config.toml) when the CLI is
// unavailable.
//
// Issue #34 background: previous versions wrote ~/.claude/settings.json
// (Claude Code 1.x location). Claude Code 2.x reads ~/.claude.json instead,
// so the old write was silently ignored. setup-mcp ≤0.4.1 left a stale
// entry in ~/.claude/settings.json; install/uninstall now cleans that up
// automatically.
//
// Behavior matrix (file fallback path):
//   missing file       -> create with mode 0600 (install) / no-op (uninstall)
//   valid file         -> backup .bak, atomic merge (tmp + rename)
//   malformed (parse)  -> abort exit 2 with diagnostic, never touch the file
//   malformed (shape)  -> abort exit 2 (e.g. mcpServers is a string/array/null)
//   symlink            -> resolved write
//   --print            -> stdout only, no writes (CLI command lines)
//   --dry-run          -> diff-style preview, no writes
//   --refresh          -> rewrite the entry even if present (install-only)
//   --uninstall        -> remove the entry (mirror of install)
//
// CLI shell-out path:
//   - Install runs `mcp get` for idempotency, `mcp remove` then `mcp add` on
//     refresh / drift / scope mismatch, then a second `mcp get` to verify the
//     entry actually persisted (catches "exit 0 but didn't write" failures).
//   - CLI not on PATH (ENOENT) -> fall back to file write.
//   - CLI present but errored -> hard fail (don't fall back; falling back
//     would create config drift between the two locations).
//   - --claude-config <custom> forces file fallback (the CLI doesn't accept
//     arbitrary config locations).
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
const DEFAULT_CLAUDE_PATH = path.join(homedir(), ".claude.json");
const LEGACY_CLAUDE_SETTINGS_PATH = path.join(homedir(), ".claude", "settings.json");
const DEFAULT_CODEX_PATH = path.join(homedir(), ".codex", "config.toml");
const CLAUDE_CLI = "claude";
const CODEX_CLI = "codex";
const CLI_EXEC_TIMEOUT_MS = 10_000;
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
    claudePath: parseFlag(argv, "claude-config", (s) => s) ?? DEFAULT_CLAUDE_PATH,
    codexPath: parseFlag(argv, "codex-config", (s) => s) ?? DEFAULT_CODEX_PATH,
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

export async function applyCodex(opts: CliOptions): Promise<MergeOutcome> {
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
  // Guard #1.5: refuse to overlay a second [mcp_servers.holographic-memory]
  // table when an unmarked one is already present (likely added by
  // `codex mcp add` directly). Appending a second same-named table would
  // produce invalid TOML and trip Guard #2 with a confusing error.
  if (hasUnmarkedCodexEntry(existing)) {
    throw new Error(
      `Refusing to overlay ${opts.codexPath}: an existing [mcp_servers.${SERVER_NAME}] section without our markers is present (likely added by 'codex mcp add' directly). Run 'codex mcp remove ${SERVER_NAME}' first, or pass --print to copy the new block manually.`,
    );
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

export async function applyCodexUninstall(opts: CliOptions): Promise<MergeOutcome> {
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
  // If an unmarked [mcp_servers.holographic-memory] section is present, our
  // marker-block uninstall would leave it dangling. Surface the hint instead
  // of silently doing nothing.
  if (hasUnmarkedCodexEntry(existing)) {
    throw new Error(
      `Refusing to uninstall: ${opts.codexPath} has an unmarked [mcp_servers.${SERVER_NAME}] section (likely added by 'codex mcp add' directly). Run 'codex mcp remove ${SERVER_NAME}' instead.`,
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
// CLI shell-out helpers
//
// `claude mcp add --scope user` and `codex mcp add` are the canonical entry
// points; they own the on-disk config format. We prefer them over direct
// file writes — the file-write path is the fallback for users who don't
// have the CLIs on PATH (CI, containers, fresh installs before the CLIs
// are available).
//
// Detection vs error semantics:
//   CLI not on PATH (ENOENT)    -> return null, caller falls back to file write
//   CLI present, exits non-zero -> hard fail (don't fall back; that would
//                                  create config drift between two locations)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  codeName?: string; // e.g. "ENOENT" when binary missing
}

export type ExecRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

const defaultExecRunner: ExecRunner = async (cmd, args, timeoutMs) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    // execFile rejects with code:'ENOENT' when binary missing,
    // and with code:<number> when child exits non-zero.
    if (typeof e.code === "string") {
      return { code: -1, stdout: "", stderr: e.message ?? "", codeName: e.code };
    }
    const exit = typeof e.code === "number" ? e.code : 1;
    return { code: exit, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
  }
};

let _execRunner: ExecRunner = defaultExecRunner;
export function _setExecRunnerForTests(fn: ExecRunner): void {
  _execRunner = fn;
}
export function _resetExecRunnerForTests(): void {
  _execRunner = defaultExecRunner;
}

// Pure builders — no spawning, easy to unit-test.
export function buildClaudeMcpAddArgs(opts: CliOptions): string[] {
  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(buildEnv(opts))) {
    envFlags.push("--env", `${k}=${v}`);
  }
  return [
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    "stdio",
    ...envFlags,
    SERVER_NAME,
    "--",
    opts.command,
    ...opts.args,
  ];
}

export function buildCodexMcpAddArgs(opts: CliOptions): string[] {
  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(buildEnv(opts))) {
    envFlags.push("--env", `${k}=${v}`);
  }
  return ["mcp", "add", ...envFlags, SERVER_NAME, "--", opts.command, ...opts.args];
}

// Custom --claude-config / --codex-config disables CLI shell-out: the CLIs
// don't accept arbitrary config locations, so an explicit path override
// implies the caller has opted into the file-write path.
export function shouldUseClaudeCli(opts: CliOptions): boolean {
  return opts.claudePath === DEFAULT_CLAUDE_PATH;
}
export function shouldUseCodexCli(opts: CliOptions): boolean {
  return opts.codexPath === DEFAULT_CODEX_PATH;
}

async function detectCli(cli: string): Promise<boolean> {
  const result = await _execRunner(cli, ["--version"], CLI_EXEC_TIMEOUT_MS);
  return result.code === 0;
}

export interface ServerProbe {
  present: boolean;
  scopeMatches: boolean; // claude only — codex has no scopes (always true there)
  rawOutput: string;
}

async function probeServer(cli: string, serverName: string): Promise<ServerProbe> {
  const result = await _execRunner(cli, ["mcp", "get", serverName], CLI_EXEC_TIMEOUT_MS);
  if (result.code !== 0) {
    return { present: false, scopeMatches: false, rawOutput: result.stdout + result.stderr };
  }
  const raw = result.stdout;
  // claude mcp get prints "Scope: User config" (or "Project config" / "Local config").
  // codex mcp get has no concept of scope, so always true.
  const scopeMatches = cli === CLAUDE_CLI ? /Scope:\s*User config/i.test(raw) : true;
  return { present: true, scopeMatches, rawOutput: raw };
}

// Compares expected env vars against the raw text output of `mcp get`.
// Claude prints "    KEY=VALUE" lines; Codex prints "env: KEY=*****"
// (values masked). When values are masked, fall back to key-presence check —
// users can force a refresh via --refresh when they need exact-value sync.
function envInSync(expected: Record<string, string>, raw: string, cli: "claude" | "codex"): boolean {
  if (cli === "codex") {
    return Object.keys(expected).every((k) => raw.includes(k));
  }
  return Object.entries(expected).every(([k, v]) => raw.includes(`${k}=${v}`));
}

export async function applyClaudeViaCli(opts: CliOptions): Promise<MergeOutcome | null> {
  if (!shouldUseClaudeCli(opts)) return null;
  if (!(await detectCli(CLAUDE_CLI))) return null;

  const probe = await probeServer(CLAUDE_CLI, SERVER_NAME);
  const expectedEnv = buildEnv(opts);
  let mustRefresh = false;
  let driftReason = "";

  if (probe.present) {
    if (!probe.scopeMatches) {
      driftReason = "scope mismatch (entry exists in non-user scope)";
      mustRefresh = true;
    } else if (!envInSync(expectedEnv, probe.rawOutput, "claude")) {
      driftReason = "env drift detected";
      mustRefresh = true;
    }
  }

  const willChange = !probe.present || opts.refresh || mustRefresh;
  const addArgs = buildClaudeMcpAddArgs(opts);

  if (opts.dryRun) {
    if (!willChange) {
      return {
        changed: false,
        reason: "already registered via claude mcp (user scope, env in sync)",
        output: "",
      };
    }
    const reason = !probe.present
      ? `would run: ${CLAUDE_CLI} ${addArgs.join(" ")}`
      : `would refresh via claude mcp (${driftReason || "explicit --refresh"})`;
    return { changed: true, reason, output: "" };
  }

  if (probe.present && !willChange) {
    return {
      changed: false,
      reason: "already registered via claude mcp (user scope, env in sync)",
      output: "",
    };
  }

  if (probe.present && willChange) {
    const removeRes = await _execRunner(
      CLAUDE_CLI,
      ["mcp", "remove", "--scope", "user", SERVER_NAME],
      CLI_EXEC_TIMEOUT_MS,
    );
    if (removeRes.codeName === "ENOENT") return null;
    if (removeRes.code !== 0 && !/not found/i.test(removeRes.stderr + removeRes.stdout)) {
      throw new Error(
        `claude mcp remove failed: ${removeRes.stderr.trim() || removeRes.stdout.trim()}`,
      );
    }
  }

  const addRes = await _execRunner(CLAUDE_CLI, addArgs, CLI_EXEC_TIMEOUT_MS);
  if (addRes.codeName === "ENOENT") return null;
  if (addRes.code !== 0) {
    throw new Error(`claude mcp add failed: ${addRes.stderr.trim() || addRes.stdout.trim()}`);
  }

  // Post-add verification — catches "exits 0 but didn't write" failures
  // (wrong scope, permissions, races).
  const verify = await probeServer(CLAUDE_CLI, SERVER_NAME);
  if (!verify.present || !verify.scopeMatches) {
    throw new Error(
      `claude mcp add reported success but \`claude mcp get ${SERVER_NAME}\` ${
        !verify.present ? "still doesn't see the entry" : "shows it in the wrong scope"
      }; refusing to claim install succeeded.`,
    );
  }

  return {
    changed: true,
    reason: probe.present
      ? `refreshed via claude mcp (${driftReason || "explicit --refresh"})`
      : "registered via claude mcp add",
    output: "",
  };
}

export async function applyCodexViaCli(opts: CliOptions): Promise<MergeOutcome | null> {
  if (!shouldUseCodexCli(opts)) return null;
  if (!(await detectCli(CODEX_CLI))) return null;

  const probe = await probeServer(CODEX_CLI, SERVER_NAME);
  const expectedEnv = buildEnv(opts);
  let mustRefresh = false;
  let driftReason = "";

  if (probe.present && !envInSync(expectedEnv, probe.rawOutput, "codex")) {
    driftReason = "env keys missing — possible drift";
    mustRefresh = true;
  }

  const willChange = !probe.present || opts.refresh || mustRefresh;
  const addArgs = buildCodexMcpAddArgs(opts);

  if (opts.dryRun) {
    if (!willChange) {
      return { changed: false, reason: "already registered via codex mcp", output: "" };
    }
    const reason = !probe.present
      ? `would run: ${CODEX_CLI} ${addArgs.join(" ")}`
      : `would refresh via codex mcp (${driftReason || "explicit --refresh"})`;
    return { changed: true, reason, output: "" };
  }

  if (probe.present && !willChange) {
    return { changed: false, reason: "already registered via codex mcp", output: "" };
  }

  if (probe.present && willChange) {
    const removeRes = await _execRunner(
      CODEX_CLI,
      ["mcp", "remove", SERVER_NAME],
      CLI_EXEC_TIMEOUT_MS,
    );
    if (removeRes.codeName === "ENOENT") return null;
    if (removeRes.code !== 0 && !/not found/i.test(removeRes.stderr + removeRes.stdout)) {
      throw new Error(
        `codex mcp remove failed: ${removeRes.stderr.trim() || removeRes.stdout.trim()}`,
      );
    }
  }

  const addRes = await _execRunner(CODEX_CLI, addArgs, CLI_EXEC_TIMEOUT_MS);
  if (addRes.codeName === "ENOENT") return null;
  if (addRes.code !== 0) {
    throw new Error(`codex mcp add failed: ${addRes.stderr.trim() || addRes.stdout.trim()}`);
  }

  const verify = await probeServer(CODEX_CLI, SERVER_NAME);
  if (!verify.present) {
    throw new Error(
      `codex mcp add reported success but \`codex mcp get ${SERVER_NAME}\` still doesn't see the entry; refusing to claim install succeeded.`,
    );
  }

  return {
    changed: true,
    reason: probe.present
      ? `refreshed via codex mcp (${driftReason || "explicit --refresh"})`
      : "registered via codex mcp add",
    output: "",
  };
}

export async function applyClaudeUninstallViaCli(opts: CliOptions): Promise<MergeOutcome | null> {
  if (!shouldUseClaudeCli(opts)) return null;
  if (!(await detectCli(CLAUDE_CLI))) return null;

  const probe = await probeServer(CLAUDE_CLI, SERVER_NAME);
  if (!probe.present) {
    return { changed: false, reason: "absent (claude mcp)", output: "" };
  }

  if (opts.dryRun) {
    return {
      changed: true,
      reason: `would run: claude mcp remove --scope user ${SERVER_NAME}`,
      output: "",
    };
  }

  const removeRes = await _execRunner(
    CLAUDE_CLI,
    ["mcp", "remove", "--scope", "user", SERVER_NAME],
    CLI_EXEC_TIMEOUT_MS,
  );
  if (removeRes.codeName === "ENOENT") return null;
  if (removeRes.code !== 0 && !/not found/i.test(removeRes.stderr + removeRes.stdout)) {
    throw new Error(
      `claude mcp remove failed: ${removeRes.stderr.trim() || removeRes.stdout.trim()}`,
    );
  }

  const verify = await probeServer(CLAUDE_CLI, SERVER_NAME);
  if (verify.present && verify.scopeMatches) {
    throw new Error(
      `claude mcp remove reported success but the entry is still present in user scope.`,
    );
  }

  return { changed: true, reason: "removed via claude mcp", output: "" };
}

export async function applyCodexUninstallViaCli(opts: CliOptions): Promise<MergeOutcome | null> {
  if (!shouldUseCodexCli(opts)) return null;
  if (!(await detectCli(CODEX_CLI))) return null;

  const probe = await probeServer(CODEX_CLI, SERVER_NAME);
  if (!probe.present) {
    return { changed: false, reason: "absent (codex mcp)", output: "" };
  }

  if (opts.dryRun) {
    return { changed: true, reason: `would run: codex mcp remove ${SERVER_NAME}`, output: "" };
  }

  const removeRes = await _execRunner(
    CODEX_CLI,
    ["mcp", "remove", SERVER_NAME],
    CLI_EXEC_TIMEOUT_MS,
  );
  if (removeRes.codeName === "ENOENT") return null;
  if (removeRes.code !== 0 && !/not found/i.test(removeRes.stderr + removeRes.stdout)) {
    throw new Error(
      `codex mcp remove failed: ${removeRes.stderr.trim() || removeRes.stdout.trim()}`,
    );
  }

  const verify = await probeServer(CODEX_CLI, SERVER_NAME);
  if (verify.present) {
    throw new Error(`codex mcp remove reported success but the entry is still present.`);
  }

  return { changed: true, reason: "removed via codex mcp", output: "" };
}

// Best-effort cleanup of the legacy ~/.claude/settings.json entry that
// setup-mcp ≤0.4.1 wrote. Tolerant of malformed JSON / bad shape — never
// blocks the install path on legacy file corruption.
export async function migrateLegacyClaudeSettings(dryRun: boolean): Promise<MergeOutcome> {
  const target = LEGACY_CLAUDE_SETTINGS_PATH;
  if (!(await pathExists(target))) {
    return { changed: false, reason: "no legacy settings.json", output: "" };
  }
  const raw = await fs.readFile(target, "utf8");
  if (raw.trim().length === 0) {
    return { changed: false, reason: "legacy settings.json empty", output: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`[claude:migrate] skipped: invalid JSON (${(error as Error).message})\n`);
    return { changed: false, reason: "legacy settings.json malformed", output: "" };
  }
  let validated: ClaudeSettingsLike;
  try {
    validated = validateClaudeSettings(parsed, target);
  } catch (error) {
    process.stderr.write(`[claude:migrate] skipped: ${(error as Error).message}\n`);
    return { changed: false, reason: "legacy settings.json bad shape", output: "" };
  }
  const outcome = mergeClaudeUninstall(validated);
  if (!outcome.changed) return outcome;
  if (!dryRun) {
    const realTarget = await resolveTarget(target);
    await backup(realTarget);
    await atomicWrite(realTarget, outcome.output, 0o600);
  }
  return outcome;
}

// Detect a [mcp_servers.holographic-memory] table without our begin/end
// markers — the shape created by `codex mcp add` (or hand-edited configs).
// Used by the file-write fallback to refuse to overlay a second same-named
// table (TOML parse failure on the second [mcp_servers.X] declaration).
export function hasUnmarkedCodexEntry(existing: string): boolean {
  const tableHeaderRe = new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]\\s*$`, "m");
  if (!tableHeaderRe.test(existing)) return false;
  return !TOML_MARKER_BEGIN_RE.test(existing);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

// Shell-quote a single argument for copy-paste-into-terminal output.
function shellQuote(s: string): string {
  if (s.length === 0) return "''";
  if (/[\s"'$`\\!*?(){}[\]<>|;&#~]/.test(s)) {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }
  return s;
}

function printSnippets(opts: CliOptions): void {
  const claudeCmd = [CLAUDE_CLI, ...buildClaudeMcpAddArgs(opts)].map(shellQuote).join(" ");
  const codexCmd = [CODEX_CLI, ...buildCodexMcpAddArgs(opts)].map(shellQuote).join(" ");
  process.stdout.write(`# Claude Code (writes ~/.claude.json):\n${claudeCmd}\n\n`);
  process.stdout.write(`# Codex (writes ~/.codex/config.toml):\n${codexCmd}\n`);
}

function printUninstallSnippets(_opts: CliOptions): void {
  process.stdout.write(`# Claude Code:\nclaude mcp remove --scope user ${SERVER_NAME}\n\n`);
  process.stdout.write(`# Codex:\ncodex mcp remove ${SERVER_NAME}\n`);
}

type CliApply = () => Promise<MergeOutcome | null>;
type FileApply = () => Promise<MergeOutcome>;

async function run(opts: CliOptions): Promise<number> {
  if (opts.print) {
    if (opts.uninstall) {
      printUninstallSnippets(opts);
    } else {
      printSnippets(opts);
    }
    return 0;
  }

  interface Task {
    label: "claude" | "codex";
    target: string;
    cliApply: CliApply;
    fileApply: FileApply;
  }
  const tasks: Task[] = [];
  if (opts.scope === "claude" || opts.scope === "both") {
    tasks.push({
      label: "claude",
      target: opts.claudePath,
      cliApply: opts.uninstall
        ? () => applyClaudeUninstallViaCli(opts)
        : () => applyClaudeViaCli(opts),
      fileApply: opts.uninstall ? () => applyClaudeUninstall(opts) : () => applyClaude(opts),
    });
  }
  if (opts.scope === "codex" || opts.scope === "both") {
    tasks.push({
      label: "codex",
      target: opts.codexPath,
      cliApply: opts.uninstall
        ? () => applyCodexUninstallViaCli(opts)
        : () => applyCodexViaCli(opts),
      fileApply: opts.uninstall ? () => applyCodexUninstall(opts) : () => applyCodex(opts),
    });
  }

  let allClean = true;
  for (const { label, target, cliApply, fileApply } of tasks) {
    let outcome: MergeOutcome;
    let usedCli = false;
    try {
      const cliOutcome = await cliApply();
      if (cliOutcome === null) {
        outcome = await fileApply();
      } else {
        outcome = cliOutcome;
        usedCli = true;
      }
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
      // outcome.reason already names the action; "would" prefix only added
      // for file-write outcomes (CLI outcomes self-describe with "would run:").
      const prefix = usedCli ? "" : "would ";
      process.stdout.write(`[${label}] ${target}: ${prefix}${outcome.reason}\n`);
      if (!usedCli && outcome.output) {
        process.stdout.write(`---- ${target} (preview) ----\n${outcome.output}---- end preview ----\n`);
      }
      continue;
    }
    if (usedCli) {
      // CLI already wrote the file; nothing more to do.
      process.stdout.write(`[${label}] ${outcome.reason}\n`);
      continue;
    }
    // File-write fallback: resolve symlinks so we update the real file
    // (the dotfile-repo source for stow / chezmoi / nix-home-manager users)
    // instead of replacing the symlink with a regular file via fs.rename.
    // Backup also operates on the resolved path so the .bak sits next to
    // the real source.
    const realTarget = await resolveTarget(target);
    await backup(realTarget);
    await atomicWrite(realTarget, outcome.output, 0o600);
    const noteSuffix = realTarget !== target ? ` (resolved from ${target})` : "";
    process.stdout.write(
      `[${label}] ${realTarget}${noteSuffix}: ${outcome.reason}; backup at ${realTarget}.bak\n`,
    );
  }

  // Always run legacy migration on Claude scope, regardless of CLI vs file
  // path taken. Cheap (one stat + one parse on missing-or-tiny file) and
  // closes the issue-34 dangling-entry case for users upgrading from
  // setup-mcp ≤0.4.1.
  if (opts.scope === "claude" || opts.scope === "both") {
    try {
      const legacy = await migrateLegacyClaudeSettings(opts.dryRun);
      if (legacy.changed) {
        const prefix = opts.dryRun ? "would remove" : "removed";
        process.stdout.write(
          `[claude:migrate] ${prefix} stale entry from ${LEGACY_CLAUDE_SETTINGS_PATH}\n`,
        );
      }
    } catch (error) {
      // Migration is best-effort; never block the install path on it.
      process.stderr.write(`[claude:migrate] non-fatal: ${(error as Error).message}\n`);
    }
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

Registers (or removes) the holographic-memory MCP server via:
  claude mcp add --scope user   (writes ~/.claude.json)
  codex mcp add                 (writes ~/.codex/config.toml)
Falls back to direct file write when the CLI is unavailable.
On install/uninstall, also cleans up any stale entry in
~/.claude/settings.json left by setup-mcp ≤0.4.1.

Options:
  --print               Print the equivalent CLI commands to stdout, no writes
                        (with --uninstall: print "remove" command lines)
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
  --claude-config <p>   override ~/.claude.json path (also disables CLI shell-out)
  --codex-config <p>    override ~/.codex/config.toml path (also disables CLI shell-out)
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
