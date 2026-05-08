import { describe, expect, it } from "vitest";
import { extractFactsFromText } from "../src/auto-extract.js";

describe("extractFactsFromText", () => {
  describe("user_pref patterns", () => {
    it("matches 'I prefer X'", () => {
      const facts = extractFactsFromText("I prefer SQLite for the index");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.category).toBe("user_pref");
      expect(facts[0]?.content).toContain("I prefer SQLite");
    });

    it("matches 'I like / love / use / want / need'", () => {
      const inputs = [
        "I like minimal diffs in PRs",
        "I love declarative APIs over imperative ones",
        "I use vim for everything",
        "I want fast tests, not slow ones",
        "I need explicit over clever"
      ];
      for (const input of inputs) {
        const facts = extractFactsFromText(input);
        expect(facts).toHaveLength(1);
        expect(facts[0]?.category).toBe("user_pref");
      }
    });

    it("matches 'my favorite/preferred/default X is Y'", () => {
      const facts = extractFactsFromText("my favorite editor is Helix");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.category).toBe("user_pref");
    });

    it("matches 'I always/never/usually X'", () => {
      const facts = extractFactsFromText("I always run typecheck before commit");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.category).toBe("user_pref");
    });
  });

  describe("project patterns", () => {
    it("matches 'we decided/agreed/chose X'", () => {
      const facts = extractFactsFromText("we decided to use Postgres for the index");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.category).toBe("project");
      expect(facts[0]?.content).toContain("we decided to use Postgres");
    });

    it("matches 'the project uses/needs/requires X'", () => {
      const facts = extractFactsFromText("the project uses pnpm workspaces");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.category).toBe("project");
    });
  });

  describe("guard rails", () => {
    it("returns [] for input shorter than 10 chars", () => {
      expect(extractFactsFromText("I want X")).toEqual([]); // 8 chars
      expect(extractFactsFromText("")).toEqual([]);
    });

    it("returns [] for input with no matching patterns", () => {
      expect(extractFactsFromText("just a regular sentence with no triggers")).toEqual([]);
    });

    it("returns [] for non-string input", () => {
      expect(extractFactsFromText(undefined as unknown as string)).toEqual([]);
      expect(extractFactsFromText(null as unknown as string)).toEqual([]);
    });

    it("matches at the 10-char boundary inclusive", () => {
      // exactly 10 chars including the trigger; pattern needs the verb +
      // at least one trailing char, so this verifies the floor allows it
      const facts = extractFactsFromText("I prefer X"); // 10 chars
      expect(facts).toHaveLength(1);
    });
  });

  describe("D15: stored content = capture group, not source-text prefix", () => {
    it("captures the matched phrase, not the leading prose", () => {
      const input = "Some preamble that has nothing to do with anything. I prefer SQLite. Trailing prose.";
      const facts = extractFactsFromText(input);
      expect(facts).toHaveLength(1);
      // Stored content starts with the matched verb, not the preamble.
      expect(facts[0]?.content.startsWith("I prefer")).toBe(true);
      expect(facts[0]?.content).not.toContain("preamble");
    });

    it("T1: regex matches at source position > 400, fact.content is the captured phrase truncated to 400", () => {
      // ~500 chars of filler prefix that terminates with a non-word
      // character (so \bI matches the trigger), then the trigger
      // phrase. Hermes-prefix storage would lose this fact (the
      // slice(0, 400) cuts before the match); capture-group storage
      // retains it.
      const filler = "x ".repeat(250); // 500 chars of "x x x ..." with trailing space
      const input = `${filler}I prefer Helix over vim because reasons.`;
      expect(filler.length).toBeGreaterThan(400); // sanity: trigger is past pos 400
      const facts = extractFactsFromText(input);
      expect(facts).toHaveLength(1);
      expect(facts[0]?.content.startsWith("I prefer Helix")).toBe(true);
      expect(facts[0]?.content.length).toBeLessThanOrEqual(400);
    });

    it("truncates a very long matched phrase to 400 chars", () => {
      const longTail = "y".repeat(500);
      const input = `I prefer ${longTail}`;
      const facts = extractFactsFromText(input);
      expect(facts).toHaveLength(1);
      expect(facts[0]?.content.length).toBe(400);
    });
  });

  describe("first-match-wins per category (T2)", () => {
    it("yields exactly one user_pref fact when two user_pref patterns match", () => {
      // "I prefer A" matches pattern 1; "I always B" matches pattern 3.
      const facts = extractFactsFromText("I prefer A. I always B.");
      const userPrefs = facts.filter((f) => f.category === "user_pref");
      expect(userPrefs).toHaveLength(1);
      // First pattern wins, so "I prefer A" is what we capture.
      expect(userPrefs[0]?.content.startsWith("I prefer")).toBe(true);
    });

    it("yields exactly one project fact when two project patterns match", () => {
      const facts = extractFactsFromText("we decided to ship. the project uses Postgres.");
      const projectFacts = facts.filter((f) => f.category === "project");
      expect(projectFacts).toHaveLength(1);
      expect(projectFacts[0]?.content.startsWith("we decided")).toBe(true);
    });
  });

  describe("multi-category", () => {
    it("yields up to 2 facts (one user_pref + one project) when both pattern families hit", () => {
      const facts = extractFactsFromText("I prefer SQLite. we decided to use Postgres.");
      expect(facts).toHaveLength(2);
      const cats = facts.map((f) => f.category).sort();
      expect(cats).toEqual(["project", "user_pref"]);
    });

    it("never produces more than 2 facts even with many matches", () => {
      const facts = extractFactsFromText(
        "I prefer A. I like B. I use C. we decided X. the project uses Y."
      );
      expect(facts.length).toBeLessThanOrEqual(2);
    });
  });
});
