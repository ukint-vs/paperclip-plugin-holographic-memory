import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

// Atomic file write via tmp + rename. Used by both the recall cache (best-effort
// callers wrap in try/catch) and the setup script (let-it-throw callers). The
// helper itself just throws — callers decide their failure semantics.
//
// Why not fs.writeFile + fsync directly: a partial write followed by a crash
// could leave a half-written file at the target path. tmp + rename ensures
// readers either see the previous full version or the new full version, never
// a torn intermediate.
//
// Why pid + random suffix: an earlier version used only `.tmp.${pid}` which
// collides when two concurrent writes target the same path from one process
// (e.g. recall-cache.ts uses Promise.all across scopes; back-to-back
// agent.run.started events for the same issue/agent). The collision could
// publish wrong payload via rename or fail with ENOENT mid-flight. The random
// suffix makes the tmp name unique per call. The try/finally unlinks the tmp
// on any failure so we don't leak partial files into the directory the gc
// sweeper operates on.
export async function atomicWrite(target: string, contents: string, mode: number = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const suffix = randomBytes(6).toString("hex");
  const tmp = `${target}.tmp.${process.pid}.${suffix}`;
  try {
    await fs.writeFile(tmp, contents, { mode });
    await fs.rename(tmp, target);
  } catch (error) {
    // Best-effort cleanup. If unlink also fails (e.g. tmp never created), we
    // swallow it and let the original error propagate.
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}
