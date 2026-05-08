# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-09
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

## [0.1.0] - 2026-05-08
### Added
- Initial public release on npm.
- Isolated Paperclip-scoped SQLite memory store at `~/.paperclip/instances/default/hermes-memory.db`.
- Hybrid recall blending FTS5, Jaccard, and HRR cosine, scaled by per-fact trust score.
- Hermes-style entity extraction and entity-linked recall (`probe`, `related`, `reason`).
- Automatic recall on `agent.run.started`, cached under `run`/`issue`/`agent` scope keys.
- Agent write loop (`add`, `update`, `remove`) gated by `retainEnabled` and wrapped in SQLite transactions.
- Repository-only tooling for populating the store: Postgres seed (`pnpm seed:paperclip`) and Claude-Code-driven curation import (`pnpm import:facts`); run from a git checkout, not from the published package.
