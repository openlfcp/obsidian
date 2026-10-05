#!/usr/bin/env node
// Bundles src/main.ts into main.js, the file Obsidian loads, next to
// manifest.json. `obsidian`, Electron, CodeMirror, Lezer and Node built-ins
// are provided by the Obsidian app and stay external.
//
// Automerge (LFCP-059): the SDK imports `@automerge/automerge`, whose
// browser build imports a .wasm module esbuild cannot load and whose base64
// build compiles 3.5 MB of wasm synchronously on import, which Chromium
// refuses on a renderer's main thread above 4 KB. The plugin uses the
// `/slim` build instead: exactly `@automerge/automerge` resolves to
// `@automerge/automerge/slim` (from the importing file, so the SDK's own
// copy), and the runtime awaits the SDK's initializeAutomerge(), which
// imports the base64 wasm and compiles it asynchronously. src/ itself never
// imports Automerge (scripts/check-boundaries.mjs).

import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// `--outfile <path>` builds elsewhere (tests inspect a bundle without touching main.js).
const at = process.argv.indexOf("--outfile");
const outfile = at >= 0 ? process.argv[at + 1] : "main.js";

/** Exactly `@automerge/automerge` -> its `/slim` entry; subpaths are untouched. */
const automergeSlim = {
  name: "automerge-slim",
  setup(b) {
    b.onResolve({ filter: /^@automerge\/automerge$/ }, (args) =>
      b.resolve("@automerge/automerge/slim", {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
      }),
    );
  },
};

await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  logLevel: "info",
  sourcemap: false,
  treeShaking: true,
  legalComments: "inline",
  plugins: [automergeSlim],
});
