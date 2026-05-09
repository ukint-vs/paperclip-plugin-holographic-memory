import { defineConfig } from "tsup";

export default defineConfig({
  // Object form: explicit logical-name → source-path mapping. Keeps `dist/`
  // flat (e.g. dist/worker.js, dist/setup-mcp.js) even with entry points in
  // both src/ and scripts/. Array form would re-base output paths under the
  // common parent and break the existing `paperclipPlugin.{manifest,worker}`
  // pointers + the `bin` paths in package.json.
  entry: {
    worker: "src/worker.ts",
    manifest: "src/manifest.ts",
    "mcp-server": "src/mcp-server.ts",
    "setup-mcp": "scripts/setup-mcp.ts",
    "ui/index": "src/ui/index.tsx",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  // Sourcemaps disabled for the published build: maps would reference src/
  // files that aren't packed into the npm tarball, leaving end-users with
  // dangling .map files. Re-enable locally for one-off debugging if needed.
  sourcemap: false,
  splitting: false,
  // External: don't bundle these — resolve them at consume time. SDK and
  // better-sqlite3 are runtime deps; react is an optional peer (host
  // provides it via the Settings UI rendering pipeline) and react/jsx-runtime
  // is the implicit transform target for src/ui/index.tsx's JSX.
  external: [
    "@paperclipai/plugin-sdk",
    "better-sqlite3",
    "react",
    "react/jsx-runtime",
  ],
});
