import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isInvokedAsScript } from "../src/invoked-as-script.js";

// realpathSync requires real filesystem entries to resolve, so this spec
// creates a temp directory with the actual file shape: a real script file
// plus a symlink that mimics the npm-bin layout.
let tmpRoot: string;
let realScript: string;
let symlinkBin: string;
let unrelatedFile: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "isaspc-"));
  realScript = join(tmpRoot, "setup-mcp.js");
  writeFileSync(realScript, "// stub script");
  symlinkBin = join(tmpRoot, "paperclip-holographic-memory-setup");
  symlinkSync(realScript, symlinkBin);
  unrelatedFile = join(tmpRoot, "unrelated.js");
  writeFileSync(unrelatedFile, "// other module");
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("isInvokedAsScript", () => {
  it("returns true when argv[1] is the same path as the resolved file", () => {
    // Direct invocation: `node /path/to/setup-mcp.js` or `tsx scripts/setup-mcp.ts`.
    expect(isInvokedAsScript(`file://${realScript}`, realScript)).toBe(true);
  });

  // Regression test for the 0.4.0 bug: npm bin invocation. npm symlinks
  // /usr/local/bin/<bin-name> → dist/setup-mcp.js. argv[1] is the symlink
  // path (basename = bin name, e.g. paperclip-holographic-memory-setup);
  // import.meta.url resolves to the real path (basename = setup-mcp.js).
  // Pre-fix code regex'd argv[1] against /setup-mcp\.(ts|js)$/ and returned
  // false, silently no-op'ing for every npm-bin user.
  it("returns true when argv[1] is a symlink with a different basename pointing at the file", () => {
    expect(isInvokedAsScript(`file://${realScript}`, symlinkBin)).toBe(true);
  });

  it("returns false when argv[1] is an unrelated file (test runner / different entry point)", () => {
    // Test runner case: argv[1] is the vitest binary, import.meta.url is the
    // imported module. realpath of vitest != module's real path → no match.
    expect(isInvokedAsScript(`file://${realScript}`, unrelatedFile)).toBe(false);
  });

  it("returns false when argv[1] is undefined", () => {
    expect(isInvokedAsScript(`file://${realScript}`, undefined)).toBe(false);
  });

  it("returns false when argv[1] points at a non-existent path", () => {
    // realpathSync throws ENOENT for missing paths; helper catches and
    // defaults to false rather than crashing.
    expect(
      isInvokedAsScript(`file://${realScript}`, join(tmpRoot, "does-not-exist")),
    ).toBe(false);
  });

  it("returns false when import.meta.url is malformed", () => {
    // fileURLToPath throws for non-file URLs; helper catches and returns false.
    expect(isInvokedAsScript("not-a-valid-url", realScript)).toBe(false);
  });
});
