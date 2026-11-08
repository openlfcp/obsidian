// Second re-review of task 416, finding R3 (Shared Tasks 0.7.3): a refused
// read never closes a key change whose committed key still waits in its
// pending slot. The device upkeep on the SDK's own flows, for a device with
// no device list (the owner of a section shared with another person):
//
// 1. the upkeep changes the section's key; the server commits the KEY_EPOCH
//    and the answer is lost, so the new key stays in the pending slot;
// 2. the section's ordinary sync brings the committed KEY_EPOCH here, so no
//    key change is due any more;
// 3. the next upkeep's read of the section is refused once (RATE_LIMITED):
//    reported, the obligation still listed, nothing closed;
// 4. after a restart, the ordinary upkeep adopts the original key and hands
//    it to the other person's devices, with no other KEY_EPOCH (§9.1, §9.2).

import {
  deliverKeys,
  heldDeks,
  OperationJournal,
  PackageLedger,
  syncChain,
} from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import { decodeControlRecord, signControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { SDK_IDENTITY_FLOWS } from "../../../src/core/identity/flows";
import { DeviceService } from "../../../src/core/identity/service";
import { DeviceWorld, type Installation, pair, WORLD_URL } from "../../support/device-world";
import { sleep } from "../../support/lfcp-env";

vi.setConfig({ testTimeout: 60_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const epochs = (R: ResourceId) => world.server.chain(R).state.epochs.size;
const ctxOf = (i: Installation) => {
  const ctx = i.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  return ctx;
};
const me = (i: Installation) => toHex(ctxOf(i).principal.id);
const hasKey = (X: ResourceId, recipient: string, epoch: bigint) =>
  world.server.packagesOf(X).some((p) => toHex(p.recipient) === recipient && p.dataEpoch === epoch);

async function synced(i: Installation, R: ResourceId): Promise<void> {
  const ctx = ctxOf(i);
  const channel = await world.server.network().connect(ctx.principal.signer, WORLD_URL);
  await syncChain(ctx.storage, channel, R);
}

/** A new DeviceService over the same runtime and stores: the plugin after a restart. */
function restarted(a: Installation): DeviceService {
  return new DeviceService({
    runtime: () => a.runtime,
    context: () => a.runtime.collaborationContext(),
    collab: () => a.collab,
    defaultServer: () => WORLD_URL,
    platform: "desktop",
    sections: true,
    sleep,
    pacing: null,
    flows: { ...SDK_IDENTITY_FLOWS, connectionNetwork: () => world.server.network() },
  });
}

it("R3: a refused read leaves a key change with a pending key open; after a restart the upkeep hands the original key to the other person", async () => {
  world = new DeviceWorld();
  const a = await world.installation(); // the owner of X: no device list
  const p = await world.installation(); // another person, with devices B and C
  const b = await world.installation();
  const c = await world.installation();
  const X = await a.section("Plans");
  const actx = ctxOf(a);
  // A grants P read and write in X, and seals X's key to P.
  const ach = await world.server.network().connect(actx.principal.signer, WORLD_URL);
  const x0 = await syncChain(actx.storage, ach, X);
  const grant = signControlRecord(
    { resourceId: X, controlSeq: x0.state.seq + 1n, prevControlId: x0.state.head },
    {
      type: "CAPABILITY_GRANT",
      subject: ctxOf(p).principal.signer.descriptor,
      abilities: [1n, 2n],
      delegable: [],
    },
    actx.principal.signer,
  ).bytes;
  expect((await ach.putControl(X, x0.state.head, grant)).kind).toBe("ack");
  const x1 = await syncChain(actx.storage, ach, X);
  await deliverKeys({
    channel: ach,
    ledger: new PackageLedger(actx.storage),
    chain: x1,
    sender: actx.principal.signer,
    recipients: [ctxOf(p).principal.signer.descriptor],
    deks: await heldDeks(actx.secrets, x1),
  });
  // P holds X, pairs B and C (registered in X), then removes B: an exposing revocation in X.
  await synced(p, X);
  expect(await p.collab.openFromRoster(X, "Plans")).toBe(true);
  await b.service.progress(await pair(p, b, "edit"));
  await pair(p, c, "edit");
  expect((await p.service.remove(me(b), 1n, "Old phone")).kind).not.toBe("stop");
  await synced(a, X);
  expect(await a.service.identity()).toBeUndefined();
  const before = epochs(X);
  const epoch = BigInt(before);
  // 1. A's key change is committed, its answer lost: the new key stays pending.
  world.server.fault = (e) =>
    e.op === "control" &&
    toHex(e.resource) === toHex(X) &&
    decodeControlRecord(e.bytes).body.type === "KEY_EPOCH"
      ? "drop-answer"
      : undefined;
  const lost = await a.service.upkeep();
  world.server.fault = () => undefined;
  expect(lost.rotations.map((r) => r.status)).toEqual(["unreachable"]);
  expect(epochs(X)).toBe(before + 1);
  expect(hasKey(X, me(p), epoch)).toBe(false);
  // 2. X's ordinary sync brings the committed KEY_EPOCH: no key change is due any more.
  await synced(a, X);
  // 3. The next upkeep's read of X is refused, once.
  world.server.readFault = (r) => (toHex(r) === toHex(X) ? "RATE_LIMITED" : undefined);
  const refused = await a.service.upkeep();
  world.server.readFault = () => undefined;
  expect(refused.issues).toContainEqual({
    resource: toHex(X),
    kind: "refused",
    detail: "RATE_LIMITED",
  });
  expect(epochs(X)).toBe(before + 1);
  // Nothing is closed: the key change is still open and listed.
  const journal = new OperationJournal(actx.storage);
  expect((await journal.list({ kind: "rotate", status: "open" })).length).toBe(1);
  expect((await a.service.unfinished()).find((u) => u.kind === "key")?.sections).toEqual(["Plans"]);
  // 4. After a restart, the ordinary upkeep hands the original key on, with no other KEY_EPOCH.
  const service = restarted(a);
  await service.upkeep();
  expect(epochs(X)).toBe(before + 1);
  expect(hasKey(X, me(p), epoch)).toBe(true);
  expect(hasKey(X, me(c), epoch)).toBe(true);
  expect(hasKey(X, me(b), epoch)).toBe(false);
  expect((await heldDeks(actx.secrets, world.server.chain(X))).has(String(epoch))).toBe(true);
  const left = (await service.unfinished()).filter(
    (u) => u.kind === "key" || u.kind === "handover",
  );
  expect(left).toEqual([]);
  expect((await journal.list({ kind: "rotate", status: "open" })).length).toBe(0);
});
