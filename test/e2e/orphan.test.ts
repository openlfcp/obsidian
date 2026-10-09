// No server outlives its test process. A test process that is SIGKILLed
// runs no afterAll and no exit handler; the watchdog started with each
// server (test/support/reaper.mjs) must still kill the server and remove
// its directory. Checked for each of the three server harnesses.
//
// Skipped (with the reason) without a server binary, and on Windows, which
// has no watchdog.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverBinary } from "../support/e2e-server";

const PARENT = fileURLToPath(new URL("../support/orphan-parent.mjs", import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

const built = process.platform === "win32" ? { skip: "no watchdog on Windows" } : serverBinary();

describe.each(["e2e", "live", "security"])("the %s server harness (live)", (kind) => {
  it("kills the server when the test process is SIGKILLed", async (ctx) => {
    if ("skip" in built) {
      console.warn(`SKIPPED: orphan check (${built.skip})`);
      ctx.skip();
      return;
    }
    const parent = spawn(process.execPath, ["--no-warnings", PARENT, kind, built.bin], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LFCP_SERVER_BIN: built.bin },
    });
    let err = "";
    parent.stderr.on("data", (d) => {
      err += String(d);
    });
    const exited = new Promise((r) => parent.once("exit", r));
    const started = await new Promise<{ pid: number; dir: string }>((ok, fail) => {
      let out = "";
      parent.stdout.on("data", (d) => {
        out += String(d);
        const nl = out.indexOf("\n");
        if (nl >= 0) ok(JSON.parse(out.slice(0, nl)));
      });
      parent.once("exit", (code) => fail(new Error(`the parent exited (${code}): ${err}`)));
    });
    expect(alive(started.pid)).toBe(true);
    parent.kill("SIGKILL");
    await exited;
    const killed = Date.now();
    while ((alive(started.pid) || existsSync(started.dir)) && Date.now() - killed < 5000)
      await new Promise((r) => setTimeout(r, 50));
    expect({ serverAlive: alive(started.pid), dirExists: existsSync(started.dir) }).toEqual({
      serverAlive: false,
      dirExists: false,
    });
  }, 600_000);
});
