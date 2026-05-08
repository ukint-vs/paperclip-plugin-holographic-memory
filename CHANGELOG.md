# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
