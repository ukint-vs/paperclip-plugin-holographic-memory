import { describe, expect, it } from "vitest";
import { formatFactsAsText, formatFactsForPrompt } from "../src/context-injector.js";
import type { MemoryFact } from "../src/types.js";

const fact: MemoryFact = {
  factId: 1,
  content: "Paperclip should recall existing memory before agent runs.",
  category: "project",
  tags: "paperclip,memory",
  trustScore: 0.75,
  retrievalCount: 0,
  helpfulCount: 0
};

describe("context formatting", () => {
  it("formats facts for prompt injection", () => {
    expect(formatFactsForPrompt([fact])).toBe(
      "MEMORY CONTEXT:\n1. [id=1; project; trust=0.75 tags=paperclip,memory] Paperclip should recall existing memory before agent runs."
    );
  });

  it("keeps empty recall quiet", () => {
    expect(formatFactsForPrompt([])).toBe("");
    expect(formatFactsAsText([])).toBe("No holographic memory facts matched the query.");
  });
});
