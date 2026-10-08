// Runs the native harness with process hygiene (LFCP-02-096):
// - it refuses to start while an Obsidian from the harness cache runs (one
//   instance at a time);
// - after WebdriverIO exits, no process from the harness cache may remain:
//   leftovers are listed, terminated and fail the run.
// Only processes whose command line contains the harness cache directory
// are ever looked at, so an Obsidian the user runs is never touched.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDir } from "./wdio.conf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

// The cache as written and as resolved (macOS reports /private/var for /var).
const cachePaths = [cacheDir, existsSync(cacheDir) ? realpathSync(cacheDir) : cacheDir];

/** [pid, command line] of every process started from the harness cache. */
function harnessProcesses() {
  const rows =
    process.platform === "win32"
      ? execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
          ],
          { encoding: "utf8" },
        )
      : execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return rows
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter(
      (m) =>
        m !== null && cachePaths.some((p) => m[2].includes(p)) && Number(m[1]) !== process.pid,
    )
    .map((m) => [Number(m[1]), m[2]]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function terminate(procs) {
  for (const [pid] of procs) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await sleep(3000);
  for (const [pid] of harnessProcesses()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

if (!existsSync(path.join(root, "main.js"))) {
  console.error("native: build the plugin first (pnpm build); main.js is missing.");
  process.exit(2);
}
const before = harnessProcesses();
if (before.length > 0) {
  console.error(`native: an Obsidian from ${cacheDir} is already running; stop it first:`);
  for (const [pid, cmd] of before) console.error(`  ${pid} ${cmd.slice(0, 160)}`);
  process.exit(2);
}

const wdio = spawn(
  process.execPath,
  [
    path.join(here, "node_modules/@wdio/cli/bin/wdio.js"),
    "run",
    path.join(here, "wdio.conf.mjs"),
    // `pnpm test -- --spec …` passes the "--" on; WebdriverIO would ignore what follows it.
    ...process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--")),
  ],
  { stdio: "inherit", cwd: here },
);
const code = await new Promise((resolve) => wdio.on("exit", (c) => resolve(c ?? 1)));

// Obsidian's helpers may take a moment to exit after the session ends.
let left = harnessProcesses();
for (let i = 0; i < 10 && left.length > 0; i++) {
  await sleep(500);
  left = harnessProcesses();
}
if (left.length > 0) {
  console.error(`native: ${left.length} process(es) from the harness outlived the run:`);
  for (const [pid, cmd] of left) console.error(`  ${pid} ${cmd.slice(0, 160)}`);
  await terminate(left);
  process.exit(code === 0 ? 1 : code);
}
console.log("native: no harness process left.");
process.exit(code);
