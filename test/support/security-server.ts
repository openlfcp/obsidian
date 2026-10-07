// The reference server for the LFCP-071 security/privacy E2E: the same
// binary as the LFCP-066 helper (serverBinary), but restartable. restart()
// kills the process abruptly (SIGKILL: nothing is flushed or closed) and
// starts it again on the same port over the same state directory, so the
// clients' URLs stay valid and the test can check what survived. The log
// accumulates across restarts; stop() removes the state directory.

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardChild } from "./reaper.mjs";

export interface SecurityServer {
  readonly url: string;
  /** The running server's process ID (a new one after restart). */
  readonly pid: number;
  /** The server's temporary directory: its config and state. */
  readonly dir: string;
  /** Every byte the server stored, file by file (its state directory). */
  stored(): { readonly file: string; readonly bytes: Buffer }[];
  /** Everything the server wrote to stdout and stderr, across restarts. */
  log(): string;
  /** GET on the server's HTTP side (e.g. /health); the parsed JSON body and the status. */
  http(path: string): Promise<{ readonly status: number; readonly body: unknown }>;
  /** SIGKILL, then a new process on the same port and state directory. */
  restart(): Promise<void>;
  stop(): Promise<void>;
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

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

export async function startSecurityServer(bin: string): Promise<SecurityServer> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "lfcp-obsidian-security-"));
  const url = `ws://127.0.0.1:${port}/v1/ws`;
  const config = join(dir, "server.toml");
  writeFileSync(
    config,
    [
      `bind = "127.0.0.1:${port}"`,
      `state_dir = ${JSON.stringify(join(dir, "state"))}`,
      `public_urls = [${JSON.stringify(url)}]`,
      "heartbeat_ms = 5000",
      "",
    ].join("\n"),
  );
  let log = "";
  let child: ChildProcess;
  let release = (): void => {};

  const spawnServer = async (): Promise<void> => {
    child = spawn(bin, ["--config", config], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: "debug" },
    });
    // Killed, and `dir` removed, even if this test process dies first.
    release = guardChild(child, [dir]);
    child.stdout?.on("data", (d) => {
      log += String(d);
    });
    child.stderr?.on("data", (d) => {
      log += String(d);
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (child.exitCode !== null) {
        release();
        throw new Error(`the server exited:\n${log.slice(-4000)}`);
      }
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        release();
        child.kill("SIGKILL");
        throw new Error(`the server did not become healthy:\n${log.slice(-4000)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const kill = async (signal: NodeJS.Signals): Promise<void> => {
    release();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill(signal);
    await exited;
  };

  await spawnServer();
  return {
    url,
    get pid() {
      return child.pid as number;
    },
    dir,
    stored: () => files(join(dir, "state")).map((file) => ({ file, bytes: readFileSync(file) })),
    log: () => log,
    http: async (path) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: res.status, body };
    },
    restart: async () => {
      await kill("SIGKILL");
      await spawnServer();
    },
    stop: async () => {
      await kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
