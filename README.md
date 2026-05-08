# paperclip-plugin-holographic-memory

Paperclip recall plugin backed by an isolated holographic SQLite memory store.

The plugin owns a Paperclip-specific SQLite database at
`~/.paperclip/instances/default/hermes-memory.db`. It uses the same facts,
entities, FTS5, and memory bank schema as Hermes holographic memory, but it does
not read or write your personal `~/.hermes/memory_store.db` unless you explicitly
configure that path.

The runtime pattern follows the Paperclip memory integration shape used by
Hindsight: recall on `agent.run.started`, cache formatted context in plugin
state for the run, and expose an agent tool for targeted recall.

## What it does

- Isolated Paperclip memory DB, created on first use.
- Automatic recall on `agent.run.started`: searches the DB with the issue's
  title/description and caches the formatted MEMORY CONTEXT under three scope
  keys (run, issue, agent) so any later tool call can pick it up.
- Hybrid search blend: FTS5 + Jaccard + HRR cosine, weighted 0.4/0.3/0.3 and
  scaled by per-fact trust score.
- Hermes-style entity extraction and entity-linked recall.
- Deterministic HRR vectors on every insert; reads use them for real similarity,
  not a constant.
- Category memory banks stored as `cat:<category>`.
- Agent write loop: `add`, `update`, `remove` actions gated by `retainEnabled`,
  all wrapped in SQLite transactions.
- Fact feedback that adjusts trust scores.
- Two ways to populate the DB: one-time Postgres seed, or Claude-Code-driven
  curation via `pnpm import:facts`.
- No event-driven auto-extraction; facts only enter the store via seed, import,
  or the agent calling `add`.

## Installation

This is an independent plugin published on npm as
[`paperclip-plugin-holographic-memory`](https://www.npmjs.com/package/paperclip-plugin-holographic-memory).
Install it through your running Paperclip instance:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-holographic-memory"}'
```

Then configure it in Paperclip Settings -> Plugins -> Holographic Memory.

### Local development install

To install from a checkout (e.g. while iterating on the plugin):

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip-plugin-holographic-memory","isLocalPath":true}'
```

## Configuration

```json
{
  "dbPath": "~/.paperclip/instances/default/hermes-memory.db",
  "recallEnabled": true,
  "retainEnabled": false,
  "minTrustScore": 0.3,
  "maxFactsPerRecall": 10
}
```

`retainEnabled` defaults to `false`. While off, `add`, `update`, and `remove`
return `Memory retain is disabled. Set retainEnabled=true in plugin config.`
Read actions are gated by `recallEnabled`.

## Populating the DB

Two paths, used together or separately.

### 1. Claude-Code-driven curation (recommended for rich facts)

Drive Claude Code through your Paperclip data (issues, comments, agent maps,
methodology docs), produce a JSON array of facts, then import:

```bash
pnpm import:facts /path/to/curated-facts.json
pnpm import:facts /path/to/curated-facts.json --dry-run
pnpm import:facts /path/to/curated-facts.json --db-path ~/.paperclip/instances/default/hermes-memory.db
```

`scripts/CURATION.md` documents the durable-fact rules, taxonomy, trust score
guide, and the JSON schema (`{ content, category, tags?, trustScore? }`). Import
is idempotent — re-running with the same content returns the existing factId.

### 2. One-shot Postgres seed (fast bulk import)

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm seed:paperclip
pnpm seed:paperclip --dry-run
pnpm seed:paperclip --database-url postgres://user:pass@localhost:54329/paperclip
pnpm seed:paperclip --db-path ~/.paperclip/instances/default/hermes-memory.db
```

The seeder reads `issues`, `runs`, `agents`, and `comments` when present. It
extracts completed issue resolutions, recurring run errors, agent capability
notes, and workflow decisions. It writes facts with `paperclip:*` categories and
deduplicates by content.

## Using with `claude_local` and `codex_local` agents

In-process Paperclip agents see the tool through `ctx.tools.register()`.
Subprocess-based adapters (`claude_local` spawning `claude --print`,
`codex_local` spawning `codex`) do not — the SDK's tool RPC is invisible to
those external CLIs. To bridge them, this package ships a standalone MCP
stdio server (`paperclip-holographic-memory-mcp`) that wraps the same SQLite
store, plus a setup script that registers it in your Claude Code and Codex
MCP configs. See `issue #20` for the architectural rationale.

```text
                         READ + RECALL_CONTEXT (cached)
+-----------------+      +-----------------+      +---------------+
| Paperclip       | ---> | worker.ts       | ---> | MemoryStore   |
| agent.run       |      | (in-process)    |      | WAL+busy_to   |
| started         |      | ctx.state.set() |      | hermes-memory |
+-----------------+      |   + cache file  |      |     .db       |
         |               +-----------------+      +---------------+
         v                       |                        ^ ^
+-----------------+      +---------------------+          | |
| claude_local    |      | recall-cache/       |          | |
| spawns claude   |      |   run/<runId>.json  |          | |
| --print         |      |   issue/<id>.json   |          | |
+-----------------+      |   agent/<id>.json   |          | |
         |               +---------------------+          | |
         v                       ^                        | |
+-----------------+               |                       | |
| mcp-server.js   | ---reads cache+--                     | |
| stdio transport | ----------------- WRITER + READER ----+ |
| (per-spawn)     |                                         |
+-----------------+                                         |
         ^                                                  |
+-----------------+                                         |
| codex_local     | -----------------------------------------+
+-----------------+
```

### One-time setup

```bash
pnpm setup:mcp                  # merges entries into ~/.claude + ~/.codex
pnpm setup:mcp --dry-run        # preview without writing
pnpm setup:mcp --print          # emit snippets to stdout for manual paste
pnpm setup:mcp --refresh        # rewrite entries (e.g. after dbPath change)
pnpm setup:mcp --scope claude   # claude only; also: --scope codex
```

The script:

- Creates `~/.claude/settings.json` or `~/.codex/config.toml` if missing (mode `0600`).
- Backs up to `.bak` before any write.
- Aborts with exit code 2 if either file is malformed (never overwrites broken state).
- Is idempotent: re-running with the same flags is a no-op.
- Preserves comments in `~/.codex/config.toml` by appending a marker block,
  not by round-tripping through a TOML parser.

After setup, restart Claude Code (or Codex) and the
`mcp__holographic-memory__holographic_memory_search` tool will be available.

### MCP server configuration

The setup script writes these env vars into the MCP entry. Override via flags
or by editing the generated config:

| Var | Default | Purpose |
|---|---|---|
| `PAPERCLIP_HOLO_MEMORY_DB` | `~/.paperclip/instances/default/hermes-memory.db` | Same DB the worker uses |
| `PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED` | `true` | Read-action gate |
| `PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED` | `true` | Write-action gate (intentional opt-in: MCP-mode users explicitly wired this in) |
| `PAPERCLIP_HOLO_MEMORY_MIN_TRUST` | `0.3` | minTrustScore |
| `PAPERCLIP_HOLO_MEMORY_MAX_RECALL` | `10` | maxFactsPerRecall |

### Cross-process recall

The worker writes recall-cache files to
`<dirname(dbPath)>/recall-cache/{run,issue,agent}/<id>.json` on
`agent.run.started`. The standalone MCP server reads these when the agent
calls `recall_context` with `run_id`/`issue_id`/`agent_id` set, so
claude_local/codex_local agents can still resolve pre-fetched memory.
Without an explicit ID, `recall_context` returns
`{ mode: "standalone", cached: false }` and the agent should call
`action: "search"` instead. Stale cache files are GC'd after 24h.

### Limitations

- **dbPath drift**: if you change `dbPath` in Paperclip Settings, re-run
  `pnpm setup:mcp --refresh` so the MCP server's env stays in sync.
- **Concurrent writers**: SQLite WAL serializes writers; `busy_timeout=5000`
  is set so contended writes wait up to 5s for the lock. Single-user dev
  profiles never hit this; CI farms running many concurrent agents might.

## Agent tool

`holographic_memory_search`

```json
{
  "action": "search",
  "query": "vara wallet idl",
  "limit": 5
}
```

Read actions (gated by `recallEnabled`):

- `search`: FTS5 + Jaccard + HRR + trust-ranked recall.
- `probe`: facts linked to one entity.
- `related`: HRR-based entity adjacency.
- `reason`: facts linked to all provided entities.
- `list`: browse facts by trust/category (returns JSON).
- `recall_context`: return the cached MEMORY CONTEXT for a run/issue/agent.
  Resolves explicit `run_id` / `issue_id` / `agent_id`, then falls back to
  the calling tool's `runCtx.runId` / `runCtx.agentId`, then to a live
  `query` if provided. Returns guidance text if nothing matches.

Write actions (gated by `retainEnabled`, all return JSON):

- `add`: insert a fact (`content` required; optional `category`, `tags`,
  `trust_score`). Idempotent on `content` — re-adding returns the existing
  `factId` with `inserted: false`.
- `update`: change `content`, `category`, `tags`, or `trust_delta` for a
  `fact_id`. Re-extracts entities and recomputes the HRR vector when content
  changes. Returns `{ updated: false, reason: "duplicate_content" }` on a
  content collision.
- `feedback`: update trust using `fact_id` and `helpful` (returns JSON).
  Mutates `trust_score`, `helpful_count`, and `updated_at` on the fact row,
  so it is gated by `retainEnabled` alongside the other write actions.
- `remove`: hard-delete by `fact_id`. Drops entity links and rebuilds the
  affected category bank.

Returns ranked facts formatted as:

```text
MEMORY CONTEXT:
1. [id=1; project; trust=0.50 score=0.250 tags=vara-wallet] ...
```

## How it works

```text
agent.run.started (PluginEvent)
  -> recall(issue title + description) using event.companyId
  -> write formatted MEMORY CONTEXT to ctx.state under three scope keys:
       run:<runId>:recall:context
       issue:<issueId>:recall:context
       agent:<agentId>:recall:context

agent running...
  -> holographic_memory_search(action="recall_context")
       resolves the cached state via run/issue/agent (or runCtx fallback)
  -> holographic_memory_search(action="search"|"probe"|"reason"|...)
       targeted retrieval against the DB
  -> holographic_memory_search(action="add"|"update"|"remove")
       only when retainEnabled=true; wrapped in a SQLite transaction

import:facts / seed:paperclip
  -> read curated JSON or Paperclip Postgres
  -> insert through MemoryStore so entities, HRR vectors, FTS index, and
     category banks stay consistent
```

Memory is keyed by the isolated SQLite file, not by a Paperclip session or run.
Delete `~/.paperclip/instances/default/hermes-memory.db` to reset Paperclip
agent memory without touching personal Hermes memory.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Network access is required to install `@paperclipai/plugin-sdk` and other npm
dependencies.

## References

- [Paperclip](https://github.com/paperclipai/paperclip) - Open-source orchestration platform.
- [Paperclip Plugin Authoring Guide](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md) - current plugin authoring surface.
- [Paperclip Plugin SDK README](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/README.md) - SDK package reference.
- [awesome-paperclip](https://github.com/gsxdsm/awesome-paperclip) - curated list of Paperclip plugins and resources.
- [Hindsight Paperclip integration](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/paperclip) - reference pattern for recall before runs, agent tools, and plugin state.
- [Hermes memory providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers/) - Hermes memory provider overview.
- [Hermes holographic memory source](https://github.com/NousResearch/hermes-agent/tree/main/plugins/memory/holographic) - upstream provider model for facts, entities, HRR vectors, and memory banks.
