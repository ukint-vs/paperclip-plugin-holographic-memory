# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Cross-tenant scoping (#3). New `company_id TEXT` column on `facts` via the same idempotent `ALTER TABLE` shim used for provenance in 0.2.0. Every read SELECT in the store filters by `(company_id = ? OR company_id IS NULL)` when a `companyId` is supplied; NULL = global so existing curated/seed rows keep working without a backfill. `addFact` writes `company_id`, scopes dedup per-company, and catches the residual `UNIQUE`-on-content collision (returning `inserted: false, reason: "content_collision"`) instead of leaking another company's `fact_id`. Worker pass-through wired end-to-end: `event.companyId` reaches recall + auto-extract; `runCtx.companyId` reaches every dispatch handler (search/probe/related/reason/list/recall_context/add) via the `CoreActionHandler` signature.
- Recall observability (#7). `handleRunStarted` now emits structured logs on every exit path: `recall: fired` (with `facts`, `avgScore`, `maxScore`, `avgTrust`, `scopesWritten`, `scopesFailed`, `elapsedMs`, plus run/issue/agent/company IDs), `recall: skipped` with a `reason` enum (`disabled` / `missing_issue_id` / `empty_issue` / `no_facts`), plus error/warn lines for issue-fetch / search / partial-and-all scope-write failures. From server logs alone you can now answer "did recall contribute, and if not, why" without inspecting plugin state.
- Per-recall aggregates (`avgScore`, `maxScore`, `avgTrust`) computed in a single pass over the returned facts.

### Changed
- `MemoryFact` gains a required `companyId: string | null` field. Internal change for plugin authors who construct fact literals; the plugin itself ships only the runtime, so no npm-consumer breakage.
- `MemorySearchOptions` gains an optional `companyId?: string`; omit for trusted server-side audits, supply otherwise.
- `NewMemoryFact` gains an optional `companyId?: string`.
- `AddFactResult` gains an optional `reason?: "content_collision"` for the cross-tenant write edge case.
- `CoreActionHandler` (in `dispatch.ts`) gains an optional `runCtx?: ToolRunContext` parameter; the standalone MCP server still calls it with no `runCtx` (no `companyId` in MCP world today).
- Per-scope writes use `Promise.allSettled` instead of `Promise.all`. A single rejected scope no longer kills the whole handler; partial success still returns recall state and emits a `warn`.

### Fixed
- `Promise.all` over the per-scope writes in `handleRunStarted` previously rejected the whole handler if any one scope rejected. Now logged as either `partial scope write failure` (warn, state still returned) or `all scope writes failed` (error, undefined returned).

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
- Initial public release on npm.
- Isolated Paperclip-scoped SQLite memory store at `~/.paperclip/instances/default/hermes-memory.db`.
- Hybrid recall blending FTS5, Jaccard, and HRR cosine, scaled by per-fact trust score.
- Hermes-style entity extraction and entity-linked recall (`probe`, `related`, `reason`).
- Automatic recall on `agent.run.started`, cached under `run`/`issue`/`agent` scope keys.
- Agent write loop (`add`, `update`, `remove`) gated by `retainEnabled` and wrapped in SQLite transactions.
- Repository-only tooling for populating the store: Postgres seed (`pnpm seed:paperclip`) and Claude-Code-driven curation import (`pnpm import:facts`); run from a git checkout, not from the published package.
