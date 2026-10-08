#!/usr/bin/env node

// LFCP-02-047: runs the spec's own verifier of MARKDOWN-SECTIONS-FIXTURES-01
// (generator/verify-markdown.mjs --adapter) on this plugin's product
// adapter (test/support/sections-fixtures.ts), so the corpus is checked by
// the spec's code, not only by ours (test/core/sections/fixtures.test.ts).
//
//   node scripts/run-sections-fixtures.mjs [spec-dir]
//
// The spec checkout is $LFCP_SPEC_DIR, the argument, or ../spec; it must be
// at spec.lock (test/support/spec.ts checks that for the tests) and have its
// own dependencies installed (markdown-it): pnpm install --frozen-lockfile.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = resolve(process.argv[2] ?? process.env.LFCP_SPEC_DIR ?? join(root, "..", "spec"));
const suite = join(spec, "test-vectors", "shared-sections-01");
const adapter = join(root, "node_modules", ".cache", "openlfcp", "sections-fixtures-adapter.mjs");

mkdirSync(dirname(adapter), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["test/support/sections-fixtures.ts"],
  outfile: adapter,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // The SDK and Automerge resolve from this repository's node_modules.
  packages: "external",
  logLevel: "warning",
});
if (!existsSync(join(spec, "node_modules", "markdown-it"))) {
  console.error(
    `run-sections-fixtures: install the spec's dependencies first (cd ${spec} && pnpm install --frozen-lockfile)`,
  );
  process.exit(2);
}
const r = spawnSync(
  process.execPath,
  [join(suite, "generator", "verify-markdown.mjs"), suite, "--adapter", adapter],
  { cwd: spec, stdio: "inherit" },
);
process.exit(r.status ?? 1);
