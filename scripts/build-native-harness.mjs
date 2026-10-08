#!/usr/bin/env node

// Bundles the native harness's section-sync plugin (test only, never
// shipped): test/native/section-sync/main.ts, with the section engine, the
// editor extension and the fake SDK port, into
// test/native/plugins/section-sync/main.js (gitignored). Same externals and
// Automerge handling as the plugin (scripts/build.mjs).

import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { automergeSlim, automergeWasmDeflated } from "./build-plugins.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: root,
  entryPoints: ["test/native/section-sync/main.ts"],
  outfile: "test/native/plugins/section-sync/main.js",
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
  logLevel: "warning",
  sourcemap: false,
  minify: false,
  plugins: [automergeSlim, automergeWasmDeflated],
});
