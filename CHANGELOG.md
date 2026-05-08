# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-08
### Added
- Initial public release on npm.
- Isolated Paperclip-scoped SQLite memory store at `~/.paperclip/instances/default/hermes-memory.db`.
- Hybrid recall blending FTS5, Jaccard, and HRR cosine, scaled by per-fact trust score.
- Hermes-style entity extraction and entity-linked recall (`probe`, `related`, `reason`).
- Automatic recall on `agent.run.started`, cached under `run`/`issue`/`agent` scope keys.
- Agent write loop (`add`, `update`, `remove`) gated by `retainEnabled` and wrapped in SQLite transactions.
- Repository-only tooling for populating the store: Postgres seed (`pnpm seed:paperclip`) and Claude-Code-driven curation import (`pnpm import:facts`); run from a git checkout, not from the published package.
