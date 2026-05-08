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

This is an independent plugin, not an official Paperclip package. Until it is
published to npm or added to a Paperclip marketplace, install it as a local path
plugin from this checkout.

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip-plugin-holographic-memory","isLocalPath":true}'
```

Then configure it in Paperclip Settings -> Plugins -> Holographic Memory.

If this package is later published to npm, the install command can become:

```bash
pnpm paperclipai plugin install paperclip-plugin-holographic-memory
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
- `feedback`: update trust using `fact_id` and `helpful` (returns JSON).
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
