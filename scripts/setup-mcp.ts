#!/usr/bin/env tsx
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { atomicWrite } from "../src/atomic-write.js";

// Idempotent merger that registers the holographic-memory MCP server in the
// user's Claude Code (~/.claude/settings.json -> mcpServers) and Codex
// (~/.codex/config.toml -> [mcp_servers.holographic-memory]) configs.
//
// Behavior matrix (from /plan-eng-review B2):
//   missing file  -> create with mode 0600
//   valid file    -> backup .bak, atomic merge (tmp + rename)
//   malformed     -> abort exit 2 with a diagnostic, never touch the file
//   symlink       -> resolved write
//   --print       -> stdout only, no writes
//   --dry-run     -> diff-style preview, no writes
//   --refresh     -> rewrite the entry even if marker present (idempotent
//                    re-create after dbPath change)

const SERVER_NAME = "holographic-memory";
const TOML_MARKER_BEGIN = `# managed by paperclip-plugin-${SERVER_NAME}`;
const TOML_MARKER_END = `# end paperclip-plugin-${SERVER_NAME}`;
const DEFAULT_DB_PATH = "~/.paperclip/instances/default/hermes-memory.db";
const DEFAULT_COMMAND = "npx";
const DEFAULT_ARGS = ["paperclip-holographic-memory-mcp"];

export interface CliOptions {
  print: boolean;
  dryRun: boolean;
  refresh: boolean;
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

function parseFlag<T>(argv: string[], name: string, parse: (raw: string) => T): T | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return parse(value);
}

function parseArgs(argv: string[]): CliOptions {
  const has = (name: string) => argv.includes(`--${name}`);
  const scopeRaw = parseFlag(argv, "scope", (s) => s) ?? "both";
  if (!["claude", "codex", "both"].includes(scopeRaw)) {
    throw new Error(`--scope must be one of claude|codex|both, got "${scopeRaw}"`);
  }
  const dbPath =
    parseFlag(argv, "db-path", (s) => s) ?? process.env.PAPERCLIP_HOLO_MEMORY_DB ?? DEFAULT_DB_PATH;
  const command = parseFlag(argv, "command-path", (s) => s) ?? DEFAULT_COMMAND;
  const argsFlag = parseFlag(argv, "args", (s) => s.split(",").map((part) => part.trim()).filter(Boolean));
  return {
    print: has("print"),
    dryRun: has("dry-run"),
    refresh: has("refresh"),
    scope: scopeRaw as "claude" | "codex" | "both",
    dbPath,
    recallEnabled: parseFlag(argv, "recall", (s) => s === "true") ?? true,
    retainEnabled: parseFlag(argv, "retain", (s) => s === "true") ?? true,
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
  await fs.copyFile(target, `${target}.bak`);
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

async function applyClaude(opts: CliOptions): Promise<MergeOutcome> {
  const entry = buildClaudeEntry(opts);
  let existing: ClaudeSettingsLike | null = null;
  if (await pathExists(opts.claudePath)) {
    const raw = await fs.readFile(opts.claudePath, "utf8");
    if (raw.trim().length > 0) {
      try {
        existing = JSON.parse(raw) as ClaudeSettingsLike;
      } catch (error) {
        const message = (error as Error).message;
        throw new Error(`Refusing to overwrite ${opts.claudePath}: invalid JSON (${message}). Fix the file or pass --print and copy manually.`);
      }
    }
  }
  return mergeClaudeSettings(existing, entry, opts.refresh);
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

export function mergeCodexConfig(existing: string, block: string, refresh: boolean): MergeOutcome {
  const startIdx = existing.indexOf(TOML_MARKER_BEGIN);
  const endIdx = existing.indexOf(TOML_MARKER_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const beforeBlock = existing.slice(0, startIdx);
    const afterBlock = existing.slice(endIdx + TOML_MARKER_END.length);
    const currentBlock = existing.slice(startIdx, endIdx + TOML_MARKER_END.length);
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

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printSnippets(opts: CliOptions): void {
  const claudeEntry = buildClaudeEntry(opts);
  const claudeSnippet = JSON.stringify({ mcpServers: { [SERVER_NAME]: claudeEntry } }, null, 2);
  process.stdout.write(`# Add to ${opts.claudePath} (merge into mcpServers):\n${claudeSnippet}\n\n`);
  process.stdout.write(`# Add to ${opts.codexPath} (append):\n${buildCodexBlock(opts)}\n`);
}

async function run(opts: CliOptions): Promise<number> {
  if (opts.print) {
    printSnippets(opts);
    return 0;
  }

  const tasks: Array<["claude" | "codex", string, () => Promise<MergeOutcome>]> = [];
  if (opts.scope === "claude" || opts.scope === "both") {
    tasks.push(["claude", opts.claudePath, () => applyClaude(opts)]);
  }
  if (opts.scope === "codex" || opts.scope === "both") {
    tasks.push(["codex", opts.codexPath, () => applyCodex(opts)]);
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
      process.stdout.write(`[${label}] ${target}: would ${outcome.reason}\n`);
      process.stdout.write(`---- ${target} (preview) ----\n${outcome.output}---- end preview ----\n`);
      continue;
    }
    await backup(target);
    await atomicWrite(target, outcome.output, 0o600);
    process.stdout.write(`[${label}] ${target}: ${outcome.reason}; backup at ${target}.bak\n`);
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

Registers the holographic-memory MCP server in:
  ~/.claude/settings.json   (Claude Code mcpServers)
  ~/.codex/config.toml      ([mcp_servers.holographic-memory])

Options:
  --print               Print snippets to stdout, no writes
  --dry-run             Show what would change, no writes
  --refresh             Rewrite entries even if already present
  --scope <s>           claude | codex | both (default: both)
  --db-path <path>      DB path (default: ${DEFAULT_DB_PATH})
  --command-path <bin>  MCP command (default: ${DEFAULT_COMMAND})
  --args a,b,c          Comma-separated args (default: ${DEFAULT_ARGS.join(",")})
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

const invokedAsScript = (() => {
  try {
    const url = new URL(import.meta.url);
    return process.argv[1] === url.pathname || /setup-mcp\.(ts|js)$/.test(process.argv[1] ?? "");
  } catch {
    return /setup-mcp\.(ts|js)$/.test(process.argv[1] ?? "");
  }
})();

if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`setup-mcp failed: ${(error as Error).message}\n`);
    process.exit(2);
  });
}
