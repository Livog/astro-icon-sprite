import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/integration.ts", "src/plugin.ts", "src/types.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  outDir: "dist",
});
