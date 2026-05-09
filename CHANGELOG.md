# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-05-09
First release published to npm. Versions 0.1 – 0.3 below were internal pre-release milestones, never published.

### Added
- `paperclip-holographic-memory-setup` bin — end-user MCP wire-up via `npx -y --package paperclip-plugin-holographic-memory paperclip-holographic-memory-setup` after `npm install`. Default MCP-config command writes `npx -y --package paperclip-plugin-holographic-memory paperclip-holographic-memory-mcp` so users don't need a global install. Repo dev workflow `pnpm setup:mcp` unchanged.
- `--uninstall` flag on the setup bin: strips Claude/Codex entries symmetrically before `npm uninstall`. Idempotent (safe to rerun on already-clean configs); refuses to touch corrupt-marker codex configs with a clear diagnostic. New `mergeClaudeUninstall` and `mergeCodexUninstall` helpers exported alongside the install-side helpers.
- `--command` flag accepted as alias for `--command-path`; `--args=VALUE` (equals form) accepted alongside `--args VALUE` (space form). Prevents silent misconfig for users following older docs.
- Shape validation for `~/.claude/settings.json`: top-level must be an object; `mcpServers`, if present, must be a record. Refuses to write on semantic malformation (exit 2) instead of silently corrupting valid-but-wrong JSON shapes.
- Trust decay over time (#8). New `trustHalfLifeDays` config knob, default `0` (decay disabled, prior ranking preserved on upgrade). When > 0, the scored read paths (`search`, `related`) apply `effectiveTrust = trustScore * 0.5^(ageDays / halfLife)` to each candidate, where `ageDays` comes from a SQL-projected `unixepoch(COALESCE(last_accessed_at, created_at))` (sidesteps the `Date.parse` local-timezone trap that silently shifts ages outside UTC). New `last_accessed_at TIMESTAMP` column on `facts`, added via the same idempotent `ALTER TABLE` shim; bumped on every recall via the existing `incrementRetrievalCounts` chokepoint and on positive feedback (negative feedback leaves the clock alone so penalties don't dilute). `minTrust` is re-applied post-decay so the cutoff means "effective trust" instead of "baseline raw trust." `list` / `probe` / `reason` keep raw `trust_score` ordering by design.
- Cross-tenant scoping (#3). New `company_id TEXT` column on `facts` via the same idempotent `ALTER TABLE` shim used for provenance in 0.2.0. Every read SELECT in the store filters by `(company_id = ? OR company_id IS NULL)` when a `companyId` is supplied; NULL = global so existing curated/seed rows keep working without a backfill. `addFact` writes `company_id`, scopes dedup per-company. Worker pass-through wired end-to-end: `event.companyId` reaches recall + auto-extract; `runCtx.companyId` reaches every dispatch handler (search/probe/related/reason/list/recall_context/add) via the `CoreActionHandler` signature.
- Recall observability (#7). `handleRunStarted` now emits structured logs on every exit path: `recall: fired` (with `facts`, `avgScore`, `maxScore`, `avgTrust`, `scopesWritten`, `scopesFailed`, `elapsedMs`, plus run/issue/agent/company IDs), `recall: skipped` with a `reason` enum (`disabled` / `missing_issue_id` / `empty_issue` / `no_facts`), plus error/warn lines for issue-fetch / search / partial-and-all scope-write failures. From server logs alone you can now answer "did recall contribute, and if not, why" without inspecting plugin state.
- Per-recall aggregates (`avgScore`, `maxScore`, `avgTrust`) computed in a single pass over the returned facts.
- `mcpName: "io.github.ukint-vs/paperclip-plugin-holographic-memory"` in `package.json` for the upcoming MCP registry.
- `CHANGELOG.md` now ships in the npm tarball (was previously dist-only).

### Changed
- `@paperclipai/plugin-sdk` pinned to exact `2026.428.0` (was floating `latest`). Future SDK bumps require a deliberate version change to this package.
- `react` moved from runtime `dependencies` to optional `peerDependencies` (`>=18 <20`). The Settings UI is host-rendered; bare worker installs no longer drag in React. Externalized in `tsup.config.ts` so the optional-peer claim holds at consume time.
- Build script now runs `tsup && shx chmod +x dist/*.js` so published bins are executable on Linux/macOS at install time. Cross-platform via `shx` (matches the `@modelcontextprotocol/server-memory` reference pattern).
- `tsup.config.ts` switched to object-form `entry` to keep `dist/` flat across mixed `src/` and `scripts/` entry points.
- Sourcemaps no longer ship in the npm tarball. Local debugging? Re-enable `sourcemap: true` in `tsup.config.ts` for a one-off build — they're disabled at the config level, not the tarball level.
- `HolographicMemoryConfig` gains a required `trustHalfLifeDays: number` field. Plugin authors constructing the config literal externally must set it (default 0). Resolved configs from `resolvePluginConfig` and the manifest schema (default `0`) are unaffected; runtime callers see no break.
- `MemorySearchOptions` gains an optional `halfLifeDays?: number` so per-call decay overrides match the existing per-call pattern for `minTrust`, `limit`, `companyId`.
- `MemoryFact` gains a required `companyId: string | null` field. Internal change for plugin authors who construct fact literals; the plugin itself ships only the runtime, so no npm-consumer breakage.
- `MemorySearchOptions` gains an optional `companyId?: string`; omit for trusted server-side audits, supply otherwise.
- `NewMemoryFact` gains an optional `companyId?: string`.
- `CoreActionHandler` (in `dispatch.ts`) gains an optional `runCtx?: ToolRunContext` parameter; the standalone MCP server still calls it with no `runCtx` (no `companyId` in MCP world today).
- Per-scope writes use `Promise.allSettled` instead of `Promise.all`. A single rejected scope no longer kills the whole handler; partial success still returns recall state and emits a `warn`.
- `feedback` action is now correctly classified as a write and gated by `retainEnabled` (it mutates `trust_score`, `helpful_count`, `updated_at`).
- `MemoryStore` sets `busy_timeout = 5000` so concurrent worker + MCP-server writers wait for the WAL lock instead of throwing `SQLITE_BUSY`.

### Fixed
- MCP server now reports the correct package version to connected clients. Previously hardcoded to `0.1.0` across all releases (caught by Codex outside-voice review).
- `Promise.all` over the per-scope writes in `handleRunStarted` previously rejected the whole handler if any one scope rejected. Now logged as either `partial scope write failure` (warn, state still returned) or `all scope writes failed` (error, undefined returned).
- Default MCP command args fixed to use `npx -y --package <pkg> <bin>` form. Without `--package`, npx searches npm for a package matching the bin name (which doesn't exist) and either fails or installs a squatter.

### Removed
- `AddFactResult.reason` and the `content_collision` catch branch in `addFact`. These were a safety valve for cross-tenant content collisions that can only fire under multi-tenant misuse on a shared `dbPath`. Single-tenant runs are guaranteed-safe by the dedup SELECT before INSERT. Closed issues #9 (schema migration framework) and #28 (MCP cross-tenant scoping) as deferred-pending-multi-tenant; reopen alongside the second company onboarding.

## [0.3.0] - 2026-05-09
### Added
- Stdio MCP server (`paperclip-holographic-memory-mcp` bin) bridging the memory tool to `claude_local` and `codex_local` agents (issue #20). Surfaces `holographic_memory_search` over MCP for any client that speaks the protocol.
- `pnpm setup:mcp` script for idempotent registration in `~/.claude/settings.json` and `~/.codex/config.toml` with `--print`, `--dry-run`, `--refresh`, `--scope`, `--db-path` flags. JSON merge preserves siblings; TOML uses a marker-block append so user comments survive.
- Cross-process recall cache: worker writes scoped JSON files (`recall-cache/<scope>/<id>.json`) on `agent.run.started` so the MCP `recall_context` action can deliver the same MEMORY CONTEXT to subprocess-spawned agents that bypass the in-process `ctx.state` channel.
- Single-source-of-truth zod schema for the search tool (`src/tool-schema.ts`); manifest, worker, and MCP server all derive from it.
- `./mcp-server` package export for programmatic embedding.

### Changed
- `feedback` action is now correctly classified as a write and gated by `retainEnabled` (it mutates `trust_score`, `helpful_count`, `updated_at`).
- `MemoryStore` sets `busy_timeout = 5000` so concurrent worker + MCP-server writers wait for the WAL lock instead of throwing `SQLITE_BUSY`.
- `manifest.parametersSchema` is derived from the zod schema instead of hand-authored, eliminating drift between manifest and runtime registration.

### Fixed
- `atomicWrite` now uses `pid + random hex` tmp suffixes so concurrent writes to the same target can't collide (previously `${target}.tmp.${pid}` could tear under back-to-back recall-cache writes).

## [0.2.0] - 2026-05-09
### Added
- Auto-extract facts on `agent.run.finished` (#11). Hermes-parity regex pass over the issue body and human-authored comments inside the run window; produces at most one `user_pref` and one `project` fact per text. Stored content is the regex capture group (truncated to 400 chars), not the source-text prefix.
- Per-fact provenance columns on `facts`: `source`, `agent_id`, `run_id`. Auto-extracted facts pass `source: "auto"` plus the run's `agentId`/`runId`; curated/imported facts leave the columns NULL. Added via an idempotent `ALTER TABLE` shim — replaces with the real migration framework when #9 lands.
- Manifest capability `issue.comments.read` (required by `ctx.issues.listComments`).

### Changed
- `MemoryFact` exposes `source`/`agentId`/`runId` as `string | null` (matches SQLite NULL semantics).
- All fact-search SELECT shapes widened to return provenance columns, including the entity-LIKE recall path.

## [0.1.0] - 2026-05-08
### Added
- Initial *internal* release; tagged but not published to npm — see 0.4.0 for the actual first npm publish.
- Isolated Paperclip-scoped SQLite memory store at `~/.paperclip/instances/default/hermes-memory.db`.
- Hybrid recall blending FTS5, Jaccard, and HRR cosine, scaled by per-fact trust score.
- Hermes-style entity extraction and entity-linked recall (`probe`, `related`, `reason`).
- Automatic recall on `agent.run.started`, cached under `run`/`issue`/`agent` scope keys.
- Agent write loop (`add`, `update`, `remove`) gated by `retainEnabled` and wrapped in SQLite transactions.
- Repository-only tooling for populating the store: Postgres seed (`pnpm seed:paperclip`) and Claude-Code-driven curation import (`pnpm import:facts`); run from a git checkout, not from the published package.
