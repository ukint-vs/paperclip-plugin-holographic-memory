# Memory Curation Guide

How to use Claude Code (or any LLM) to extract durable facts from raw company sources and load them into the holographic memory.

## What counts as a durable fact

A fact is worth storing if:

- **It survives the current task.** Project decisions, architecture rationale, recurring errors, user preferences, tool quirks, capability boundaries.
- **It's expensive to re-derive.** Something an agent would otherwise have to re-discover by reading code, asking the user, or hitting a wall.
- **It's declarative.** "Vara wallet supports IDL-aware calls" beats "Use the IDL flag when calling Vara."
- **It names entities.** Quoted terms, capitalized multi-word phrases, and "X aka Y" patterns get auto-extracted into the entity graph and feed `probe`/`reason`/`related`.

A fact is NOT worth storing if:

- **It's transient.** "Currently working on issue #42." "User just asked about logging."
- **It's re-discoverable cheaply.** "The repo has a package.json." "TypeScript compiles to JavaScript."
- **It's a conversation summary.** "We discussed the new design today."
- **It's an instruction, not a fact.** "Always run tests before commit" → reframe as "Project policy: tests run before commit (because of past CI breakage)."

## Categories

Match the existing taxonomy:

| Category | Use for |
|---|---|
| `project` | Architecture, design decisions, spec details, integration points |
| `user_pref` | How the user wants things done, communication style, tool preferences |
| `tool` | Tool quirks, deprecated APIs, version-specific behaviors |
| `general` | Anything else durable |
| `paperclip:resolution` | A specific issue resolution worth remembering |
| `paperclip:workflow` | Run discoveries, decisions made during work |
| `paperclip:agent-capability` | What an agent can/can't do |
| `paperclip:error` | Recurring run errors and their causes |

## Trust score

Set thoughtfully — feedback adjusts it over time, but the seed value matters:

| Score | Meaning |
|---|---|
| 0.8+ | Confirmed, documented, normative spec |
| 0.6–0.7 | Observed pattern, well-supported decision |
| 0.5 (default) | Reasonable claim, not yet validated |
| 0.3–0.4 | Speculative, worth recording but flag for review |
| <0.3 | Don't bother — recall filters it out by default |

## Output format

Emit JSON. Either a single fact or an array. Pipe to `pnpm import:facts` (which calls `addFact` for each).

```json
[
  {
    "content": "<declarative fact, 100–500 chars, names entities in Quotes or Capitalized Phrases>",
    "category": "project",
    "tags": ["domain", "subsystem", "version-tag"],
    "trustScore": 0.7
  },
  {
    "content": "...",
    "category": "user_pref",
    "tags": "comma,separated,also,fine",
    "trustScore": 0.6
  }
]
```

## Workflow with Claude Code

The agent does the **gathering** and **filtering**; the CLI does the **insertion**.

### Pattern A — interactive (recommended for first run)

In a Claude Code session against this repo:

```
Read ~/path/to/source. Extract durable facts following scripts/CURATION.md.
Emit a JSON array. Then pipe it to pnpm import:facts --dry-run so I can review,
and if I approve, run it again without --dry-run.
```

The agent reads the source, drafts facts, shows them dry-run, you approve, it runs the real import.

### Pattern B — batch (once you trust the prompt)

Write the source description into a prompt file and run headless:

```bash
claude -p "$(cat scripts/CURATION.md) Now process: $(cat ~/source.md). Output ONLY a JSON array of facts." \
  | pnpm import:facts
```

### Pattern C — scoped to a domain

Tell the agent to only extract facts for one category at a time:

```
Read all decision/architecture comments in /path/to/repo. Extract ONLY
project-category facts. Skip user_pref, tool quirks, and resolutions.
```

This works well when sources mix many concerns.

## Source ideas

The plugin is source-agnostic — anything an LLM can read becomes a candidate.

- **Paperclip Postgres** — already covered by `pnpm seed:paperclip`. Use that for the bulk first pass; use Claude Code for the long tail.
- **Linear / GitHub issues** — `gh issue list --json` or Linear export, pass to Claude.
- **Repo READMEs / docs** — point Claude at a directory.
- **Slack export** — JSON dump filtered by channel.
- **Past Claude Code transcripts** — `~/.claude/projects/.../session.jsonl`.
- **Enzyme vault** — `enzyme catalyze` queries return excerpts ready for fact extraction.
- **Email threads** — paste the body, ask for decisions and constraints.
- **Meeting notes** — extract decisions, action item rationale, deferred work.

## Idempotency

`addFact` dedupes by content (UNIQUE on `facts.content`). Re-running the same import is safe — duplicates report `inserted: false` without changing existing trust/retrieval counts. Prefer canonical phrasing so dedup catches obvious repeats.

## After import

Verify with the agent tool or directly:

```bash
# Sanity check — facts exist
sqlite3 ~/.paperclip/instances/default/hermes-memory.db \
  "SELECT category, COUNT(*) FROM facts GROUP BY category"

# Or via the agent in a Paperclip run:
# Call holographic_memory_search with action="search", query="<topic>"
```

## Maintenance

- Run `feedback` (helpful/unhelpful) on facts when agents use them. Trust scores converge over time.
- Periodically re-run curation against the same source — newly-added context gets picked up; existing facts stay deduped.
- Use `update` to refine wording when a fact's accuracy drifts.
- Use `remove` when a fact becomes flatly wrong (rare — usually `feedback unhelpful` is enough to bury it).
