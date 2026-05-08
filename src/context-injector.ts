import type { MemoryFact } from "./types.js";

export function formatFactsForPrompt(facts: MemoryFact[]): string {
  if (!facts.length) {
    return "";
  }

  const lines = facts.map((fact, index) => {
    const tags = fact.tags ? ` tags=${fact.tags}` : "";
    const score = typeof fact.score === "number" ? ` score=${fact.score.toFixed(3)}` : "";
    return `${index + 1}. [id=${fact.factId}; ${fact.category}; trust=${fact.trustScore.toFixed(2)}${score}${tags}] ${fact.content}`;
  });

  return ["MEMORY CONTEXT:", ...lines].join("\n");
}

export function formatFactsAsText(facts: MemoryFact[]): string {
  if (!facts.length) {
    return "No holographic memory facts matched the query.";
  }

  return formatFactsForPrompt(facts);
}
