import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  // Test against core's source so `pnpm test` does not depend on a prior build.
  resolve: { alias: { "@ateam/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) } },
});
