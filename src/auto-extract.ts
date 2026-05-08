// Auto-extract regex pass for `agent.run.finished` (#11).
//
// Hermes-parity heuristic extractor: 5 regex patterns split across two
// categories (user_pref, project), first-match-per-category-wins, length
// floor of 10 chars, stored content truncated to 400 chars. The host
// (handleRunFinished in worker.ts) drives this — it owns the source
// filter (author + time window) and the addFact call.
//
// Pipeline (mirrors the diagram in the plan file):
//
//   text ──► length >= 10? ──► run 5 patterns ──► first hit per category
//                                                       │
//                                                       ▼
//                                        { content: match[0].slice(0, 400),
//                                          category: "user_pref" | "project" }
//
// Diverges from Hermes (decision D15): stored content is the regex
// capture (`match[0]`), not the source-text prefix. Cleaner DB rows;
// dedup precision rises because two long comments with the same first
// 400 chars no longer collide on a single fact.

export type ExtractedCategory = "user_pref" | "project";

export interface ExtractedFact {
  content: string;
  category: ExtractedCategory;
}

interface CategoryPattern {
  category: ExtractedCategory;
  patterns: RegExp[];
}

// Patterns ported verbatim from Hermes' `_auto_extract_facts`. Keep
// locked to parity — adding patterns is a separate quality review.
const CATEGORY_PATTERNS: CategoryPattern[] = [
  {
    category: "user_pref",
    patterns: [
      /\bI\s+(?:prefer|like|love|use|want|need)\s+(.+)/i,
      /\bmy\s+(?:favorite|preferred|default)\s+\w+\s+is\s+(.+)/i,
      /\bI\s+(?:always|never|usually)\s+(.+)/i
    ]
  },
  {
    category: "project",
    patterns: [
      /\bwe\s+(?:decided|agreed|chose)\s+(?:to\s+)?(.+)/i,
      /\bthe\s+project\s+(?:uses|needs|requires)\s+(.+)/i
    ]
  }
];

const MIN_LENGTH = 10;
const MAX_CONTENT_LENGTH = 400;

export function extractFactsFromText(text: string): ExtractedFact[] {
  if (typeof text !== "string" || text.length < MIN_LENGTH) {
    return [];
  }

  const facts: ExtractedFact[] = [];

  for (const { category, patterns } of CATEGORY_PATTERNS) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) {
        facts.push({
          content: match[0].slice(0, MAX_CONTENT_LENGTH),
          category
        });
        break;
      }
    }
  }

  return facts;
}
