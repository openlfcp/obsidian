import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Unit tests run without Obsidian: the adapter layer gets a minimal mock.
    alias: { obsidian: fileURLToPath(new URL("./test/mocks/obsidian.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The performance runs are opt-in (pnpm perf, vitest.perf.config.ts): no skip in the ordinary run.
    exclude: [...configDefaults.exclude, "test/perf/**"],
    setupFiles: ["test/setup/window.ts"],
  },
});
