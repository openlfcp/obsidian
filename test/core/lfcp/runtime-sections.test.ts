// Shared-sections Resources in the plugin's runtime (MVP 0.2): created
// with the sections profile, opened with their replica and commit binding,
// committed through the session with durable receipts, restored after a
// restart; and the section engine on top, with the real SDK port and its
// records in the install database. Offline (the session never connects).

import { receiptOf } from "@openlfcp/client";
import { type ObjectId, toBase64url } from "@openlfcp/core";
import { createTask } from "@openlfcp/shared-objects";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { Collaboration } from "../../../src/core/collab/service";
import {
  LfcpRuntime,
  NEEDS_RESTART,
  SectionsReadOnlyError,
  UnsupportedProfileError,
} from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import { formatBoundary, formatNodeMarker } from "../../../src/core/sections/grammar";
import {
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const SECTION = "0192e4a0-0000-7000-8000-000000000001";
const id = (n: number) => `0192e4a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});
const start = async (device: Device, local: FakeLocal) => {
  const r = await LfcpRuntime.start(device.env(local));
  running.push(r);
  return r;
};
const me = (r: LfcpRuntime) => {
  const s = r.status;
  if (s.kind !== "ready") throw new Error(s.kind);
  return s.principalId;
};

describe("shared-sections Resources in the runtime", () => {
  it("creates, opens and commits with a receipt; a restart restores the section", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await r.openSection(R);
    const receipt = await r.commitSection(
      R,
      [{ intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me(r) }],
      { operationId: "create" },
    );
    expect(receipt.durable).toBe(true);
    expect(r.sectionProfile(R)?.replica.snapshot().title.value).toBe("Launch");
    expect((await r.storage?.outbound.list(R))?.length).toBe(receipt.unitIds.length);
    // The 0.1 paths leave it alone.
    await expect(r.openResource(R)).rejects.toBeInstanceOf(UnsupportedProfileError);

    await r.stop();
    const again = await start(device, local);
    await again.openSection(R);
    expect(again.sectionProfile(R)?.replica.snapshot().title.value).toBe("Launch");
    expect(await receiptOf(again.storage as LfcpStorage, R, "create")).toEqual(receipt);
  });

  it("opens a section once when asked twice at once after a start, so commits reach the model read (LFCP-03-033)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await r.commitSection(
      R,
      [{ intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me(r) }],
      { operationId: "create" },
    );
    await r.stop();
    const again = await start(device, local);
    // The host, a status read and a pass, right after the start.
    const [a, b] = await Promise.all([again.openSection(R), again.openSection(R)]);
    expect(b).toBe(a);
    expect(again.sectionProfile(R)).toBe(a);
    await again.commitSection(R, [{ intent: "section.set_title", title: "Launch v2" }], {
      operationId: "rename",
    });
    expect(again.sectionProfile(R)?.replica.snapshot().title.value).toBe("Launch v2");
  });

  it("a listener that fails after a section commit is stored keeps the batch in the model (SDK 0.2.1, LFCP-03-034)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await r.openSection(R);
    r.on((e) => {
      if (e.type === "status" && (e.event as { kind?: string }).kind === "batch")
        throw new Error("a listener fails");
    });
    const receipt = await r.commitSection(
      R,
      [{ intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me(r) }],
      { operationId: "create" },
    );
    expect(receipt.operationId).toBe("create");
    expect(r.sectionProfile(R)?.replica.snapshot().title.value).toBe("Launch");
    expect(await receiptOf(r.storage as LfcpStorage, R, "create")).toEqual(receipt);
    expect(r.status).not.toMatchObject({ kind: "needs-restart" });
    // The next batch builds on it: nothing was rewound.
    await r.commitSection(R, [{ intent: "section.set_title", title: "Launch v2" }], {
      operationId: "rename",
    });
    expect(r.sectionProfile(R)?.replica.snapshot().title.value).toBe("Launch v2");
  });

  it("an engine trap after a section commit is stored rejects it and blocks the runtime (needs-restart)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await r.openSection(R);
    const heard: string[] = [];
    r.onNeedsRestart((m) => heard.push(m));
    // A listener of the batch's report traps, as a terminated wasm module does.
    r.on((e) => {
      if (e.type === "status" && (e.event as { kind?: string }).kind === "batch")
        throw new WebAssembly.RuntimeError("unreachable executed");
    });
    await expect(
      r.commitSection(
        R,
        [{ intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me(r) }],
        { operationId: "create" },
      ),
    ).rejects.toThrow(NEEDS_RESTART);
    expect(r.status).toMatchObject({ kind: "needs-restart" });
    expect(heard).toHaveLength(1);
  });

  it("a checkpoint that does not load: rebuilt from the stored units, never reusing a sequence (SPEC-PATCH-10)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await r.openSection(R);
    await r.commitSection(
      R,
      [{ intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me(r) }],
      { operationId: "create" },
    );
    const storage = r.storage as LfcpStorage;
    const kept = await storage.profileState.checkpoint(R);
    if (kept === undefined) throw new Error("no checkpoint");
    // An Automerge document chunk that does not load (its checksum is wrong).
    const broken = Uint8Array.from([0x85, 0x6f, 0x4a, 0x83, 0, 0, 0, 0, 0, 1, 0]);
    await storage.commit([
      { op: "put-profile-checkpoint", checkpoint: { ...kept, state: broken } },
    ]);
    await r.stop();

    const again = await start(device, local);
    const rebuilt: string[] = [];
    again.onCheckpointRebuilt((x) => rebuilt.push(toBase64url(x)));
    await again.openSection(R);
    expect(rebuilt).toEqual([toBase64url(R)]);
    // Offline nothing accepted is replayed yet: the replica waits for its own
    // units and writes nothing at a sequence it already used (§9).
    expect(again.sectionProfile(R)?.replica.writable).toBe(false);
    expect(kept.actorSeq).toBeGreaterThan(0);
  });

  it("on mobile (V3): sections are read and shown; no section write path runs; 0.1 still writes (LFCP-02-095)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const desktop = await start(device, local);
    const R = await desktop.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await desktop.openSection(R);
    await desktop.commitSection(
      R,
      [{ intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me(desktop) }],
      { operationId: "create" },
    );
    const tasks = await desktop.createResource({
      name: "Tasks",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await desktop.stop();

    const mobile = await LfcpRuntime.start(device.env(local, { sectionsReadOnly: true }));
    running.push(mobile);
    expect(mobile.sectionsReadOnly).toBe(true);
    await mobile.openSection(R);
    expect(mobile.sectionProfile(R)?.replica.snapshot().title.value).toBe("Launch");
    expect(await mobile.canWriteSection(R)).toMatchObject({ allowed: false, reason: "read-only" });
    const queued = (await mobile.storage?.outbound.list(R))?.length;
    await expect(
      mobile.commitSection(R, [{ intent: "section.set_title", title: "Mobile" }], {
        operationId: "m1",
      }),
    ).rejects.toBeInstanceOf(SectionsReadOnlyError);
    await expect(
      mobile.createSectionResource({ name: "New", endpoints: [URL], coordinatorUrl: URL }),
    ).rejects.toBeInstanceOf(SectionsReadOnlyError);
    await expect(mobile.revokeSectionAccess(R, me(mobile))).rejects.toBeInstanceOf(
      SectionsReadOnlyError,
    );
    expect((await mobile.storage?.outbound.list(R))?.length).toBe(queued);
    const collab = new Collaboration(mobile, { sleep, sections: true, sectionsReadOnly: true });
    await expect(collab.checkInvitable(R)).rejects.toMatchObject({ code: "SECTIONS_READ_ONLY" });
    // 0.1 collaborations keep working (legacy Tasks).
    const { intent } = createTask({
      id: "017f22e2-79b0-7cc3-98c4-dc0c0c07398f" as ObjectId,
      title: "Still writes",
      createdBy: me(mobile),
    });
    expect(await mobile.writeIntent(tasks, intent)).not.toBeNull();
  });

  it("creates under a Resource ID chosen beforehand, once (LFCP-02-050)", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const first = await r.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    const wanted = new Uint8Array(32).fill(7) as unknown as typeof first;
    const options = { name: "Launch", endpoints: [URL], coordinatorUrl: URL, resourceId: wanted };
    expect(toBase64url(await r.createSectionResource(options))).toBe(toBase64url(wanted));
    const genesis = await r.storage?.resources.get(wanted);
    // A retry after a crash finds it and does not make it again.
    expect(toBase64url(await r.createSectionResource(options))).toBe(toBase64url(wanted));
    expect(await r.storage?.resources.get(wanted)).toEqual(genesis);
    expect(toBase64url(first)).not.toBe(toBase64url(wanted));
  });

  it("runs the section engine on the runtime, its records in the install database", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await r.openSection(R);
    await r.commitSection(
      R,
      [{ intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me(r) }],
      { operationId: "create" },
    );
    const port = new SdkSectionPort({
      profile: (res) => r.sectionProfile(res),
      commit: (res, intents, o) => r.commitSection(res, intents, o),
      storage: r.storage as LfcpStorage,
      canWrite: (res) => r.canWriteSection(res),
    });
    let n = 10;
    const engine = new SectionEngine({
      port,
      journal: new KeyValueSectionJournalStore(r.localState),
      bases: new KeyValueSectionBaseStore(r.localState),
      newNodeId: () => id(n++),
      newOperationId: () => `op-${n++}`,
      createdBy: me(r),
      newProjectionId: () => "projection",
      tasks: () => undefined,
      newTask: (line, taskId) => ({ id: taskId, title: line }),
    });
    const S = { resourceId: R, sectionId: SECTION };
    const note = (body: string[]) =>
      ["## Launch", formatBoundary("start", S), ...body, formatBoundary("end", S), ""].join("\n");
    const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };
    const run = async (md: string) => {
      const pass = await engine.pass("Launch.md", md, ctx);
      const out = applyChanges(md, pass.changes);
      await engine.written(pass, out);
      return out;
    };
    expect(await run(note([]))).toBe(note([]));
    const out = await run(note(["Draft contract"]));
    expect(out).toBe(note([formatNodeMarker("paragraph", id(10)), "Draft contract"]));
    const snap = port.snapshot(toBase64url(R), SECTION);
    expect(snap?.nodes[id(10)]?.text).toBe("Draft contract");
    // The base is in the install database: a new engine on it sees nothing to do.
    expect(await new KeyValueSectionBaseStore(r.localState).projectionsOf("Launch.md")).toEqual([
      "projection",
    ]);
    expect(await run(out)).toBe(out);
  });
});
