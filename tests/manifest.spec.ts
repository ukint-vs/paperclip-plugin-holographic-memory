import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

describe("manifest", () => {
  // Regression guard: pre-0.4.0 the manifest hardcoded `version: "0.1.0"`
  // and stayed there across releases (0.1, 0.2, 0.3 all advertised 0.1.0
  // to Paperclip's plugin loader). Reading from package.json at runtime
  // means the host UI always shows the published artifact's version.
  it("manifest.version matches the package.json version exactly (no hardcoded drift)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });

  it("manifest.id matches the npm package name", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name: string };
    expect(manifest.id).toBe(pkg.name);
  });

  it("manifest.entrypoints.worker points at dist/worker.js (paperclipPlugin contract)", () => {
    // Paperclip's plugin loader reads paperclipPlugin.{manifest,worker} from
    // package.json AND the manifest's own entrypoints.worker. Both must point
    // at the same dist file or the loader gets confused. Pin the contract.
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
  });

  it("declares the holographic_memory_search tool", () => {
    expect(manifest.tools).toBeDefined();
    expect(manifest.tools?.some((t) => t.name === "holographic_memory_search")).toBe(true);
  });
});
