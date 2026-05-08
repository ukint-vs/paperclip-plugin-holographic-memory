import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/worker.ts",
    "src/manifest.ts",
    "src/mcp-server.ts",
    "src/ui/index.tsx"
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["@paperclipai/plugin-sdk", "better-sqlite3"],
  // Preserve the shebang on dist/mcp-server.js so `npx paperclip-holographic-memory-mcp` works.
  // tsup keeps shebangs by default, but we set it explicitly so future config edits don't strip it.
  banner: ({ format }) => (format === "esm" ? {} : {})
});
