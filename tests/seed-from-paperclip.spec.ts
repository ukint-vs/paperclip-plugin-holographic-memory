import { describe, expect, it } from "vitest";
import {
  extractAgentFacts,
  extractCommentFacts,
  extractIssueFacts,
  extractRunFacts,
  parseArgs
} from "../scripts/seed-from-paperclip.js";

describe("seed-from-paperclip", () => {
  it("parses CLI options", () => {
    const options = parseArgs([
      "--database-url",
      "postgres://user:pass@localhost:54329/paperclip",
      "--db-path",
      "/tmp/paperclip-memory.db",
      "--dry-run"
    ]);

    expect(options.databaseUrl).toBe("postgres://user:pass@localhost:54329/paperclip");
    expect(options.dbPath).toBe("/tmp/paperclip-memory.db");
    expect(options.dryRun).toBe(true);
  });

  it("extracts completed issue resolution facts", () => {
    const facts = extractIssueFacts([
      {
        id: "issue-1",
        title: "Fix plugin recall",
        status: "completed",
        resolution: "Moved required into parametersSchema."
      }
    ]);

    expect(facts).toHaveLength(1);
    expect(facts[0]?.category).toBe("paperclip:resolution");
    expect(facts[0]?.content).toContain("Fix plugin recall");
  });

  it("extracts recurring run errors", () => {
    const facts = extractRunFacts([
      { id: "run-1", error: "database locked" },
      { id: "run-2", error: "database locked" }
    ]);

    expect(facts[0]?.category).toBe("paperclip:error");
    expect(facts[0]?.content).toContain("seen 2 times");
  });

  it("extracts agent capabilities and workflow comments", () => {
    expect(extractAgentFacts([{ id: "agent-1", name: "builder", capabilities: "Can run tests" }])).toHaveLength(1);
    expect(extractCommentFacts([{ id: "comment-1", body: "Decision: keep memory isolated" }])).toHaveLength(1);
  });
});
