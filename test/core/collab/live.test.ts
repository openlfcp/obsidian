// LFCP-065 against the reference server: create and host a collaboration,
// share a task, invite with each preset, join from other devices through
// the real LFCP-053 claim flow, and see edits flow both ways. Skipped
// without a server binary (test/support/live-server.ts).

import { fromHex, type ObjectId, type ResourceId, toHex } from "@openlfcp/core";
import { checkChange } from "@openlfcp/shared-objects";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type JoinStage, taskAt } from "../../../src/core/collab";
import { Collaboration } from "../../../src/core/collab/service";
import { statusView } from "../../../src/core/collab/view";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

const skip = liveSkipReason();
let server: LiveServer;
const running: LfcpRuntime[] = [];

beforeAll(async () => {
  if (skip === null) server = await startLiveServer();
}, 30_000);
afterAll(async () => {
  for (const r of running.splice(0)) await r.stop();
  await server?.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A device with the platform WebSocket (online). */
async function device(snapshotEvery?: number) {
  const d = new Device();
  // The platform WebSocket: the device's offline factory is left out.
  const { webSocket: _offline, ...online } = d.env(new FakeLocal(), { tickMs: 20 });
  const runtime = await LfcpRuntime.start({
    ...online,
    ...(snapshotEvery === undefined ? {} : { snapshotEvery }),
  });
  running.push(runtime);
  return { runtime, collab: new Collaboration(runtime, { connectTimeoutMs: 5000, sleep }) };
}

async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const local = (line: string) => {
  const at = taskAt(line, 0);
  if (at.kind !== "local") throw new Error(at.kind);
  return at.state;
};

/**
 * Finding F3a (SPEC-PATCH-10): the reference corpus case CAN-4-rows-F3a
 * (spec 4198c43, SHARED-OBJECTS-AUTOMERGE-REFERENCE-01.json), a change whose
 * insert column has 13 rows for 3 operations. SDK 0.1.3 admitted it, and
 * the save of a document holding it does not load ("mismatching heads"):
 * F3A_SAVE is that save, written by Automerge 3.5.0 from the case's history
 * and change.
 */
const F3A_SAVE =
  "856f4a831015812300d00101206c9e962e697f0691ba727ddc378cc21f9b1d580e67f7b1e7f9612ebdab63c5" +
  "83016374d314ba7c2b847c2701d3d60b1f4175e93c80f9fc21be0ba02cbf1adab7ca08010203021302230235" +
  "154003430256020c0104020611041305150b21022307340342055607570580010202000201020302007e0843" +
  "414e2e626173650a43414e2e6368616e67657e00017f0002070002040000020201020200057f0000047e0003" +
  "7c016c016d01780179000206007a027f03017e030401017e0200040102007e24160214ac02790102060001";
const F3A_CHANGE =
  "856f4a836374d314018801018a5f1edbbe2f75a38292fe6b74ec7b61206aafc52b55b44732ec85d28a07d3a5" +
  "206c9e962e697f0691ba727ddc378cc21f9b1d580e67f7b1e7f9612ebdab63c5830204000a43414e2e636861" +
  "6e6765000a0102020411041304150734014202560457047002030002017f0200027f0000027f037e01780179" +
  "00010d03017d241614ac0279020300";

describe.skipIf(skip !== null)("LFCP-065 live, against the reference server", () => {
  it("create, host, share, invite, join and sync; read-only and one-time invitations hold", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      });

    // The owner creates and hosts the collaboration, and shares a task.
    const owner = await device();
    const created = await owner.collab.create({ name: "Team", server: server.url });
    expect(created.hosting.kind).toBe("hosted");
    const R: ResourceId = created.resourceId;
    const { objectId } = await owner.collab.share(
      R,
      local("- [ ] Prepare API contract 📅 2026-10-15"),
    );
    await until("the owner's units to be sent", async () =>
      (await owner.collab.status(R)).pendingOutbound === 0 ? true : undefined,
    );

    // Read + write: the joiner sees the task and edits it; the owner sees the edit.
    const rw = await owner.collab.invite(R, "read-write");
    expect(rw.confirmed).toBe(true);
    const writer = await device();
    const stages: JoinStage[] = [];
    const joined = await writer.collab.join(rw.link.reveal(), {
      name: "Their team",
      onStage: (s) => stages.push(s),
    });
    expect(joined).toMatchObject({ kind: "joined", abilities: ["data/read", "data/write"] });
    // §73's order, as the SDK reports it: the key comes before the claim.
    expect(stages).toEqual([
      "connecting",
      "validating invitation",
      "retrieving key",
      "claiming capability",
      "synchronizing",
    ]);
    const seen = await until(
      "the task on the joiner",
      async () => (await writer.runtime.profileOf(R)).replica.task(objectId)?.task,
    );
    expect(seen.title).toBe("Prepare API contract");
    await writer.runtime.writeIntent(R, {
      intent: "task.set_status",
      id: objectId as ObjectId,
      status: "done",
    });
    await until("the joiner's edit on the owner", async () =>
      (await owner.runtime.profileOf(R)).replica.task(objectId)?.task?.status === "done"
        ? true
        : undefined,
    );
    expect(
      (await writer.collab.status(R)).participants.map((p) => [p.you, p.owner]),
    ).toContainEqual([true, false]);

    // Read: the claim grants data/read only.
    const read = await owner.collab.invite(R, "read");
    expect(read.confirmed).toBe(true);
    const reader = await device();
    const readerJoin = await reader.collab.join(read.link.reveal(), { name: "Read only" });
    expect(readerJoin).toMatchObject({ kind: "joined", abilities: ["data/read"] });

    // One-time: the same link is refused for a second device.
    const late = await device();
    const again = await late.collab.join(read.link.reveal(), { name: "Late" });
    expect(again).toMatchObject({ kind: "refused", code: "AUTHORIZATION_FAILED" });
    expect(await late.runtime.hasResource(R)).toBe(false);

    // No output ever carried a link or its secret.
    for (const link of [rw.link.reveal(), read.link.reveal()]) {
      const secret = link.slice(link.indexOf("#secret=") + "#secret=".length);
      for (const line of logged) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain(link);
      }
    }
    expect(toHex(R)).toHaveLength(64);
  }, 60_000);

  it("POST-007: the owner's plugin publishes a Snapshot of a 0.1 collaboration; a joiner loads it", async () => {
    const owner = await device(3);
    const published: string[] = [];
    owner.runtime.on((e) => {
      if (e.type === "snapshot-published") published.push(toHex(e.snapshotId));
    });
    const { resourceId: R } = await owner.collab.create({ name: "Team", server: server.url });
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4])
      ids.push((await owner.collab.share(R, local(`- [ ] Snapshot task ${n}`))).objectId);
    await until(
      "a Snapshot published",
      async () => (published.length > 0 ? true : undefined),
      20_000,
    );
    const joiner = await device();
    const loaded: string[] = [];
    joiner.runtime.on((e) => {
      if (e.type === "snapshot-loaded") loaded.push(toHex(e.snapshotId));
    });
    const invite = await owner.collab.invite(R, "read-write");
    expect(await joiner.collab.join(invite.link.reveal(), { name: "Team" })).toMatchObject({
      kind: "joined",
    });
    for (const id of ids)
      await until(
        "the task on the joiner",
        async () => (await joiner.runtime.profileOf(R)).replica.task(id)?.task,
      );
    expect(loaded.length).toBeGreaterThan(0);
    expect(published).toContain(loaded[0]);
  }, 60_000);

  it("SPEC-PATCH-10: a checkpoint that does not load is rebuilt from the stored units, F3a refused", async () => {
    const owner = await device();
    const created = await owner.collab.create({ name: "Team", server: server.url });
    const R: ResourceId = created.resourceId;
    const { objectId } = await owner.collab.share(R, local("- [ ] Prepare API contract"));
    const invite = await owner.collab.invite(R, "read-write");
    // The victim: a device that is stopped and started again on the same storage.
    const victim = new Device();
    const store = new FakeLocal();
    const { webSocket: _offline, ...env } = victim.env(store, { tickMs: 20 });
    const first = await LfcpRuntime.start(env);
    running.push(first);
    const joined = await new Collaboration(first, { connectTimeoutMs: 5000, sleep }).join(
      invite.link.reveal(),
      { name: "Team" },
    );
    expect(joined.kind).toBe("joined");
    await until(
      "the task on the victim",
      async () => (await first.profileOf(R)).replica.task(objectId)?.task,
    );
    await first.stop();
    // What SDK 0.1.3 left after admitting F3a: a checkpoint whose state does not load.
    const poisoner = await LfcpRuntime.start(env);
    running.push(poisoner);
    const storage = poisoner.storage as LfcpStorage;
    const kept = await storage.profileState.checkpoint(R);
    if (kept === undefined) throw new Error("no checkpoint");
    expect(
      (
        await storage.commit([
          { op: "put-profile-checkpoint", checkpoint: { ...kept, state: fromHex(F3A_SAVE) } },
        ])
      ).ok,
    ).toBe(true);
    await poisoner.stop();

    const again = await LfcpRuntime.start(env);
    running.push(again);
    const rebuilt: string[] = [];
    again.onCheckpointRebuilt((r) => rebuilt.push(toHex(r)));
    await again.openResource(R);
    expect(rebuilt).toEqual([toHex(R)]);
    // The stored units come back through today's admission; nothing reinstalled.
    const task = await until(
      "the task rebuilt from the stored units",
      async () => (await again.profileOf(R)).replica.task(objectId)?.task,
    );
    expect(task.title).toBe("Prepare API contract");
    // F3a itself is refused before the engine.
    expect(() => checkChange(fromHex(F3A_CHANGE))).toThrow(/§11\.3/);
    // The next checkpoint loads: a later start does not rebuild again.
    await until("a checkpoint that loads", async () => {
      const cp = await again.storage?.profileState.checkpoint(R);
      return cp !== undefined && toHex(cp.state) !== F3A_SAVE ? true : undefined;
    });
    await again.stop();
    const last = await LfcpRuntime.start(env);
    running.push(last);
    const later: string[] = [];
    last.onCheckpointRebuilt((r) => later.push(toHex(r)));
    expect((await last.profileOf(R)).replica.task(objectId)?.task?.title).toBe(
      "Prepare API contract",
    );
    expect(later).toEqual([]);
  }, 60_000);

  it("a collaboration the server does not host: refused once, shown in status, not retried (POST-017)", async () => {
    const d = await device();
    const url = server.url;
    const opening = new Map<string, number>();
    d.runtime.on((e) => {
      if (e.type === "resource-state" && e.state === "OPENING") {
        const key = toHex(e.resourceId);
        opening.set(key, (opening.get(key) ?? 0) + 1);
      }
    });
    const refused = (R: ResourceId) =>
      until("the refusal", async () =>
        (await d.runtime.registry()).find(
          (e) => toHex(e.resourceId) === toHex(R) && e.state === "refused",
        ),
      );
    const sync = async (R: ResourceId) =>
      statusView(await d.collab.status(R)).rows.find((r) => r.label === "Sync")?.value;

    // On this device only, never hosted: to the server, the same as a
    // purged collaboration or one on a restored server.
    const R = await d.runtime.createResource({
      name: "Gone",
      endpoints: [url],
      coordinatorUrl: url,
    });
    await d.runtime.openResource(R);
    expect((await refused(R)).refusal).toMatchObject({ code: "RESOURCE_NOT_HOSTED", url });
    expect(await sync(R)).toBe(
      `Not hosted by ${url}: the server no longer has this collaboration (RESOURCE_NOT_HOSTED)`,
    );
    expect(await d.collab.refusalNotice(R)).toBe(
      `Shared Tasks: "Gone" stopped syncing. Not hosted by ${url}: the server no longer has this collaboration (RESOURCE_NOT_HOSTED). Your tasks stay on this device; see "Resource status".`,
    );
    expect(await d.collab.refusalNotice(R)).toBeNull(); // once per collaboration
    // No reconnect storm: the session does not ask again.
    await new Promise((r) => setTimeout(r, 1500));
    expect(opening.get(toHex(R))).toBe(1);

    // Created while the server was unreachable: no notice, "not hosted yet".
    const P = await d.runtime.createResource({
      name: "Created offline",
      endpoints: [url],
      coordinatorUrl: url,
    });
    await d.runtime.localState.put(`collab-hosting:${toHex(P)}`, "pending");
    await d.runtime.openResource(P);
    await refused(P);
    expect(await d.collab.refusalNotice(P)).toBeNull();
    expect(await sync(P)).toBe(`Not hosted yet on ${url}: host it from here to start syncing`);

    // Opening it again (e.g. right after hosting it) asks the server once more.
    await d.runtime.openResource(R);
    await until("a second open", async () => (opening.get(toHex(R)) === 2 ? true : undefined));
    await refused(R);
  }, 30_000);
});
