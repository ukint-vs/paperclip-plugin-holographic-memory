import { Client } from "pg";
import { DEFAULT_DB_PATH, expandHome } from "../src/config.js";
import { MemoryStore } from "../src/memory-store.js";
import type { NewMemoryFact } from "../src/types.js";

const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:54329/postgres";
const SOURCE_TABLES = ["issues", "runs", "agents", "comments"] as const;

interface CliOptions {
  databaseUrl: string;
  dbPath: string;
  dryRun: boolean;
}

interface TableColumn {
  table_name: string;
  column_name: string;
}

type Schema = Map<string, Set<string>>;
type Row = Record<string, unknown>;

interface SeedSummary {
  scannedRows: number;
  candidateFacts: number;
  insertedFacts: number;
  updatedFacts: number;
  skippedCandidates: number;
}

interface ExtractionResult {
  scannedRows: number;
  facts: NewMemoryFact[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = new Client({ connectionString: options.databaseUrl });

  await client.connect();

  try {
    const schema = await loadSchema(client);
    assertUsableSchema(schema);
    const extraction = await extractFacts(client, schema);
    const summary = seedFacts(extraction, options);

    printSummary(summary, options, extraction.facts);
  } finally {
    await client.end();
  }
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    dbPath: expandHome(DEFAULT_DB_PATH),
    dryRun: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--database-url") {
      options.databaseUrl = readArgValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--db-path") {
      options.dbPath = expandHome(readArgValue(args, index, arg));
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function loadSchema(client: Client): Promise<Schema> {
  const result = await client.query<TableColumn>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1)
     ORDER BY table_name, ordinal_position`,
    [SOURCE_TABLES]
  );
  const schema: Schema = new Map();

  for (const row of result.rows) {
    const columns = schema.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    schema.set(row.table_name, columns);
  }

  return schema;
}

function assertUsableSchema(schema: Schema): void {
  const present = SOURCE_TABLES.filter((table) => schema.has(table));

  if (!present.length) {
    throw new Error(
      `Paperclip schema not found. Expected at least one of: ${SOURCE_TABLES.join(", ")}`
    );
  }

  const missingId = present.filter((table) => !hasAny(schema, table, ["id", `${table.slice(0, -1)}_id`]));

  if (missingId.length) {
    throw new Error(
      `Paperclip schema is missing id columns for: ${missingId.join(", ")}. ` +
        `Available schema: ${formatSchema(schema)}`
    );
  }
}

export async function extractFacts(client: Client, schema: Schema): Promise<ExtractionResult> {
  const facts: NewMemoryFact[] = [];
  let scannedRows = 0;

  if (schema.has("issues")) {
    const rows = await loadRows(client, schema, "issues", 500);
    scannedRows += rows.length;
    facts.push(...extractIssueFacts(rows));
  }

  if (schema.has("runs")) {
    const rows = await loadRows(client, schema, "runs", 1000);
    scannedRows += rows.length;
    facts.push(...extractRunFacts(rows));
  }

  if (schema.has("agents")) {
    const rows = await loadRows(client, schema, "agents", 500);
    scannedRows += rows.length;
    facts.push(...extractAgentFacts(rows));
  }

  if (schema.has("comments")) {
    const rows = await loadRows(client, schema, "comments", 500);
    scannedRows += rows.length;
    facts.push(...extractCommentFacts(rows));
  }

  return { scannedRows, facts: dedupeFacts(facts) };
}

async function loadRows(client: Client, schema: Schema, table: string, limit: number): Promise<Row[]> {
  const columns = [...(schema.get(table) ?? [])];
  const safeColumns = columns.map((column) => quoteIdent(column)).join(", ");

  if (!safeColumns) {
    return [];
  }

  const orderColumn = columns.includes("updated_at")
    ? "updated_at"
    : columns.includes("created_at")
      ? "created_at"
      : (columns[0] ?? "id");
  const result = await client.query<Row>(
    `SELECT ${safeColumns} FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(orderColumn)} DESC NULLS LAST LIMIT $1`,
    [limit]
  );

  return result.rows;
}

export function extractIssueFacts(rows: Row[]): NewMemoryFact[] {
  return rows.flatMap((row) => {
    if (!isCompleted(row)) {
      return [];
    }

    const title = firstText(row, ["title", "name", "summary"]);
    const resolution = firstText(row, ["resolution", "result", "outcome", "description", "body"]);

    if (!title || !resolution) {
      return [];
    }

    return [{
      content: `Paperclip issue resolved: ${title}. Resolution: ${truncate(resolution, 900)}`,
      category: "paperclip:resolution",
      tags: sourceTags("issues", row),
      trustScore: 0.7
    }];
  });
}

export function extractRunFacts(rows: Row[]): NewMemoryFact[] {
  const facts: NewMemoryFact[] = [];
  const errors = new Map<string, number>();

  for (const row of rows) {
    const error = firstText(row, ["error", "error_message", "failure_reason", "stderr"]);

    if (error) {
      const normalized = truncate(error.replace(/\s+/g, " ").trim(), 240);
      errors.set(normalized, (errors.get(normalized) ?? 0) + 1);
    }

    const output = firstText(row, ["output", "result", "summary"]);

    if (output && /fixed|resolved|learned|discovered|workaround|root cause/i.test(output)) {
      facts.push({
        content: `Paperclip run discovery: ${truncate(output, 900)}`,
        category: "paperclip:workflow",
        tags: sourceTags("runs", row),
        trustScore: 0.6
      });
    }
  }

  for (const [error, count] of errors) {
    if (count > 1) {
      facts.push({
        content: `Recurring Paperclip run error seen ${count} times: ${error}`,
        category: "paperclip:error",
        tags: ["paperclip", "runs", "recurring-error"],
        trustScore: 0.65
      });
    }
  }

  return facts;
}

export function extractAgentFacts(rows: Row[]): NewMemoryFact[] {
  return rows.flatMap((row) => {
    const name = firstText(row, ["name", "slug", "model", "type"]);
    const capability = firstText(row, ["capabilities", "description", "instructions", "system_prompt"]);

    if (!name || !capability) {
      return [];
    }

    return [{
      content: `Paperclip agent capability: ${name}: ${truncate(capability, 700)}`,
      category: "paperclip:agent-capability",
      tags: sourceTags("agents", row),
      trustScore: 0.6
    }];
  });
}

export function extractCommentFacts(rows: Row[]): NewMemoryFact[] {
  return rows.flatMap((row) => {
    const body = firstText(row, ["body", "content", "text", "message"]);

    if (!body || !/decision|decided|root cause|workaround|fixed|resolved/i.test(body)) {
      return [];
    }

    return [{
      content: `Paperclip discussion note: ${truncate(body, 700)}`,
      category: "paperclip:workflow",
      tags: sourceTags("comments", row),
      trustScore: 0.55
    }];
  });
}

function seedFacts(extraction: ExtractionResult, options: CliOptions): SeedSummary {
  const { facts } = extraction;
  const summary: SeedSummary = {
    scannedRows: extraction.scannedRows,
    candidateFacts: facts.length,
    insertedFacts: 0,
    updatedFacts: 0,
    skippedCandidates: 0
  };

  if (options.dryRun) {
    return summary;
  }

  const store = new MemoryStore(options.dbPath);

  try {
    for (const fact of facts) {
      try {
        const result = store.addFact(fact);

        if (result.inserted) {
          summary.insertedFacts += 1;
        } else {
          summary.updatedFacts += 1;
        }
      } catch {
        summary.skippedCandidates += 1;
      }
    }
  } finally {
    store.close();
  }

  return summary;
}

function printSummary(summary: SeedSummary, options: CliOptions, facts: NewMemoryFact[]): void {
  console.log(`Paperclip memory DB: ${options.dbPath}`);
  console.log(`Dry run: ${options.dryRun ? "yes" : "no"}`);
  console.log(`Scanned rows: ${summary.scannedRows}`);
  console.log(`Candidate facts: ${summary.candidateFacts}`);
  console.log(`Inserted facts: ${summary.insertedFacts}`);
  console.log(`Updated facts: ${summary.updatedFacts}`);
  console.log(`Skipped candidates: ${summary.skippedCandidates}`);

  if (options.dryRun) {
    for (const fact of facts.slice(0, 20)) {
      console.log(`- [${fact.category}] ${fact.content}`);
    }
  }
}

function dedupeFacts(facts: NewMemoryFact[]): NewMemoryFact[] {
  const seen = new Set<string>();
  const result: NewMemoryFact[] = [];

  for (const fact of facts) {
    const key = fact.content.trim();

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(fact);
  }

  return result;
}

function isCompleted(row: Row): boolean {
  const status = firstText(row, ["status", "state", "phase"]);
  const completedAt = row.completed_at ?? row.resolved_at ?? row.closed_at;

  return Boolean(completedAt) || /done|complete|completed|resolved|closed/i.test(status ?? "");
}

function firstText(row: Row, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (value && typeof value === "object") {
      return JSON.stringify(value);
    }
  }

  return undefined;
}

function sourceTags(table: string, row: Row): string[] {
  const tags = ["paperclip", table];
  const id = row.id ?? row[`${table.slice(0, -1)}_id`];

  if (typeof id === "string" || typeof id === "number") {
    tags.push(`${table.slice(0, -1)}:${id}`);
  }

  return tags;
}

function hasAny(schema: Schema, table: string, columns: string[]): boolean {
  const tableColumns = schema.get(table);

  return Boolean(tableColumns && columns.some((column) => tableColumns.has(column)));
}

function formatSchema(schema: Schema): string {
  return [...schema.entries()]
    .map(([table, columns]) => `${table}(${[...columns].join(", ")})`)
    .join("; ");
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function readArgValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
