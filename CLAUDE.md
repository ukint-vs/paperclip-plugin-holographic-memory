# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
pnpm typecheck                                  # tsc --noEmit
pnpm test                                       # vitest run (all .spec.ts)
pnpm test tests/worker.spec.ts                  # single file
pnpm vitest -t "registers tool"                 # single test by name
pnpm build                                      # tsup + shx chmod +x dist/*.js → dist/{manifest,worker,mcp-server,setup-mcp,ui/index}.js (ESM + .d.ts)
pnpm seed:paperclip [--dry-run] [--database-url ...] [--db-path ...]
pnpm import:facts <facts.json> [--dry-run] [--db-path ...]

# MCP setup (repo dev, runs scripts/setup-mcp.ts via tsx):
pnpm setup:mcp [--print] [--dry-run] [--refresh] [--uninstall] [--scope claude|codex|both]

# MCP setup (post-npm-install, runs the published bin):
npx -y --package paperclip-plugin-holographic-memory paperclip-holographic-memory-setup [...same flags...]
```

`prepublishOnly` runs `typecheck && test && build`. Build externalizes `@paperclipai/plugin-sdk`, `better-sqlite3`, and `react` / `react/jsx-runtime` (see `tsup.config.ts`). The `shx chmod +x dist/*.js` postfix in `build` keeps both bins (`mcp-server`, `setup-mcp`) executable in the published tarball — `dist/*.js` is non-recursive so the UI bundle in `dist/ui/` keeps its default mode.

## Architecture

This is a Paperclip plugin (npm: `paperclip-plugin-holographic-memory`) that provides an isolated SQLite-backed memory store and recall-before-run flow for Paperclip agents. It owns its own DB at `~/.paperclip/instances/default/hermes-memory.db` — it does **not** read or write `~/.hermes/memory_store.db` unless explicitly configured.

### Plugin contract (load-bearing — read before editing)

Paperclip's plugin loader reads two pointers from `package.json`:

```json
"paperclipPlugin": { "manifest": "./dist/manifest.js", "worker": "./dist/worker.js" }
```

Both are produced by `pnpm build` from `src/manifest.ts` and `src/worker.ts`. The published `files` array is intentionally narrow (`["dist", "LICENSE", "README.md", "CHANGELOG.md"]`).

**Single source of truth for the manifest is `src/manifest.ts`.** Do not introduce a hand-maintained `manifest.cjs`, `manifest.json`, or sibling manifest file at the repo root — Paperclip loads `dist/manifest.js` cleanly. PR #19 attempted this; closed as superseded (see issue #3 close note). If a CommonJS variant ever becomes genuinely required, generate it from `dist/manifest.js` in the build script — never hand-maintain.

**Worker bootstrap is `runWorker(plugin, import.meta.url)` at the bottom of `src/worker.ts`.** The SDK guards on `path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])` — Paperclip's spawn satisfies this, tests importing the module do not. Do not replace with `startWorkerRpcHost({ plugin })`; that runs unconditionally on import and breaks `tests/worker.spec.ts`.

**`tools[].parametersSchema` in `src/manifest.ts` must stay aligned with the handler's expected `ToolParams` shape in `src/worker.ts`.** The two have drifted before (commit `ef26e47`). When adding/changing a tool param, update both — particularly `tags` (which accepts `string | string[]` via `oneOf`) and any param with default values like `min_trust`.

### Runtime flow

1. **Install** — `POST /api/plugins/install` triggers `definePlugin({ setup, onShutdown })` in `src/worker.ts`. `setup` reads instance config (`resolvePluginConfig` in `src/config.ts`), registers the agent tool, and subscribes to `agent.run.started`.
2. **Recall on run start** — `agent.run.started` event handler runs hybrid search (FTS5 + Jaccard + HRR cosine, weighted 0.4/0.3/0.3, scaled by trust score), formats facts via `src/context-injector.ts`, and writes the formatted MEMORY CONTEXT to plugin state under three scope keys (run / issue / agent) so any later tool call inherits it.
3. **Tool dispatch** — `holographic_memory_search` action dispatch is in `dispatchAction` (worker.ts). Read actions (search/probe/related/reason/list/feedback/recall_context) gated by `recallEnabled`; write actions (add/update/remove) gated by `retainEnabled` (default `false`).
4. **Storage** — `MemoryStore` in `src/memory-store.ts` wraps `better-sqlite3` and owns the schema (facts, entities, FTS5 index, HRR vectors, memory banks `cat:<category>`). Connection lifecycle is keyed by `dbPath` in a registry so `onConfigChanged` can swap paths without leaks. HRR vectors generated deterministically on insert (`src/hrr.ts`).
5. **Population** — Two ingest paths, both idempotent by content:
   - `pnpm seed:paperclip` reads from a Paperclip Postgres DB (`issues`, `runs`, `agents`, `comments`).
   - `pnpm import:facts` reads a curated JSON array (`{ content, category, tags?, trustScore? }`). See `scripts/CURATION.md` for taxonomy and trust-score guidance.

### Test posture

`tests/worker.spec.ts` imports `../src/worker.js` directly and exercises `dispatchAction` with a duck-typed `ctx` — no real Paperclip host needed. The `runWorker` main-module guard (above) is what makes this safe. `tests/memory-store.spec.ts` runs against an in-memory SQLite. Don't add module-top-level side effects to `src/worker.ts` that the import-in-tests path can't tolerate.

### Verifying against a real Paperclip host

Server logs are the load-bearing signal — `worker process started and initialized` + `registered N tool(s)` + `eventSubscriptions: N` confirm the plugin actually wired up. `status: "ready"` alone is **not** sufficient (this was PR #19's mistake). Tool round-trip via `POST /api/plugins/tools/execute` requires a seeded company+agent in the DB; see issue #22 for the smoke-script we need.

### setup-mcp wiring (load-bearing)

`scripts/setup-mcp.ts` registers the MCP server in two places. **Issue #34 background** (fixed in 0.5.0): older versions wrote to `~/.claude/settings.json` (Claude Code 1.x). Claude Code 2.x reads `~/.claude.json` (managed by `claude mcp add`); writes to `settings.json` are silently ignored. The script now:

1. **CLI shell-out first**: prefers `claude mcp add --scope user` and `codex mcp add` — the canonical entry points that own the on-disk format. Verifies the entry actually persisted via a follow-up `mcp get` (catches "exit 0 but didn't write" failure modes documented in #34).
2. **File-write fallback**: when the CLI is missing (ENOENT), falls back to the original direct-write path against `~/.claude.json` and `~/.codex/config.toml`. CLI-found-but-errored is a hard fail (don't fall back; that creates config drift between two locations).
3. **Legacy migration**: every install/uninstall on the Claude scope cleans `mcpServers.holographic-memory` from `~/.claude/settings.json` if present. Tolerant of malformed JSON / bad shape — never blocks the install path on legacy file corruption.

Tests inject a mock `ExecRunner` via `_setExecRunnerForTests` to cover the 11 CLI shell-out cases without spawning real `claude` / `codex` binaries. `--claude-config <path>` / `--codex-config <path>` overrides force the file-write path (the CLIs don't accept arbitrary config locations).

## Conventions

- ESM only (`"type": "module"`); intra-package imports use `.js` extensions even though sources are `.ts` (e.g. `import { ... } from "./config.js"`).
- `@paperclipai/plugin-sdk` ships as date-versioned releases. `package.json` pins it exact (`2026.428.0` as of 0.4.0). Date-versioned packages don't honor semver-caret ranges meaningfully, so caret pinning would let many release trains slip in. Bump deliberately when changing the SDK contract; see issue #21. Hindsight (`@vectorize-io/hindsight-paperclip`) is the canonical third-party reference plugin and uses `^2026.403.0`.
- The MCP server reports its version from `package.json` at runtime (`PACKAGE_VERSION` in `src/mcp-server.ts`) so `name + version` advertised on every initialize handshake stays in sync with the published artifact. `tests/mcp-server.spec.ts` has a regression test asserting the dynamic read still works.
- Public email for code/manifests: `ukint-vs@proton.me`. Don't put `smirnovvad7@gmail.com` in `package.json author`, manifest `author`, commits, or any shipped artifact.
- `TODO.md` is the live work-tracker; tier-1 issues block the "production-stable" claim. Update it when closing tier-1 work.
