// The openlfcp reference server for live tests (LFCP-065), as a prebuilt
// binary; this helper never builds. Where it looks, in order:
// $LFCP_SERVER_BIN; the shared live-test target directory
// ($LFCP_SERVER_TARGET_DIR, default <tmp>/openlfcp-sdk-ts-server-target,
// the one sdk-ts and the LFCP-066 harness build into); then
// ../server/target. Started on a free loopback port with its own state
// directory. Without a binary the live tests are skipped, unless
// LFCP_REQUIRE_LIVE=1, which makes that an error.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXE = process.platform === "win32" ? "lfcp-server.exe" : "lfcp-server";
const CANDIDATES = [
  process.env.LFCP_SERVER_BIN,
  join(
    process.env.LFCP_SERVER_TARGET_DIR ?? join(tmpdir(), "openlfcp-sdk-ts-server-target"),
    "debug",
    EXE,
  ),
  resolve(import.meta.dirname, "../../../server/target/debug", EXE),
].filter((p): p is string => p !== undefined);
const BIN = CANDIDATES.find((p) => existsSync(p)) ?? (CANDIDATES[0] as string);

export interface LiveServer {
  readonly url: string;
  stop(): Promise<void>;
}

/** Why live tests cannot run here, or null when they can. */
export function liveSkipReason(): string | null {
  if (existsSync(BIN)) return null;
  const why = `no server binary in ${CANDIDATES.join(", ")} (build ../server into the shared target, or set LFCP_SERVER_BIN)`;
  if (process.env.LFCP_REQUIRE_LIVE === "1")
    throw new Error(`LFCP_REQUIRE_LIVE=1 but the live tests would skip: ${why}`);
  return why;
}

const freePort = (): Promise<number> =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      s.close(() => ok(port));
    });
  });

export async function startLiveServer(): Promise<LiveServer> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "lfcp-obsidian-live-"));
  const url = `ws://127.0.0.1:${port}/v1/ws`;
  writeFileSync(
    join(dir, "server.toml"),
    [
      `bind = "127.0.0.1:${port}"`,
      `state_dir = ${JSON.stringify(join(dir, "state"))}`,
      `public_urls = [${JSON.stringify(url)}]`,
      "heartbeat_ms = 5000",
      "",
    ].join("\n"),
  );
  let log = "";
  const child: ChildProcess = spawn(BIN, ["--config", join(dir, "server.toml")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => {
    log += String(d);
  });
  child.stderr?.on("data", (d) => {
    log += String(d);
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`the server did not become healthy:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        await exited;
      }
      // Windows may hold the database files for a moment after the process exits.
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
