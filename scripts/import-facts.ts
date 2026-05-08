#!/usr/bin/env tsx
// Import facts from JSON (file or stdin) into the holographic memory.
//
// Usage:
//   pnpm tsx scripts/import-facts.ts [--db-path PATH] [--dry-run] [FILE]
//   cat facts.json | pnpm tsx scripts/import-facts.ts
//   echo '{"content": "..."}' | pnpm tsx scripts/import-facts.ts
//
// JSON shape (single fact or array of facts):
//   {
//     "content": "Declarative fact, 100-500 chars.",         // required
//     "category": "project|user_pref|tool|general|paperclip:resolution|...",
//     "tags": ["string"] | "comma,separated",
//     "trustScore": 0.7                                       // 0..1, default 0.5
//   }
//
// Dedups by content (UNIQUE constraint). Existing facts stay untouched.

import { readFileSync } from "node:fs";
import { DEFAULT_DB_PATH, expandHome } from "../src/config.js";
import { MemoryStore } from "../src/memory-store.js";
import type { NewMemoryFact } from "../src/types.js";

interface CliOptions {
  dbPath: string;
  dryRun: boolean;
  inputFile?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: expandHome(DEFAULT_DB_PATH),
    dryRun: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--db-path") {
      const next = args[i + 1];
      if (!next) throw new Error("--db-path requires a value");
      options.dbPath = expandHome(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    options.inputFile = arg;
  }
  return options;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function asArray(parsed: unknown): NewMemoryFact[] {
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .map((row) => {
      if (typeof row.content !== "string" || !row.content.trim()) {
        throw new Error(`Fact missing required 'content' string: ${JSON.stringify(row).slice(0, 120)}`);
      }
      const fact: NewMemoryFact = { content: row.content };
      if (typeof row.category === "string") fact.category = row.category;
      if (Array.isArray(row.tags) || typeof row.tags === "string") {
        fact.tags = row.tags as string | string[];
      }
      const trust = row.trustScore ?? row.trust_score;
      if (typeof trust === "number" && !Number.isNaN(trust)) fact.trustScore = trust;
      return fact;
    });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const raw = options.inputFile ? readFileSync(options.inputFile, "utf8") : await readStdin();
  if (!raw.trim()) {
    console.error("No input. Pipe JSON to stdin or pass a FILE path.");
    process.exit(2);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error("Input is not valid JSON:", err instanceof Error ? err.message : err);
    process.exit(2);
  }

  const facts = asArray(parsed);
  console.log(`Parsed ${facts.length} fact(s). Target DB: ${options.dbPath}`);
  if (options.dryRun) {
    for (const fact of facts.slice(0, 20)) {
      console.log(`- [${fact.category ?? "general"}] ${fact.content.slice(0, 120)}${fact.content.length > 120 ? "…" : ""}`);
    }
    if (facts.length > 20) console.log(`  ... +${facts.length - 20} more`);
    console.log("Dry run — no writes.");
    return;
  }

  const store = new MemoryStore(options.dbPath);
  let inserted = 0;
  let skipped = 0;
  let errored = 0;
  try {
    for (const fact of facts) {
      try {
        const result = store.addFact(fact);
        if (result.inserted) inserted += 1;
        else skipped += 1;
      } catch (err) {
        errored += 1;
        console.error(`  error on "${fact.content.slice(0, 60)}…":`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    store.close();
  }

  console.log(`\nInserted: ${inserted}`);
  console.log(`Skipped (already present): ${skipped}`);
  if (errored > 0) console.log(`Errored: ${errored}`);
  console.log(`Total facts in DB after import: ${new MemoryStore(options.dbPath).countFacts()}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
