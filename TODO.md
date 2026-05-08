# TODO

Pickup plan for stabilizing the plugin. Each row links to a tracking issue
on GitHub. Status, blockers, and rough effort included so anyone can grab
the next item without re-doing the analysis.

Effort columns: **H** = wall-clock human time, **CC** = Claude-Code-driven time
once the prerequisite is met.

---

## Tier 1 — blocks "production-stable" claim

These two are the difference between "the code is correct" and "the plugin
actually works in a running Paperclip host."

| # | Issue | Status | Blocked by | H | CC |
|---|---|---|---|---|---|
| 1 | [#3 — Verify runWorker call pattern for Paperclip host](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/3) | open | — | ~1d | ~30m once installed |
| 2 | [#11 — Auto-extract facts on `agent.run.completed`](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/11) | open | #3 | ~3d | ~2h |

**Rationale:** Until #3 is closed we don't know if the tool description
renders, if `agent.run.started` events arrive, or if `ctx.state.set` round-trips
across worker restarts. Everything else is theory. #11 turns the store from
"static seed-fed index" to "growing working memory" — Hermes' real advantage.

---

## Tier 2 — bites within the first month of real use

| # | Issue | Status | Blocked by | H | CC |
|---|---|---|---|---|---|
| 3 | [#7 — Observability counters via plugin metrics](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/7) | open | #3 | ~½d | ~30m |
| 4 | [#8 — Trust decay over time](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/8) | open | — | ~½d | ~30m |
| 5 | [#9 — Schema migration framework](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/9) | open | — | ~1d | ~1h |
| 6 | [#10 — HRR vector backfill CLI](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/10) | open | — | ~2h | ~15m |

**Rationale:** Without #7 you can't tell if recall is firing in production.
Without #8 stale kill-verdicts crowd out fresh truth. #9 must land before
#11 / #14 because both add columns — first migration set the precedent.
#10 is a one-shot rescue for anyone migrating an existing Hermes DB.

---

## Tier 3 — polish and scale

| # | Issue | Status | Blocked by | H | CC |
|---|---|---|---|---|---|
| 7 | [#14 — Per-fact provenance (agentId/runId/source)](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/14) | open | #9 | ~1d | ~1h |
| 8 | [#12 — Contradiction detection action](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/12) | open | — | ~1d | ~2h |
| 9 | [#15 — Bounded category banks (eviction)](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/15) | open | — | ~½d | ~30m |
| 10 | [#13 — Concurrent-write stress test](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/13) | open | — | ~2h | ~15m |
| 11 | [#16 — Settings UI smoke test](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/16) | open | #3 | ~1h | n/a alone |
| 12 | [#5 — Publish plugin to npm when stable](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/5) | open | tier 1 + 2 done | ~½d | ~30m |
| 13 | `setup:mcp --refresh` reads Paperclip plugin config directly | open | #20 merged | ~½d | ~30m |

**#13 detail:** today `--refresh` re-reads `--db-path` flag or `PAPERCLIP_HOLO_MEMORY_DB` env, then rewrites the MCP entry. Better: locate Paperclip's persisted plugin instance config (path TBD — needs a small read of paperclip server source) and pull the live `dbPath` from there so a Settings UI change auto-propagates on next `pnpm setup:mcp --refresh`. Couples the script to Paperclip's config layout; defer until Paperclip stabilizes that layout.

**Rationale:** All additive. #14 and #12 unlock filters and safety for #11's
auto-extracted facts. #15 only matters past ~thousands of facts. #5 (npm publish)
is the right last step — defer until the plugin has stabilized in real use.

---

## Recommended pickup order

```
#3  ──▶  #11  ──▶  #7  ──▶  #8  ──▶  #9  ──▶  #14, #12, #15, #13  ──▶  #16  ──▶  #5
```

That's the path from "works at all on a host" → "growing store with trust
dynamics" → "schema-safe to extend further" → "polish and ship."

---

## Out of scope (won't fix unless requirements change)

- **LLM-based fact extraction.** Auto-extract (#11) starts with regex per
  Hermes parity. LLM extraction is a separate, larger conversation.
- **Multi-process DB access.** Current Paperclip plugin model is single
  worker per plugin; if that changes, revisit #13.
- **Soft delete / tombstones.** Decision D11 in the working-memory plan
  chose hard delete for Hermes parity; backups are the safety net.
- **Per-fact edit history.** Audit trail beyond `updated_at` is
  out of scope until someone needs it.
