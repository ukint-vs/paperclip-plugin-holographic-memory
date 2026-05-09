---
name: holographic-memory
description: >
  Persistent cross-run memory for Paperclip agents. Every agent has access to
  `holographic_memory_search`, an MCP tool backed by an isolated SQLite DB.
  Facts survive restarts — call recall_context at the START of every run to
  get a briefing of relevant past decisions, conventions, and entity context.
  During work: search for facts, probe entities, reason across multiple entities.
  After work: store durable lessons and rate facts used. Treat this as your
  long-term memory. If you don't call it, you have no memory between runs.
---

# Holographic Memory

Persistent, cross-run memory for agents via `holographic_memory_search`. An isolated SQLite DB stores facts — they survive agent restarts, session kills, and server reboots.

**If you don't call this tool, you have no memory between runs.**

## When to use

**Mandatory — at the START of every run, before any work:**
- Call `recall_context` with your run_id, issue_id, and agent_id to get a briefing of relevant facts.

**During a run — when you need context:**
- `search` — full-text search: `action: "search", query: "vara wallet gas voucher"`
- `probe` — all facts about one entity: `action: "probe", entity: "Vadim"`
- `reason` — facts linking multiple entities: `action: "reason", entities: ["Vara", "sails", "frontend"]`
- `related` — what connects to an entity: `action: "related", entity: "PolyBaskets"`

**At the END of a run — when you learned something durable:**
- `add` — store a fact: `action: "add", content: "...", category: "project", tags: "vara,gas"`
- `feedback` — rate a fact after using it: `action: "feedback", fact_id: 42, helpful: true`

**Find yourself about to ask the user a question you should already know the answer to?** Search memory first. User preferences, environment details, past decisions, tool quirks — these are stored. Asking the user for something that's in memory is the fastest way to lose trust.

## When NOT to use

- **Transient state.** Don't store run IDs, temporary TODOs, or progress tracking. Memory is for durable facts, not session bookmarks.
- **Raw data dumps.** Store distilled facts, not 10KB of log output.
- **As a replacement for skills.** Procedures and workflows belong in skills. Memory is for facts and context, not instructions.
- **To store secrets or credentials.** Memory is plaintext SQLite.

## Procedure

### 1. Recall context (every run, first action)

```
action: "recall_context"
run_id: "<current run ID>"
issue_id: "<current issue ID>"
agent_id: "<your agent ID>"
```

Read the returned MEMORY CONTEXT. It surfaces facts relevant to the current issue, entities mentioned, and past decisions. This is your briefing — it tells you what you knew last time.

### 2. Search before acting

Before touching a project, probe the relevant entities. Before changing a convention, search for existing patterns. Before fixing a bug, search for past pitfalls.

### 3. Store what matters

After discovering a pitfall, convention, or decision, save it as a declarative fact:

```
action: "add"
content: "Vara testnet RPC endpoint is wss://testnet.vara.network"
category: "tool"
tags: "vara,testnet,rpc"
```

Write facts as statements, not instructions:
- ✅ "Vara testnet RPC endpoint is wss://testnet.vara.network"
- ❌ "Use wss://testnet.vara.network for testnet"

### 4. Rate what you used

After a run, give feedback on facts you consumed:

```
action: "feedback"
fact_id: 42
helpful: true
```

This trains trust scores — good facts rise, stale facts sink.

## Tool reference

The tool is `holographic_memory_search` (or `mcp__holographic-memory__holographic_memory_search` depending on your adapter).

All actions accept `min_trust` (0–1) to filter weak facts. Default is 0.3.

Writes (`add`/`update`/`remove`/`feedback`) require `retainEnabled=true` in config (defaults to `true` in standalone MCP mode, `false` in the Paperclip plugin). `feedback` mutates trust_score on the fact, so it counts as a write — under the Paperclip default, Step 4 (rate what you used) is rejected until retain is enabled.

## Examples

**Starting a run on a Vara Sails issue:**
1. `action: "recall_context"` → "Vara Sails Engineer is a Hermes/DeepSeek agent, wallet v0.16.0, block time 3s..."
2. `action: "probe", entity: "Vara"` → gets wallet conventions, gas details
3. Now you know the toolchain without asking the user

**After discovering a fix:**
1. `action: "add", content: "Sails build --skip-idl avoids IDL hanging on Vara WASM >64KB", category: "tool", tags: "sails,build,pitfall"`
2. Next agent hitting the same issue searches, finds it, skips the dead end
