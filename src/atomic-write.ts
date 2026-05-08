import fs from "node:fs/promises";
import path from "node:path";

// Atomic file write via tmp + rename. Used by both the recall cache (best-effort
// callers wrap in try/catch) and the setup script (let-it-throw callers). The
// helper itself just throws — callers decide their failure semantics.
//
// Why not fs.writeFile + fsync directly: a partial write followed by a crash
// could leave a half-written file at the target path. tmp + rename ensures
// readers either see the previous full version or the new full version, never
// a torn intermediate.
export async function atomicWrite(target: string, contents: string, mode: number = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}`;
  await fs.writeFile(tmp, contents, { mode });
  await fs.rename(tmp, target);
}
