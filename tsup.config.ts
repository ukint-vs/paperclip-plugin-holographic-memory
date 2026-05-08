import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/worker.ts", "src/manifest.ts", "src/ui/index.tsx"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["@paperclipai/plugin-sdk", "better-sqlite3"]
});
