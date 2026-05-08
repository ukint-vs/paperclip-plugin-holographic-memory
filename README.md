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

## v1 scope

- Isolated Paperclip memory DB, created on first use.
- Runtime recall from local SQLite.
- FTS5 fact search plus entity-linked fallback.
- One-time seed script from Paperclip Postgres.
- No event-driven fact extraction.
- No HRR vector algebra.
- No multi-bank routing.

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

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Network access is required to install `@paperclipai/plugin-sdk` and other npm
dependencies.
