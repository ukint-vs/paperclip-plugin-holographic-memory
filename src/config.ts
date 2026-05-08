import { homedir } from "node:os";
import path from "node:path";
import type { HolographicMemoryConfig } from "./types.js";

export const DEFAULT_DB_PATH = "~/.paperclip/instances/default/hermes-memory.db";

const DEFAULT_CONFIG: HolographicMemoryConfig = {
  dbPath: DEFAULT_DB_PATH,
  recallEnabled: true,
  retainEnabled: false,
  minTrustScore: 0.3,
  maxFactsPerRecall: 10
};

export function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(homedir(), input.slice(2));
  }

  return input;
}

export function resolvePluginConfig(
  rawConfig: Partial<HolographicMemoryConfig> | undefined = {}
): HolographicMemoryConfig {
  const dbPath = rawConfig.dbPath ?? DEFAULT_CONFIG.dbPath;

  return {
    dbPath: expandHome(dbPath),
    recallEnabled: rawConfig.recallEnabled ?? DEFAULT_CONFIG.recallEnabled,
    retainEnabled: rawConfig.retainEnabled ?? DEFAULT_CONFIG.retainEnabled,
    minTrustScore: normalizeNumber(rawConfig.minTrustScore, DEFAULT_CONFIG.minTrustScore, 0, 1),
    maxFactsPerRecall: Math.floor(
      normalizeNumber(rawConfig.maxFactsPerRecall, DEFAULT_CONFIG.maxFactsPerRecall, 1, 50)
    )
  };
}

function normalizeNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}
