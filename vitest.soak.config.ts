// The soak's peers (test/soak), run only by its controller:
// node test/soak/soak.mjs. The ordinary test run does not include them.

import { configDefaults, defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/soak/**/*.soak.test.ts"],
    exclude: [...configDefaults.exclude],
  },
});
