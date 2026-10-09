// LFCP-068: the platform smoke result record (scripts/smoke-report.mjs).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/smoke-report.mjs", import.meta.url));
const dirs: string[] = [];
const run = (report: object | null) => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-report-"));
  dirs.push(dir);
  const input = join(dir, "vitest.json");
  if (report !== null) writeFileSync(input, JSON.stringify(report));
  const out = join(dir, "record.md");
  const r = spawnSync(process.execPath, [script, input, out], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, record: readFileSync(out, "utf8") };
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("smoke-report", () => {
  it("without a Vitest report, records NOT RUN and passes: the earlier failed step stays the cause", () => {
    const r = run(null);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.record).toMatch(/^# Platform smoke \(automated\): NOT RUN/);
    expect(r.record).toContain("an earlier step failed");
  });

  it("fails on a failing report and passes on a passing one", () => {
    const base = { numPassedTests: 1, numTotalTests: 1, numFailedTests: 0, testResults: [] };
    expect(run({ ...base, success: true }).status).toBe(0);
    const failed = run({ ...base, success: false, numFailedTests: 1 });
    expect(failed.status).toBe(1);
    expect(failed.record).toMatch(/: FAIL/);
  });
});
