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
    // The soak peer runs only under its controller (vitest.soak.config.ts).
    exclude: [...configDefaults.exclude, "test/perf/**", "test/soak/**"],
    setupFiles: ["test/setup/window.ts"],
  },
});
