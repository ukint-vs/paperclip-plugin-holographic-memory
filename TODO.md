# TODO

Pickup plan for evolving the plugin past the 0.4.0 first npm release. Each row
links to a tracking issue on GitHub. Status, blockers, and rough effort included
so anyone can grab the next item without re-doing the analysis.

Effort columns: **H** = wall-clock human time, **CC** = Claude-Code-driven time
once the prerequisite is met.

---

## Shipped in 0.4.0 (2026-05-09)

The 0.4.0 first-npm-release closed the following tier-1/tier-2 items. See the
release CHANGELOG for the precise change shape.

| # | Issue | Shipped in |
|---|---|---|
| ~~1~~ | [#11 — Auto-extract facts on `agent.run.finished`](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/11) | 0.2.0 |
| ~~2~~ | [#14 — Per-fact provenance (agentId/runId/source)](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/14) | 0.2.0 |
| ~~3~~ | [#7 — Observability counters via plugin metrics](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/7) | 0.4.0 |
| ~~4~~ | [#8 — Trust decay over time](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/8) | 0.4.0 |
| ~~5~~ | [#3 — Cross-tenant scoping](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/3) | 0.4.0 |
| ~~6~~ | [#5 — Publish plugin to npm when stable](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/5) | 0.4.0 |

Closed as deferred-pending-multi-tenant (reopen alongside the second company
onboarding):

- [#9 — Schema migration framework](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/9) — current `ALTER TABLE` shim is sufficient through 0.4.x. Real migration framework lands when the first company-facing schema break forces it.
- [#28 — MCP cross-tenant scoping](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/28) — MCP standalone mode is intentionally tenant-blind today; per-company MCP servers with per-company dbPaths is the workaround.

---

## Tier 1 — blocks the "production-stable" claim post-0.4.0

| # | Issue | Status | Blocked by | H | CC |
|---|---|---|---|---|---|
| 1 | [#3 — Verify runWorker call pattern for Paperclip host](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/3) | open | — | ~1d | ~30m once installed |

**Rationale:** Until #3 is closed in a real running Paperclip host (issue
overlaps the cross-tenant work that already shipped — track the *host smoke*
half here), we don't have first-hand confirmation that the manifest renders,
that `agent.run.started` events arrive, or that `ctx.state.set` round-trips
across worker restarts under the published 0.4.0 artifact. End-to-end host
smoke before 0.5 cuts.

---

## Tier 2 — bites within the first month of real npm use

| # | Issue | Status | Blocked by | H | CC |
|---|---|---|---|---|---|
| 2 | [#10 — HRR vector backfill CLI](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/10) | open | — | ~2h | ~15m |
| 3 | [#16 — Settings UI smoke test](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/16) | open | tier-1 #3 | ~1h | n/a alone |
| 4 | Detect global-bin on PATH in setup-mcp; switch from `npx` to direct command when available | open | — | ~½d | ~30m |
| 5 | GitHub Actions auto-publish on tag push | open | — | ~½d | ~30m |
| 6 | File locking for concurrent setup-mcp install + uninstall | open | only if users hit it | ~½d | ~30m |

**Rationale for 4–6:** All raised by the 0.4.0 outside-voice review (Codex);
explicitly deferred. #4 fixes the per-spawn `npx` cold-start cost when a global
install is present. #5 automates the manual publish flow once 0.4.0 proves the
pipeline. #6 is documented as unsupported today; lock if real-world usage hits
the race.

---

## Tier 3 — polish and scale

| # | Issue | Status | Blocked by | H | CC |
|---|---|---|---|---|---|
| 7 | [#12 — Contradiction detection action](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/12) | open | — | ~1d | ~2h |
| 8 | [#15 — Bounded category banks (eviction)](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/15) | open | — | ~½d | ~30m |
| 9 | [#13 — Concurrent-write stress test](https://github.com/ukint-vs/paperclip-plugin-holographic-memory/issues/13) | open | — | ~2h | ~15m |
| 10 | `--args` parser: support args containing commas / multiple `--args` repetitions | open | only if users hit it | ~1h | ~10m |
| 11 | `atomicWrite` durability (fsync file + parent dir) | open | only if a power-loss bug surfaces | ~1h | ~10m |

**Rationale:** All additive. #7 and #8 are knowledge-management features for
the multi-thousand-fact regime. #9 only matters past concurrent-agent CI farms.
#10 and #11 came out of the 0.4.0 outside-voice review and are deferred until
a real user hits the corner case.

---

## Recommended pickup order

```
#3 (host smoke) ──▶ #10 (HRR backfill) ──▶ #16 (Settings UI smoke)
                                            │
                                            ▼
                                  #4 / #5 (npx + GHA publish)
                                            │
                                            ▼
                              #12 / #15 / #13 / #6 / #10 / #11
```

That's the path from "0.4.0 ships clean on npm" → "production-host-verified" →
"automated release pipeline" → "polish."

---

## Out of scope (won't fix unless requirements change)

- **LLM-based fact extraction.** Auto-extract (#11) starts with regex per
  Hermes parity (shipped in 0.2.0). LLM extraction is a separate, larger
  conversation.
- **Multi-process DB access.** Current Paperclip plugin model is single
  worker per plugin; if that changes, revisit #13.
- **Soft delete / tombstones.** Decision D11 in the working-memory plan
  chose hard delete for Hermes parity; backups are the safety net.
- **Per-fact edit history.** Audit trail beyond `updated_at` is
  out of scope until someone needs it.
