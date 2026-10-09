// The headless performance runs (LFCP-02-067/068), on purpose only:
// LFCP_PERF=1 pnpm perf. The ordinary test run excludes test/perf.

import { configDefaults, defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/perf/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
  },
});
