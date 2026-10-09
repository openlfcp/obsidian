#!/usr/bin/env node
// LFCP-068: the per-platform result artifact of the automated smoke run.
//
//   node scripts/smoke-report.mjs <vitest-json> <out.md>
//
// From Vitest's JSON report it writes a short Markdown record: the
// platform, the runtime versions, the plugin, SDK, spec and server builds,
// and PASS/FAIL per test file with the names of failing tests. Failure
// text is cut to its first line and never includes note content: the tests
// use synthetic notes, and no assertion prints a secret (LFCP-065).
// Environment: LFCP_SERVER_COMMIT, LFCP_SDK_TS_COMMIT (optional).
//
// Without the Vitest report the tests did not run: an earlier step failed.
// The record then says so and this step passes, so the failing step stays
// the first red one in the job.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release, type } from "node:os";
import { relative, resolve } from "node:path";

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  process.stderr.write("usage: smoke-report.mjs <vitest-json> <out.md>\n");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "..");
const report = existsSync(input) ? JSON.parse(readFileSync(input, "utf8")) : null;
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const spec = JSON.parse(readFileSync(resolve(root, "spec.lock"), "utf8"));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
// The SDK: a development pin (sdk-ts.lock, link: dependencies) or the npm packages.
const sdkLock = resolve(root, "sdk-ts.lock");
const sdk = existsSync(sdkLock)
  ? `sdk-ts: ${process.env.LFCP_SDK_TS_COMMIT ?? JSON.parse(readFileSync(sdkLock, "utf8")).commit}`
  : `sdk-ts (npm): ${Object.entries(pkg.dependencies)
      .filter(([name]) => name.startsWith("@openlfcp/"))
      .map(([name, version]) => `${name}@${version}`)
      .join(", ")}`;

const firstLine = (s) =>
  String(s ?? "")
    .split("\n")[0]
    .slice(0, 200);
const rows = [];
const failures = [];
for (const file of report?.testResults ?? []) {
  const name = relative(root, file.name).split("\\").join("/");
  const tests = file.assertionResults ?? [];
  const failed = tests.filter((t) => t.status === "failed");
  const skipped = tests.filter((t) => t.status === "skipped" || t.status === "pending");
  rows.push(
    `| ${name} | ${failed.length > 0 || file.status === "failed" ? "FAIL" : "PASS"} | ${tests.length - failed.length - skipped.length}/${tests.length}${skipped.length > 0 ? ` (${skipped.length} skipped)` : ""} |`,
  );
  for (const t of failed)
    failures.push(`- ${name}: ${t.fullName} — ${firstLine(t.failureMessages?.[0])}`);
  if (file.status === "failed" && failed.length === 0)
    failures.push(`- ${name}: ${firstLine(file.message)}`);
}
const ok = report?.success === true && failures.length === 0;
const lines = [
  `# Platform smoke (automated): ${report === null ? "NOT RUN" : ok ? "PASS" : "FAIL"}`,
  "",
  `- Platform: ${type()} ${release()} (${platform()}/${arch()})`,
  `- Node: ${process.version}`,
  `- Plugin: ${manifest.id} ${manifest.version} (minAppVersion ${manifest.minAppVersion})`,
  `- ${sdk}`,
  `- Spec: ${spec.tag} (${spec.commit})`,
  `- Server: ${process.env.LFCP_SERVER_COMMIT ?? "(not recorded)"}`,
  report === null
    ? "- Tests: not run (no Vitest report: an earlier step failed; see the job's first failed step)"
    : `- Tests: ${report.numPassedTests}/${report.numTotalTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests ?? 0} skipped`,
  "",
  "The desktop Obsidian part (install, storage, WebSocket, two-vault sync, restart) is the manual checklist in docs/devel/testing/platform-smoke.md; this record does not cover it.",
  "",
  "| Test file | Result | Passed |",
  "| --- | --- | --- |",
  ...rows,
  "",
  ...(failures.length === 0 ? ["No failures."] : ["## Failures", "", ...failures]),
  "",
];
writeFileSync(output, lines.join("\n"));
process.stdout.write(`${lines[0]}\n`);
process.exitCode = ok || report === null ? 0 : 1;
