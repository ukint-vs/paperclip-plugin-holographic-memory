import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// E2E spawn-based smoke for the MCP server. Sends a real MCP initialize +
// tools/list + tools/call exchange over stdio against `dist/mcp-server.js`,
// the exact bin shipped via `npx paperclip-holographic-memory-mcp`. Skips
// when the build hasn't been run, so unit-test runs in fresh checkouts
// don't fail on missing dist.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_BIN = path.join(REPO_ROOT, "dist", "mcp-server.js");
const HAS_BUILD = existsSync(MCP_BIN);

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

class StdioClient {
  private buffer = "";
  private pending = new Map<number, (response: JsonRpcResponse) => void>();
  private nextId = 1;

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as JsonRpcResponse;
          if (message.id !== undefined && message.id !== null) {
            const handler = this.pending.get(message.id as number);
            if (handler) {
              this.pending.delete(message.id as number);
              handler(message);
            }
          }
        } catch {
          // Ignore non-JSON output (e.g. logs to stderr would have arrived
          // on a different stream anyway).
        }
      }
    });
  }

  async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 5000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.proc.stdin.write(payload + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.proc.stdin.write(payload + "\n");
  }
}

describe.skipIf(!HAS_BUILD)("mcp-smoke (spawn-based, requires dist/)", () => {
  let proc: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
    }
  });

  it("initialize -> tools/list -> tools/call round-trip", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "mcp-smoke-")), "memory.db");
    proc = spawn("node", [MCP_BIN], {
      env: {
        ...process.env,
        PAPERCLIP_HOLO_MEMORY_DB: dbPath,
        PAPERCLIP_HOLO_MEMORY_RECALL_ENABLED: "true",
        PAPERCLIP_HOLO_MEMORY_RETAIN_ENABLED: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new StdioClient(proc);

    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest-smoke", version: "0.0.0" },
    });
    expect(init.error).toBeUndefined();
    expect((init.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe("holographic-memory");

    client.notify("notifications/initialized");

    const list = await client.request("tools/list");
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toContain("holographic_memory_search");

    const callList = await client.request("tools/call", {
      name: "holographic_memory_search",
      arguments: { action: "list", limit: 3, min_trust: 0 },
    });
    const callResult = callList.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(callResult.isError).toBeFalsy();
    const parsed = JSON.parse(callResult.content[0]!.text);
    expect(parsed).toEqual({ facts: [], count: 0 });
  });

  it("recall_context with no IDs returns standalone marker", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "mcp-smoke-")), "memory.db");
    proc = spawn("node", [MCP_BIN], {
      env: { ...process.env, PAPERCLIP_HOLO_MEMORY_DB: dbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new StdioClient(proc);

    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest-smoke", version: "0.0.0" },
    });
    client.notify("notifications/initialized");

    const result = await client.request("tools/call", {
      name: "holographic_memory_search",
      arguments: { action: "recall_context" },
    });
    const text = (result.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toMatch(/Paperclip-only/);
  });
});
