import { definePlugin } from "@paperclipai/plugin-sdk";
import { formatFactsAsText, formatFactsForPrompt } from "./context-injector.js";
import { resolvePluginConfig } from "./config.js";
import { MemoryStore } from "./memory-store.js";
import type { HolographicMemoryConfig, RecallState } from "./types.js";

interface AgentRunStartedEvent {
  issueId?: string;
  agentId?: string;
  runId?: string;
}

export default definePlugin({
  async setup(ctx: any) {
    const config = resolvePluginConfig(readConfig(ctx));

    registerSettings(ctx, config);
    registerSearchTool(ctx, config);

    ctx.events?.on?.("agent.run.started", async (event: AgentRunStartedEvent) => {
      await handleRunStarted(ctx, event, config);
    });
  }
});

export async function handleRunStarted(
  ctx: any,
  event: AgentRunStartedEvent,
  config: HolographicMemoryConfig
): Promise<RecallState | undefined> {
  if (!config.recallEnabled || !event.issueId) {
    return undefined;
  }

  const issue = await ctx.issues?.get?.(event.issueId);
  const query = [issue?.title, issue?.description, issue?.body]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");

  if (!query.trim()) {
    return undefined;
  }

  const store = new MemoryStore(config.dbPath);

  try {
    const facts = store.search(query, {
      limit: config.maxFactsPerRecall,
      minTrust: config.minTrustScore
    });

    if (!facts.length) {
      return undefined;
    }

    const state: RecallState = {
      query,
      facts,
      formatted: formatFactsForPrompt(facts),
      createdAt: new Date().toISOString()
    };

    if (event.issueId) {
      state.issueId = event.issueId;
    }

    if (event.runId) {
      state.runId = event.runId;
    }

    await writeRecallState(ctx, event, state);
    return state;
  } finally {
    store.close();
  }
}

function registerSearchTool(ctx: any, config: HolographicMemoryConfig): void {
  const args = ["holographic_memory_search", {
    displayName: "Search Holographic Memory",
    description: "Search and maintain the isolated Paperclip holographic memory store.",
    parametersSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "probe", "related", "reason", "list", "feedback"],
          default: "search"
        },
        query: { type: "string" },
        entity: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        category: { type: "string" },
        fact_id: { type: "number" },
        helpful: { type: "boolean" },
        limit: { type: "number", default: 5, minimum: 1, maximum: 50 },
        min_trust: { type: "number", default: config.minTrustScore, minimum: 0, maximum: 1 }
      },
      required: []
    }
  }, async (params: {
    action?: "search" | "probe" | "related" | "reason" | "list" | "feedback";
    query?: string;
    entity?: string;
    entities?: string[];
    category?: string;
    fact_id?: number;
    helpful?: boolean;
    limit?: number;
    min_trust?: number;
  }) => {
    if (!config.recallEnabled) {
      return { content: "Holographic memory recall is disabled." };
    }

    const store = new MemoryStore(config.dbPath);

    try {
      const action = params.action ?? "search";
      const minTrust = params.min_trust ?? config.minTrustScore;
      const limit = params.limit ?? 5;

      if (action === "search") {
        if (typeof params.query !== "string" || !params.query.trim()) {
          return { content: "Missing required parameter: query" };
        }

        return { content: formatFactsAsText(store.search(params.query, { limit, minTrust })) };
      }

      if (action === "probe") {
        if (typeof params.entity !== "string" || !params.entity.trim()) {
          return { content: "Missing required parameter: entity" };
        }

        return { content: formatFactsAsText(store.probe(params.entity, { limit, minTrust })) };
      }

      if (action === "related") {
        if (typeof params.entity !== "string" || !params.entity.trim()) {
          return { content: "Missing required parameter: entity" };
        }

        return { content: formatFactsAsText(store.related(params.entity, { limit, minTrust })) };
      }

      if (action === "reason") {
        if (!Array.isArray(params.entities) || !params.entities.length) {
          return { content: "Missing required parameter: entities" };
        }

        return { content: formatFactsAsText(store.reason(params.entities, { limit, minTrust })) };
      }

      if (action === "list") {
        const options: { limit: number; minTrust: number; category?: string } = { limit, minTrust };

        if (params.category) {
          options.category = params.category;
        }

        return {
          content: formatFactsAsText(store.listFacts(options))
        };
      }

      if (action === "feedback") {
        if (typeof params.fact_id !== "number" || typeof params.helpful !== "boolean") {
          return { content: "Missing required parameters: fact_id and helpful" };
        }

        return { content: JSON.stringify(store.recordFeedback(params.fact_id, params.helpful)) };
      }

      return { content: `Unknown memory action: ${action}` };
    } finally {
      store.close();
    }
  }] as const;

  if (ctx.tools?.register) {
    ctx.tools.register(...args);
  } else if (ctx.agent?.tools?.register) {
    ctx.agent.tools.register(...args);
  }
}

function registerSettings(ctx: any, config: HolographicMemoryConfig): void {
  ctx.settings?.register?.({
    title: "Holographic Memory",
    fields: [
      { key: "dbPath", type: "string", label: "Memory database path", default: config.dbPath },
      { key: "recallEnabled", type: "boolean", label: "Enable recall", default: config.recallEnabled },
      { key: "minTrustScore", type: "number", label: "Minimum trust score", default: config.minTrustScore },
      {
        key: "maxFactsPerRecall",
        type: "number",
        label: "Maximum facts per recall",
        default: config.maxFactsPerRecall
      }
    ]
  });
}

async function writeRecallState(
  ctx: any,
  event: AgentRunStartedEvent,
  state: RecallState
): Promise<void> {
  const key = `recall:${event.runId ?? event.agentId ?? event.issueId}`;

  if (ctx.state?.set) {
    await ctx.state.set(key, state);
  } else if (ctx.plugin?.state?.set) {
    await ctx.plugin.state.set(key, state);
  }
}

function readConfig(ctx: any): Partial<HolographicMemoryConfig> {
  return (ctx.config ?? ctx.settings?.values ?? {}) as Partial<HolographicMemoryConfig>;
}
