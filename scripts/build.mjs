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
//
// Size (0.3.1): the bundle is minified, and the wasm is stored deflated
// (scripts/build-plugins.mjs), so main.js stays well under the 5 MB that
// Obsidian Sync Standard syncs. License comments are kept at the end.

import { appendFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { automergeSlim, automergeWasmDeflated, thirdPartyLicenses } from "./build-plugins.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// `--outfile <path>` builds elsewhere (tests inspect a bundle without touching main.js).
const at = process.argv.indexOf("--outfile");
const outfile = at >= 0 ? process.argv[at + 1] : "main.js";
// `--metafile <path>` also writes esbuild's metafile (the bundle test reads its inputs).
const meta = process.argv.indexOf("--metafile");

const result = await build({
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
  minify: true,
  legalComments: "eof",
  metafile: true,
  plugins: [automergeSlim, automergeWasmDeflated],
});
appendFileSync(resolve(root, outfile), thirdPartyLicenses(root, result.metafile));
if (meta >= 0)
  writeFileSync(resolve(root, process.argv[meta + 1]), JSON.stringify(result.metafile));
