// The native harness (LFCP-02-096): the built plugin (the repository root's
// main.js, manifest.json and styles.css) in a real Obsidian, downloaded into
// a cache of its own and run with a throw-away configuration directory and
// a throw-away copy of a test vault. It never uses an installed Obsidian or
// its settings. Run it with `pnpm native` from the repository root; see
// docs/devel/testing/native-harness.md.

import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where Obsidian builds are downloaded (about 630 MB per version); safe to delete. */
export const cacheDir =
  process.env.OPENLFCP_OBSIDIAN_CACHE ?? path.join(os.tmpdir(), "openlfcp-obsidian-cache");

/**
 * The Obsidian versions (app = installer) the specs run on, one after the
 * other. 1.13.4 is the earliest public build at or above the manifest's
 * minAppVersion 1.13.1, which was an Insider-only beta; 1.14.4 is the
 * latest public one. NATIVE_OBSIDIAN=1.14.4 runs only that.
 */
const versions = (process.env.NATIVE_OBSIDIAN ?? "1.13.4,1.14.4")
  .split(",")
  .map((v) => v.trim())
  .filter((v) => v !== "");

export const config = {
  runner: "local",
  framework: "mocha",
  specs: [path.join(here, "specs/**/*.e2e.mjs")],
  // One Obsidian at a time (run.mjs also refuses to start next to another).
  maxInstances: 1,
  capabilities: versions.map((version) => ({
    browserName: "obsidian",
    browserVersion: version,
    "wdio:obsidianOptions": {
      installerVersion: version,
      plugins: [path.resolve(here, "../..")],
      vault: path.join(here, "vaults/basic"),
    },
  })),
  services: ["obsidian"],
  reporters: ["spec"],
  cacheDir,
  mochaOpts: { ui: "bdd", timeout: 120_000 },
  logLevel: "warn",
};
