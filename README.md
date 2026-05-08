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
- Runtime recall from local SQLite.
- FTS5/Jaccard/trust-ranked fact search.
- Hermes-style entity extraction and entity-linked recall.
- Deterministic HRR vectors on inserted facts.
- Category memory banks stored as `cat:<category>`.
- Fact feedback that adjusts trust scores.
- One-time seed script from Paperclip Postgres.
- No event-driven fact extraction.

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

## Seed from Paperclip Postgres

Paperclip data can be imported into the isolated memory DB with:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm seed:paperclip
```

Options:

```bash
pnpm seed:paperclip --dry-run
pnpm seed:paperclip --database-url postgres://user:pass@localhost:54329/paperclip
pnpm seed:paperclip --db-path ~/.paperclip/instances/default/hermes-memory.db
```

The seeder reads `issues`, `runs`, `agents`, and `comments` when present. It
extracts completed issue resolutions, recurring run errors, agent capability
notes, and workflow decisions. It writes facts with `paperclip:*` categories and
deduplicates by fact content.

## Agent tool

`holographic_memory_search`

```json
{
  "action": "search",
  "query": "vara wallet idl",
  "limit": 5
}
```

Supported actions mirror the useful subset of Hermes `fact_store`:

- `search`: FTS/Jaccard/trust-ranked keyword recall.
- `probe`: facts linked to one entity.
- `related`: HRR-based entity adjacency.
- `reason`: facts linked to all provided entities.
- `list`: browse facts by trust/category.
- `feedback`: update trust using `fact_id` and `helpful`.

Returns ranked facts formatted as:

```text
MEMORY CONTEXT:
1. [id=1; project; trust=0.50 score=0.250 tags=vara-wallet] ...
```

## How it works

```text
agent.run.started
  -> recall(issue title + description)
  -> store formatted MEMORY CONTEXT in plugin state for this run

agent running...
  -> holographic_memory_search(action="search" | "probe" | "reason" | ...)

seed:paperclip
  -> read Paperclip Postgres
  -> extract durable facts
  -> insert through MemoryStore so entities, HRR vectors, and banks stay consistent
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
