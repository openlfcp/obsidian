// @vitest-environment happy-dom
// LFCP-03-033: an edit this device committed stays in its model and note.
// The native acceptance run's C10 failed now and then: A renamed a Task
// offline, the rename reached B (a conflict there), and A showed CURRENT
// with the old title in its note and model, and never applied B's later
// changes. The SDK's commit reverts the staged change in the model when a
// step after the durable store throws (src/core/lfcp/durable-commit.ts),
// e.g. the send on a connection that dropped meanwhile; the stored units
// still go out. Here: the C08-C11 sequence (an edit waiting across a restart
// and the server's absence, then both sides renaming the same Task offline),
// and the two ways a step after the store fails, made deterministic. Two
// real plugins (sections on, a CodeMirror editor each) on the reference
// server, which goes down and comes back with its state. Skipped without the
// server unless LFCP_REQUIRE_LIVE=1.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboundQueue } from "@openlfcp/client";
import { fromBase64url, type ResourceId } from "@openlfcp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECTION_NOTE, SoakPeer } from "../soak/peer";
import { serverBinary } from "../support/e2e-server";
import { until } from "../support/e2e-vault";
import { guardChild } from "../support/reaper.mjs";

const binary = serverBinary();
const live = "bin" in binary;

const healthy = (port: number) =>
  new Promise<boolean>((ok) => {
    const req = get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
      res.resume();
      ok(res.statusCode === 200);
    });
    req.on("error", () => ok(false));
  });

/** The reference server that can go down and come back at the same address with its state. */
async function restartable(bin: string) {
  const port = await new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => ok(typeof a === "object" && a !== null ? a.port : 0));
    });
  });
  const dir = mkdtempSync(join(tmpdir(), "lfcp-obsidian-e2e-"));
  const url = `ws://127.0.0.1:${port}/v1/ws`;
  writeFileSync(
    join(dir, "server.toml"),
    [
      `bind = "127.0.0.1:${port}"`,
      `state_dir = ${JSON.stringify(join(dir, "state"))}`,
      `public_urls = [${JSON.stringify(url)}]`,
      "heartbeat_ms = 2000",
      "",
    ].join("\n"),
  );
  let child: ChildProcess | null = null;
  let release: () => void = () => undefined;
  const up = async () => {
    const c = spawn(bin, ["--config", join(dir, "server.toml")], { stdio: "ignore" });
    child = c;
    release = guardChild(c, [dir]);
    const deadline = Date.now() + 15_000;
    while (!(await healthy(port))) {
      if (c.exitCode !== null || Date.now() > deadline) throw new Error("the server did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const down = async () => {
    const c = child;
    child = null;
    release();
    if (c !== null && c.exitCode === null) {
      const exited = new Promise((r) => c.once("exit", r));
      c.kill();
      await exited;
    }
  };
  await up();
  return {
    url,
    up,
    down,
    stop: async () => {
      await down();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let server: Awaited<ReturnType<typeof restartable>>;
let A: SoakPeer;
let B: SoakPeer;

beforeAll(async () => {
  if (!live) return;
  server = await restartable(binary.bin);
  A = await SoakPeer.open("A", "a", server.url, 1);
  B = await SoakPeer.open("B", "b", server.url, 2);
  const { resource } = await A.share(12, ["a", "b"]);
  await B.join(await A.invite(resource), "Soak");
  await B.insert(resource);
  A.openEditor();
  B.openEditor();
}, 300_000);

afterAll(async () => {
  await A?.vault.close();
  await B?.vault.close();
  await server?.stop();
});

const stateOf = async (p: SoakPeer) => (await p.sectionStates())[0]?.state;
const inState = (p: SoakPeer, s: string) => async () =>
  (await stateOf(p)) === s ? true : undefined;
const closed = (p: SoakPeer) => () =>
  p.runtime.phase(fromBase64url(p.resource) as ResourceId) === "CLOSED" ? true : undefined;
const connected = (p: SoakPeer) => () => (closed(p)() === true ? undefined : true);
const lineOf = (p: SoakPeer, needle: string) =>
  p
    .text(SECTION_NOTE)
    .split("\n")
    .find((l) => l.includes(needle)) ?? null;
/** The note's unchecked top-level Tasks, in order. */
const openTasks = (p: SoakPeer) =>
  p
    .text(SECTION_NOTE)
    .split("\n")
    .flatMap((l) => /^- \[ \] ([ab]\d+ \S+ item)/.exec(l)?.[1] ?? []);

/** Whether `p`'s model has a Task titled `title`. */
const modelHas = (p: SoakPeer, title: string) => {
  const canon = p.model()?.canon;
  if (canon === undefined) return false;
  const tasks = (JSON.parse(canon) as { tasks: Record<string, { title?: string } | null> }).tasks;
  return Object.values(tasks).some((t) => t?.title === title);
};

/**
 * A renames `title` (the API edit of Obsidian's editor.setLine); then A and
 * B agree on that Task. Only that Task is compared: Tasks the earlier steps
 * left in conflict show whichever value won.
 */
async function renamedEverywhere(title: string, to: string): Promise<void> {
  A.editTask(title, title, to);
  await until(
    "B has A's edit",
    () => (B.text(SECTION_NOTE).includes(to) ? true : undefined),
    60_000,
  );
  try {
    await until(
      "A's model and B's with the edit",
      async () =>
        (await A.outbound()) === 0 && modelHas(A, to) && modelHas(B, to) ? true : undefined,
      60_000,
    );
  } catch (e) {
    throw new Error(
      `${String(e)}: A "${lineOf(A, title.split(" ")[0] as string)}" ${JSON.stringify(A.noteVsModel())}`,
    );
  }
  // A's note shows the edit, as its model does.
  expect(lineOf(A, to)).not.toBeNull();
  expect(A.noteVsModel().filter((d) => d.includes(to))).toEqual([]);
}

describe.skipIf(!live)("an edit this device committed stays (LFCP-03-033)", () => {
  it("C08-C11: an edit waits across a restart, then both rename a Task offline; both see the conflict", async () => {
    await until("A current", inState(A, "CURRENT"), 60_000);
    await until("B current", inState(B, "CURRENT"), 60_000);
    const tasks = openTasks(A);
    // The server goes again at once after the waiting edit is accepted, and a while after.
    for (const [round, delay] of [0, 300].entries()) {
      const conflictsA = A.model()?.problems ?? 0;
      const conflictsB = B.model()?.problems ?? 0;
      const checked = tasks[2 * round] as string;
      const renamed = tasks[2 * round + 1] as string;
      const stem = renamed.split(" ")[0] as string;
      // C08-C09: an edit waits for the server, across a restart of the plugin.
      await server.down();
      await until("A offline", closed(A), 30_000);
      A.editTask(checked, "- [ ]", "- [x]");
      await until(
        "A's edit waiting",
        async () => ((await A.outbound()) > 0 ? true : undefined),
        20_000,
      );
      await A.restart();
      await until("A offline after its restart", closed(A), 60_000);
      await server.up();
      await until(
        "A's edit sent",
        async () => ((await A.outbound()) === 0 ? true : undefined),
        60_000,
      );
      await new Promise((r) => setTimeout(r, delay));
      // C10: both rename the same Task while the server is down.
      await server.down();
      await until("A offline again", closed(A), 30_000);
      await until("B offline", closed(B), 30_000);
      A.editTask(renamed, renamed, `${stem} renamed by A`);
      B.editTask(renamed, renamed, `${stem} renamed by B`);
      await new Promise((r) => setTimeout(r, 2500));
      await server.up();
      const both = async () =>
        (A.model()?.problems ?? 0) > conflictsA &&
        (B.model()?.problems ?? 0) > conflictsB &&
        /renamed by [AB]/.test(lineOf(A, `${stem} `) ?? "") &&
        A.text(SECTION_NOTE).includes(`- [x] ${checked}`) &&
        B.text(SECTION_NOTE).includes(`- [x] ${checked}`)
          ? true
          : undefined;
      try {
        await until("the conflict on both sides", both, 45_000);
      } catch (e) {
        throw new Error(
          `${String(e)} (round ${round}): A ${await stateOf(A)} "${lineOf(A, `${stem} `)}" ${JSON.stringify(A.noteVsModel())}; B ${await stateOf(B)} "${lineOf(B, `${stem} `)}"`,
        );
      }
    }
  }, 600_000);

  it("keeps an edit when the connection drops while its commit is sent", async () => {
    await until("A live", connected(A), 60_000);
    await until("B live", connected(B), 60_000);
    const R = fromBase64url(A.resource) as ResourceId;
    // The commit's send reads the queue; the connection is gone when it sends
    // (ConnectionNotReady): the window a server or network drop can hit.
    const next = OutboundQueue.prototype.next;
    let armed = true;
    OutboundQueue.prototype.next = async function (this: OutboundQueue, ...a) {
      if (armed && A.runtime.phase(R) === "LIVE" && (await A.outbound()) > 0) {
        armed = false;
        A.offline(true);
        await until("A's connection gone", closed(A), 10_000);
      }
      return next.apply(this, a);
    };
    try {
      const title = openTasks(A).at(-1) as string;
      const done = renamedEverywhere(title, `${title.split(" ")[0]} dropped while sent`);
      await until("the drop", () => (armed ? undefined : true), 30_000);
      A.offline(false);
      A.onlineEvent();
      await done;
    } finally {
      OutboundQueue.prototype.next = next;
    }
  }, 300_000);

  it("keeps an edit when a listener of its commit's report throws", async () => {
    await until("A live", connected(A), 60_000);
    let armed = true;
    A.runtime.on((e) => {
      if (armed && e.type === "status" && (e.event as { kind?: string }).kind === "batch") {
        armed = false;
        throw new Error("a listener fails");
      }
    });
    const title = openTasks(A).at(-2) as string;
    await renamedEverywhere(title, `${title.split(" ")[0]} kept past a listener`);
    expect(armed).toBe(false);
  }, 300_000);
});
