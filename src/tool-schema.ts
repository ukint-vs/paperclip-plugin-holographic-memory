import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Single source of truth for the holographic_memory_search tool parameters.
// Worker registration, manifest declaration, and the standalone MCP server
// all derive from this schema so a parameter change touches one place. The
// MCP SDK consumes `.shape`; the manifest + worker consume `toJsonSchema()`.

export const HOLO_MEMORY_ACTIONS = [
  "search",
  "probe",
  "related",
  "reason",
  "recall_context",
  "list",
  "feedback",
  "add",
  "update",
  "remove",
] as const;

export const HoloMemorySearchSchema = z.object({
  action: z.enum(HOLO_MEMORY_ACTIONS).default("search").describe(
    "search/probe/related/reason/list/recall_context are read; add/update/remove/feedback require retainEnabled=true (feedback mutates trust_score on the fact).",
  ),
  query: z.string().optional().describe("Free-text query for search/recall_context fallback."),
  entity: z.string().optional().describe("Entity for probe/related."),
  entities: z.array(z.string()).optional().describe("Entity set for reason action."),
  category: z.string().optional(),
  fact_id: z.number().optional(),
  helpful: z.boolean().optional(),
  limit: z.number().min(1).max(50).default(5),
  min_trust: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum trust score for this call; overrides the plugin's minTrustScore default."),
  run_id: z.string().optional(),
  issue_id: z.string().optional(),
  agent_id: z.string().optional(),
  content: z.string().optional(),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Either a single tag string or an array of tag strings."),
  trust_score: z.number().min(0).max(1).optional(),
  trust_delta: z.number().min(-1).max(1).optional(),
});

export type HoloMemorySearchParams = z.infer<typeof HoloMemorySearchSchema>;

// Lazy because zodToJsonSchema is a small but non-trivial computation; we
// don't need it on every dispatch, only when registering the tool / building
// the manifest.
let cachedJsonSchema: Record<string, unknown> | null = null;

export function toJsonSchema(): Record<string, unknown> {
  if (cachedJsonSchema) return cachedJsonSchema;
  const generated = zodToJsonSchema(HoloMemorySearchSchema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  // Strip the top-level $schema declaration zod-to-json-schema emits — both
  // the Paperclip manifest validator and Claude Code's MCP tool registration
  // expect a bare schema object, not one with a $schema preamble.
  delete generated.$schema;
  cachedJsonSchema = generated;
  return generated;
}

export const HOLO_MEMORY_TOOL_DESCRIPTION = [
  "Holographic memory store. Facts persist across runs in an isolated SQLite DB.",
  "",
  "On the first turn of a run, call action='recall_context' to read any pre-fetched memory for the current issue.",
  "Use action='search', 'probe', or 'reason' to retrieve facts. Pass min_trust to filter weak facts.",
  "Use action='add' to store a durable fact the user would expect remembered. Mark category ('project','user_pref','tool','general') and tags.",
  "Use action='feedback' (helpful: boolean) on a fact_id after consuming it — this trains trust scores so good facts rise.",
  "Use action='update' to refine a fact's content or trust; action='remove' to delete a stale fact.",
  "Note: writes (add/update/remove) require retainEnabled=true in plugin config.",
].join("\n");
