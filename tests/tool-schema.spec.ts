import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { HOLO_MEMORY_ACTIONS, HoloMemorySearchSchema, toJsonSchema } from "../src/tool-schema.js";

describe("tool-schema", () => {
  it("exports the canonical action set", () => {
    expect(new Set(HOLO_MEMORY_ACTIONS)).toEqual(
      new Set([
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
      ]),
    );
  });

  it("zod .shape exposes every documented field", () => {
    const keys = Object.keys(HoloMemorySearchSchema.shape);
    expect(keys).toEqual(
      expect.arrayContaining([
        "action",
        "query",
        "entity",
        "entities",
        "category",
        "fact_id",
        "helpful",
        "limit",
        "min_trust",
        "run_id",
        "issue_id",
        "agent_id",
        "content",
        "tags",
        "trust_score",
        "trust_delta",
      ]),
    );
  });

  it("manifest derives parametersSchema from toJsonSchema()", () => {
    const tool = manifest.tools?.[0];
    expect(tool?.name).toBe("holographic_memory_search");
    expect(tool?.parametersSchema).toEqual(toJsonSchema());
  });

  it("toJsonSchema is stable across calls (cached)", () => {
    const a = toJsonSchema();
    const b = toJsonSchema();
    // Identity equality, not just structural — proves the cache returns the
    // same instance and hasn't been regenerated on every call.
    expect(a).toBe(b);
  });

  it("generated schema has type:object and the action enum", () => {
    const schema = toJsonSchema() as { type: string; properties: Record<string, { enum?: string[] }> };
    expect(schema.type).toBe("object");
    expect(schema.properties.action?.enum).toEqual(Array.from(HOLO_MEMORY_ACTIONS));
  });
});
