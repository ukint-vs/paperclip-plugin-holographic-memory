import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read version from this package's own package.json. Used by `src/manifest.ts`
// (advertised to Paperclip's plugin loader / Settings UI) and `src/mcp-server.ts`
// (advertised on every MCP initialize handshake). Reading at runtime keeps both
// in sync with the published artifact without manual bumps in two places.
//
// Resolves both in src/ (../package.json) and dist/ (sibling to dist/, also
// ../package.json), since the relative depth is the same in both layouts.
export function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    // Sandboxed contexts where package.json isn't readable — never expected
    // in any installed bin path. Falling back keeps the module importable
    // rather than throwing on import.
    return "0.0.0";
  }
}
