// The openlfcp reference server for the two-vault E2E (LFCP-066), as the
// sdk-ts live interop runs it: built with cargo from ../server (or
// $LFCP_SERVER_DIR) into the
// shared target directory ($TMPDIR/openlfcp-sdk-ts-server-target, or
// $LFCP_SERVER_TARGET_DIR), or $LFCP_SERVER_BIN when given. Without cargo
// or the checkout the E2E is skipped, unless LFCP_REQUIRE_LIVE=1, which
// makes that an error. Unlike the LFCP-065 helper, it exposes the server's
// state directory and log, so the E2E can inspect what the server stored.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
import { join, resolve } from "node:path";
import { requireExplicitServer } from "./live-server";
import { guardChild } from "./reaper.mjs";

const SERVER_DIR = resolve(
  process.env.LFCP_SERVER_DIR ?? resolve(import.meta.dirname, "../../../server"),
);
const TARGET =
  process.env.LFCP_SERVER_TARGET_DIR ?? join(tmpdir(), "openlfcp-sdk-ts-server-target");

/** The server binary (built if needed), or why the E2E cannot run. */
export function serverBinary(): { bin: string } | { skip: string } {
  // A gate names the server at server.lock; no build of whatever ../server holds.
  if (process.env.LFCP_REQUIRE_LIVE === "1") return { bin: requireExplicitServer() };
  const result = ((): { bin: string } | { skip: string } => {
    if (process.env.LFCP_SERVER_BIN !== undefined)
      return existsSync(process.env.LFCP_SERVER_BIN)
        ? { bin: process.env.LFCP_SERVER_BIN }
        : { skip: `no binary at $LFCP_SERVER_BIN (${process.env.LFCP_SERVER_BIN})` };
    if (!existsSync(join(SERVER_DIR, "Cargo.toml")))
      return { skip: `no server checkout at ${SERVER_DIR}` };
    try {
      execFileSync("cargo", ["--version"], { stdio: "ignore" });
    } catch {
      return { skip: "cargo is not installed (or not on PATH)" };
    }
    try {
      execFileSync(
        "cargo",
        ["build", "--quiet", "--manifest-path", join(SERVER_DIR, "Cargo.toml")],
        {
          stdio: "pipe",
          env: { ...process.env, CARGO_TARGET_DIR: TARGET },
        },
      );
    } catch (e) {
      return {
        skip: `cargo build failed: ${String((e as { stderr?: unknown }).stderr ?? e).slice(0, 400)}`,
      };
    }
    const bin = join(
      TARGET,
      "debug",
      process.platform === "win32" ? "lfcp-server.exe" : "lfcp-server",
    );
    return existsSync(bin) ? { bin } : { skip: `no binary at ${bin}` };
  })();
  if ("skip" in result) console.warn(`E2E skipped: ${result.skip}`);
  if ("skip" in result && process.env.LFCP_REQUIRE_LIVE === "1")
    throw new Error(`LFCP_REQUIRE_LIVE=1 but the E2E would skip: ${result.skip}`);
  return result;
}

export interface E2EServer {
  readonly url: string;
  /** The server's process ID. */
  readonly pid: number;
  /** The server's temporary directory: its config and state. */
  readonly dir: string;
  /** Every byte the server stored, file by file. */
  stored(): { readonly file: string; readonly bytes: Buffer }[];
  log(): string;
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

export async function startServer(bin: string): Promise<E2EServer> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "lfcp-obsidian-e2e-"));
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
  const child: ChildProcess = spawn(bin, ["--config", join(dir, "server.toml")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "debug" },
  });
  // Killed, and `dir` removed, even if this test process dies first.
  const release = guardChild(child, [dir]);
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
      throw new Error(`the server exited:\n${log}`);
    }
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      release();
      child.kill();
      throw new Error(`the server did not become healthy:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    pid: child.pid as number,
    dir,
    stored: () => files(join(dir, "state")).map((file) => ({ file, bytes: readFileSync(file) })),
    log: () => log,
    stop: async () => {
      release();
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
