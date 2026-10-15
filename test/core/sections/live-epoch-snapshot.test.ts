// A member invited after a removal (the soak of 0.4.0-beta.17, finding #3):
// removing access rotates the Data Epoch, and whoever joins afterwards
// receives only the new epoch's key (LFCP-WIRE-01 §18). The section's
// history before the rotation reaches them only through a Snapshot of the
// current epoch (§29.3). The plugin took one only every 200 units, so in a
// quiet section the newcomer never loaded it ("no shared section on this
// device yet"). Now a member who may publish one does so as soon as the
// current epoch has none, after a restart too, and an invitation waits
// until the server has it. Reference server at LFCP_SERVER_BIN; skipped
// without one.

import type { ResourceId } from "@openlfcp/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Peer, peer, waitFor } from "../../native/peer/main";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

const skip = liveSkipReason();
let server: LiveServer;
beforeAll(async () => {
  if (skip === null) server = await startLiveServer();
}, 30_000);
afterAll(async () => {
  await server?.stop();
});

const stopping: Peer[] = [];
afterEach(async () => {
  for (const p of stopping.splice(0)) await p.stop().catch(() => undefined);
});

const NOTE = ["## Plan", "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "", "A paragraph.", ""];

/** A owns the section, B is a member; the section's Resource. */
async function ownerAndMember() {
  const a = await peer(server.url);
  const b = await peer(server.url);
  stopping.push(a, b);
  a.files.set("A.md", NOTE.join("\n"));
  const { resource: R } = await a.share("A.md", "## Plan");
  b.files.set("B.md", ["# B", "", "Insert below.", ""].join("\n"));
  await b.joinAndInsert((await a.collab.invite(R, "read-write")).link.reveal(), "B.md", 3);
  return { a, b, R: R as ResourceId };
}

/** A removes B; resolves once the new epoch is committed on A. */
async function remove(a: Peer, b: Peer, R: ResourceId) {
  let removed = await a.runtime.revokeSectionAccess(R, b.principal as never);
  for (let i = 0; i < 40 && removed.kind !== "queued"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    removed = await a.runtime.revokeSectionAccess(R, b.principal as never);
  }
  expect(removed.kind).toBe("queued");
}

const openEpoch = async (p: Peer, R: ResourceId) =>
  (await p.runtime.storage?.control.epochs(R))?.find((e) => e.closedBy === null)?.epoch;

/** The section as `p`'s model has it: its title and the nodes in order (empty while it cannot load). */
function model(p: Peer, R: ResourceId) {
  const replica = p.runtime.sectionProfile(R)?.replica;
  const snap = replica?.snapshot();
  const sid = (replica?.toJSON() as { section?: { id?: unknown } } | undefined)?.section?.id;
  if (snap === undefined || typeof sid !== "string") return null;
  const s = p.port.snapshot(p.b64(R), sid);
  return s === undefined ? null : JSON.stringify({ title: s.title, order: s.order });
}

/** C joins with `link` and loads the whole section within seconds. */
async function newcomerLoads(a: Peer, R: ResourceId, link: string, fromSnapshot = true) {
  const c = await peer(server.url);
  stopping.push(c);
  const started = Date.now();
  const joined = await c.collab.join(link, { name: "Plan" });
  expect(joined).toMatchObject({ kind: "joined" });
  const seen = await waitFor(async () => model(c, R) ?? undefined, 20_000);
  expect(seen).toBe(model(a, R));
  expect(Date.now() - started).toBeLessThan(20_000);
  expect(await openEpoch(c, R)).toBe(1n);
  // Joined after the rotation, it cannot read the closed epoch's units: a Snapshot of the current one carried them.
  if (fromSnapshot)
    expect(
      (await c.runtime.storage?.snapshots.list(R, { epoch: 1n } as never))?.length,
    ).toBeGreaterThan(0);
  return c;
}

describe.skipIf(skip !== null)("soak #3: a newcomer after a removal loads the section", () => {
  it("quiet section: removed, then invited, no edit since; the owner publishes the epoch's Snapshot by itself", async () => {
    const { a, b, R } = await ownerAndMember();
    await remove(a, b, R);
    await waitFor(async () => ((await openEpoch(a, R)) === 1n ? true : undefined), 30_000);
    // Without any invitation or edit: within the policy's look-again interval.
    await waitFor(
      async () =>
        ((await a.runtime.storage?.snapshots.list(R, { epoch: 1n } as never))?.length ?? 0) > 0
          ? true
          : undefined,
      20_000,
    );
    await newcomerLoads(a, R, (await a.collab.invite(R, "read-write")).link.reveal());
  }, 120_000);

  it("the owner restarts between the removal and its Snapshot: the invitation waits for it", async () => {
    const { a, b, R } = await ownerAndMember();
    await remove(a, b, R);
    // Gone before the rotation is even sent: nothing of epoch 1 published.
    await a.stop();
    stopping.splice(stopping.indexOf(a), 1);
    expect((await a.runtime.storage?.snapshots.list(R, { epoch: 1n } as never))?.length ?? 0).toBe(
      0,
    );
    const a2 = await peer(server.url, { device: a.device, local: a.local, files: a.files });
    stopping.push(a2);
    // As the plugin's sections host does at its start.
    await a2.runtime.openSection(R);
    await waitFor(async () => ((await openEpoch(a2, R)) === 1n ? true : undefined), 30_000);
    // The removal's records at the server (an invitation refuses to start before: CONTROL_PENDING).
    await waitFor(
      async () =>
        (await a2.runtime.storage?.outbound.list(R))?.some((i) => i.kind === "control-record")
          ? undefined
          : true,
      30_000,
    );
    // Invited at once: the invitation itself waits until the server has the Snapshot.
    const link = (await a2.collab.invite(R, "read-write")).link.reveal();
    expect((await a2.runtime.storage?.snapshots.list(R, { epoch: 1n } as never))?.length).toBe(1);
    await newcomerLoads(a2, R, link);
  }, 120_000);

  it("the owner restarts once the removal is at the server, before its Snapshot: an invitation at once waits for it", async () => {
    // LFCP-03-037 (native section-remove-invite, run 38749578805): after a
    // restart this vault knows it may publish only once its session is LIVE
    // and its access answered; an invitation made before that went out with
    // no Snapshot of epoch 1 on the server, and the newcomer loaded nothing.
    const { a, b, R } = await ownerAndMember();
    await remove(a, b, R);
    // The rotation committed and its records ACKed: nothing left for an invitation to wait on but the Snapshot.
    await waitFor(
      async () =>
        (await openEpoch(a, R)) === 1n &&
        !(await a.runtime.storage?.outbound.list(R))?.some((i) => i.kind === "control-record")
          ? true
          : undefined,
      30_000,
    );
    await a.stop();
    stopping.splice(stopping.indexOf(a), 1);
    expect((await a.runtime.storage?.snapshots.list(R, { epoch: 1n } as never))?.length ?? 0).toBe(
      0,
    );
    const a2 = await peer(server.url, { device: a.device, local: a.local, files: a.files });
    stopping.push(a2);
    // As the plugin's sections host does at its start; invited at once, before the session is LIVE.
    await a2.runtime.openSection(R);
    const link = (await a2.collab.invite(R, "read-write")).link.reveal();
    expect((await a2.runtime.storage?.snapshots.list(R, { epoch: 1n } as never))?.length).toBe(1);
    expect((await a2.runtime.storage?.outbound.list(R))?.some((i) => i.kind === "snapshot")).toBe(
      false,
    );
    await newcomerLoads(a2, R, link);
  }, 120_000);

  it("invited before the removal, joining after it: loads too", async () => {
    const { a, b, R } = await ownerAndMember();
    const link = (await a.collab.invite(R, "read-write")).link.reveal();
    await remove(a, b, R);
    await waitFor(async () => ((await openEpoch(a, R)) === 1n ? true : undefined), 30_000);
    // Its invitation carries the epoch-0 key, and the claim the current one.
    await newcomerLoads(a, R, link, false);
  }, 120_000);
});
