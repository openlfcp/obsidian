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

// LFCP-02-066: the native acceptance runs' peer and server, for the specs'
// Node process (test/native/peer/main.ts into test/native/peer.bundle.mjs).
await build({
  absWorkingDir: root,
  entryPoints: ["test/native/peer/main.ts"],
  outfile: "test/native/peer.bundle.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  banner: {
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
  logLevel: "warning",
  sourcemap: false,
  minify: false,
  plugins: [automergeSlim, automergeWasmDeflated],
});

// LFCP-03-025: the UX fixture states' sections host, for the renderer of the
// real Obsidian (test/native/fixture-host/main.ts into
// test/native/fixture-host.bundle.js; specs/pane-fixture-states evaluates it).
await build({
  absWorkingDir: root,
  entryPoints: ["test/native/fixture-host/main.ts"],
  outfile: "test/native/fixture-host.bundle.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  logLevel: "warning",
  sourcemap: false,
  minify: false,
  plugins: [automergeSlim, automergeWasmDeflated],
});
