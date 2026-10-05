#!/usr/bin/env node
// Bundles src/main.ts into main.js, the file Obsidian loads, next to
// manifest.json. `obsidian`, Electron, CodeMirror, Lezer and Node built-ins
// are provided by the Obsidian app and stay external.

import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
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
});
