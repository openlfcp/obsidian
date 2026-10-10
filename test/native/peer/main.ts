// The second participant of the native acceptance runs (LFCP-02-066), and
// the reference server they share: run in the wdio specs' Node process, so
// the vault under test is real Obsidian with the real plugin, and its
// collaborator is the same plugin core (runtime, collaboration flows,
// section engine) without Obsidian, on fake-indexeddb, online against the
// same server. Test only; bundled into test/native/peer.bundle.mjs by
// scripts/build-native-harness.mjs.

import {
  fromBase64url,
  generateObjectId,
  generateResourceId,
  type ResourceId,
  toBase64url,
} from "@openlfcp/core";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LfcpStorage } from "@openlfcp/storage";
import { Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { SectionCreation } from "../../../src/core/sections/create";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import { type InsertPreview, SectionInsertion } from "../../../src/core/sections/insert";
import { preflight, proposeRange } from "../../../src/core/sections/share";
import {
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { newSectionTask } from "../../../src/core/sections/task-fields";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";
import { type LiveServer, startLiveServer } from "../../support/live-server";
import { guardChild } from "../../support/reaper.mjs";

export type { LiveServer };

/**
 * The reference server at LFCP_SERVER_BIN that can go down and come back at
 * the same address with its state (offline and restart checks): down()
 * stops it and keeps its state, up() starts it again, stop() ends it and
 * removes its directory. Each process is guarded: killed if this one dies.
 */
export async function restartableServer() {
  const bin = process.env.LFCP_SERVER_BIN;
  if (bin === undefined) throw new Error("LFCP_SERVER_BIN is not set");
  const port = await new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => ok(typeof a === "object" && a !== null ? a.port : 0));
    });
  });
  const dir = mkdtempSync(join(tmpdir(), "lfcp-native-acceptance-"));
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
    let log = "";
    const c = spawn(bin, ["--config", join(dir, "server.toml")], { stdio: ["ignore", "pipe", "pipe"] });
    child = c;
    release = guardChild(c, []);
    c.stdout?.on("data", (d) => {
      log += String(d);
    });
    c.stderr?.on("data", (d) => {
      log += String(d);
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (c.exitCode !== null) throw new Error(`the server exited:\n${log}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`the server did not become healthy:\n${log}`);
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
    dir,
    up,
    down,
    stop: async () => {
      await down();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The reference server at LFCP_SERVER_BIN, on a free loopback port, its own state. */
export function startServer(): Promise<LiveServer> {
  return startLiveServer();
}

export type Peer = Awaited<ReturnType<typeof peer>>;

/**
 * A participant without Obsidian: the plugin's core, online, notes in memory.
 * `from` restarts a stopped one on its device, storage and notes.
 */
export async function peer(
  server: string,
  from?: { readonly device: Device; readonly local: FakeLocal; readonly files: Map<string, string> },
) {
  const device = from?.device ?? new Device();
  const local = from?.local ?? new FakeLocal();
  // The platform WebSocket (Node's): the device's offline factory is left out.
  const { webSocket: _offline, ...online } = device.env(local, { tickMs: 20 });
  const runtime = await LfcpRuntime.start(online);
  const status = runtime.status;
  if (status.kind !== "ready") throw new Error(status.kind);
  const collab = new Collaboration(runtime, { connectTimeoutMs: 5000, sleep, sections: true });
  const port = new SdkSectionPort({
    profile: (r) => runtime.sectionProfile(r),
    commit: (r, intents, o) => runtime.commitSection(r, intents, o),
    storage: runtime.storage as LfcpStorage,
    canWrite: (r) => runtime.canWriteSection(r),
  });
  const files = from?.files ?? new Map<string, string>();
  const edit = async (
    path: string,
    fn: (current: string) => readonly { from: number; to: number; insert: string }[] | null,
  ) => {
    const current = files.get(path);
    if (current === undefined) return;
    const changes = fn(current);
    if (changes !== null) files.set(path, applyChanges(current, changes));
  };
  const creation = new SectionCreation({
    host: {
      createSectionResource: (o) => runtime.createSectionResource(o),
      openSection: (R) => runtime.openSection(R),
      host: async (R) => {
        const h = await collab.host(R);
        return h.kind === "hosted" ? { kind: "hosted" } : (h as never);
      },
    },
    port,
    edit,
    journal: runtime.localState,
    createdBy: status.principalId,
    server: () => server,
    newResourceId: () => generateResourceId(),
    newNodeId: () => generateObjectId(),
    newOperationId: () => crypto.randomUUID(),
    newTask: (line, id) => newSectionTask(line, status.principalId, id),
  });
  const insertion = new SectionInsertion({
    port,
    bases: new KeyValueSectionBaseStore(runtime.localState),
    journal: runtime.localState,
    loaded: (r) => runtime.sectionLoad(fromBase64url(r) as ResourceId)?.loaded === true,
    task: (r, id) => port.task(r, id),
    edit,
    newInsertionId: () => crypto.randomUUID(),
  });
  const engine = new SectionEngine({
    port,
    journal: new KeyValueSectionJournalStore(runtime.localState),
    bases: new KeyValueSectionBaseStore(runtime.localState),
    newNodeId: () => generateObjectId(),
    newOperationId: () => crypto.randomUUID(),
    createdBy: status.principalId,
    newProjectionId: () => crypto.randomUUID(),
    tasks: (r, taskId) => ({ view: port.taskView(r, taskId) }),
    newTask: (line, id) => newSectionTask(line, status.principalId, id),
  });
  /** One engine pass over a note, written as the plugin writes it. */
  const pass = async (path: string, caretLine: number | null = null) => {
    const md = files.get(path) as string;
    const p = await engine.pass(path, md, {
      caretLine,
      deletedIds: new Set<string>(),
      origin: "other",
    });
    const out = applyChanges(md, p.changes);
    files.set(path, out);
    await engine.written(p, out);
    return { pass: p, text: out };
  };
  /** Shares the section under `heading` of note `path` and hosts it. */
  const share = async (path: string, heading: string) => {
    const md = files.get(path) as string;
    const range = proposeRange(md, md.split("\n").indexOf(heading));
    if (range === null) throw new Error(`no section under ${heading}`);
    const created = await creation.run(await creation.prepare(path, md, preflight(md, range)));
    return { created, resource: fromBase64url(created.entry.resource) as ResourceId };
  };
  /** Joins with an invitation link; inserts the section into `path` at line `at`. */
  const joinAndInsert = async (link: string, path: string, at: number) => {
    const joined = await collab.join(link, { name: "From A" });
    if (joined.kind !== "joined") throw new Error(`join: ${JSON.stringify(joined)}`);
    const R = joined.resourceId;
    const sectionId = await waitFor(async () => {
      // As the plugin reads it (sections-host): the section's ID in the document.
      const doc = runtime.sectionProfile(R)?.replica.toJSON() as
        | { section?: { id?: unknown } }
        | undefined;
      return typeof doc?.section?.id === "string" ? doc.section.id : undefined;
    });
    const preview = (await insertion.preview(R, sectionId as string)) as InsertPreview;
    const md = files.get(path) as string;
    await insertion.run(await insertion.prepare(path, md, at, preview));
    await pass(path);
    return { resource: R, sectionId: sectionId as string };
  };
  return {
    runtime,
    collab,
    port,
    engine,
    files,
    creation,
    insertion,
    pass,
    share,
    joinAndInsert,
    principal: status.principalId,
    device,
    local,
    b64: (R: ResourceId) => toBase64url(R),
    stop: () => runtime.stop(),
  };
}

/** Waits until `f` gives a value (polling every 50 ms, up to `ms`). */
export async function waitFor<T>(f: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
