// LFCP-04-413 (review obsidian#107 P1-2, P2-3): the device upkeep with the
// SDK's identity flows over the in-memory coordinator. The rotation policy
// of §8.4 (decision I6: the owner rotates after another device's
// DEVICE_REVOKE), and registrations left for later by an approval (§5.3
// step 10, §7.1).

import { deliverKeys, heldDeks, PackageLedger, syncChain } from "@openlfcp/client";
import { fromHex, type PrincipalId, type ResourceId, toHex } from "@openlfcp/core";
import {
  decodeControlRecord,
  parseKeyPackage,
  revocationOf,
  signControlRecord,
} from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceService } from "../../../src/core/identity/service";
import { DeviceWorld, type Installation, pair, WORLD_URL } from "../../support/device-world";

// Several installations and a coordinator per test, on the real SDK flows: slower than a unit.
vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const epochs = (R: ResourceId) => world.server.chain(R).state.epochs.size;
const me = (i: Installation) =>
  toHex(i.runtime.collaborationContext()?.principal.id ?? new Uint8Array());

/** What the runtime's session does when a section comes live: its chain stored as the server has it. */
async function synced(i: Installation, R: ResourceId): Promise<void> {
  const ctx = i.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  const channel = await world.server
    .network()
    .connect(ctx.principal.signer, "wss://identity.example");
  await syncChain(ctx.storage, channel, R);
}

it("a Full device retires itself; the first device's upkeep changes the keys it could read (P1-2)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  const before = epochs(X);
  // B retires itself: a self-retirement commits the revocations only (§8.2).
  const retired = await b.service.remove(me(b), 0n, "Phone");
  expect(retired.kind).not.toBe("stop");
  expect(epochs(X)).toBe(before);
  // The section's session brings the revocation to A; the upkeep that follows rotates.
  await synced(a, X);
  const r = await a.service.upkeep();
  expect(r.reconciled).toBe(true);
  expect(r.rotations.find((x) => toHex(x.resource) === toHex(X))?.status).toBe("rotated");
  expect(epochs(X)).toBe(before + 1);
  // Nothing more is owed: a second upkeep changes nothing.
  expect((await a.service.unfinished()).filter((u) => u.kind === "key")).toEqual([]);
  await a.service.upkeep();
  expect(epochs(X)).toBe(before + 1);
});

it("a section outside reconciliation is rotated by the device that may change its key (P1-2)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await b.service.remove(me(b), 0n, "Phone");
  await synced(a, X);
  // The same installation as seen without its device list: the owner of X only.
  const ctx = a.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  const marks = ctx.storage.localMarks;
  const owner = new DeviceService({
    runtime: () => a.runtime,
    context: () => ({
      ...ctx,
      // The same storage, its recorded Identity Resource hidden.
      storage: new Proxy(ctx.storage, {
        get: (target, key) => {
          if (key === "localMarks")
            return {
              get: (k: string) =>
                k === "identity:resource" ? Promise.resolve(undefined) : marks.get(k),
              list: (prefix: string) => marks.list(prefix),
            };
          const v = Reflect.get(target, key, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }),
    }),
    collab: () => a.collab,
    defaultServer: () => "wss://identity.example",
    platform: "desktop",
    sections: true,
    sleep: async () => undefined,
    flows: {
      ...(await import("../../../src/core/identity/flows")).SDK_IDENTITY_FLOWS,
      connectionNetwork: () => world.server.network(),
      reconcileDevices: () => Promise.reject(new Error("no device list here")),
    },
  });
  const before = epochs(X);
  expect((await owner.unfinished()).find((u) => u.kind === "key")?.sections).toEqual(["Plans"]);
  const r = await owner.upkeep();
  expect(r.reconciled).toBe(false);
  expect(r.rotations.map((x) => x.status)).toEqual(["rotated"]);
  expect(epochs(X)).toBe(before + 1);
});

it("a device not added to a section while its server was down is added by the upkeep (P2-3)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  world.server.down.add(toHex(X));
  const op = await pair(a, b, "edit");
  expect((await b.service.progress(op)).sections).toEqual([
    { name: "Plans", status: "unreachable, retrying" },
  ]);
  world.server.down.delete(toHex(X));
  // The managing side shows what is owed, and finishes it.
  const owed = (await a.service.unfinished()).filter((u) => u.kind === "registration");
  expect(owed).toEqual([
    { kind: "registration", operation: "", label: expect.any(String), sections: ["Plans"] },
  ]);
  const r = await a.service.upkeep();
  expect(r.reconciled).toBe(true);
  expect((await a.service.unfinished()).filter((u) => u.kind === "registration")).toEqual([]);
  const view = await b.service.progress(op);
  expect(view.sections).toEqual([{ name: "Plans", status: "ready" }]);
  expect(view.final).toBe(true);
});

it("a removal recorded in the device list only is seen by the next upkeep, which carries it into the section (B1)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await a.service.upkeep();
  // B retires itself while X's server is down: the revocation is in the device list only.
  world.server.down.add(toHex(X));
  await b.service.remove(me(b), 0n, "Phone");
  world.server.down.delete(toHex(X));
  const root = world.server.chain(X).state.owner.principalId;
  const phone = fromHex(me(b)) as PrincipalId;
  expect(revocationOf(world.server.chain(X).state, root, phone)).toBeUndefined();
  const before = epochs(X);
  // X's session is live again (nothing new in X); the upkeep that follows decides.
  await synced(a, X);
  await a.service.upkeep();
  expect(revocationOf(world.server.chain(X).state, root, phone)).toBeDefined();
  expect(epochs(X)).toBe(before + 1);
});

it("with no section at all, the upkeep still changes the device list's key after a self-retirement (B1)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "full"));
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  await a.service.upkeep();
  const before = epochs(I);
  await b.service.remove(me(b), 0n, "Phone");
  await a.service.upkeep();
  expect(epochs(I)).toBe(before + 1);
});

it("a key the upkeep could not hand to a device after its key change is handed on by the next one (B2)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const c = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await pair(a, c, "edit");
  await b.service.remove(me(b), 0n, "Phone");
  await synced(a, X);
  const keyOf = (epoch: bigint) =>
    world.server.packagesOf(X).some((p) => toHex(p.recipient) === me(c) && p.dataEpoch === epoch);
  // The coordinator takes the new KEY_EPOCH, then the connection drops on C's package.
  world.server.fault = (e) =>
    e.op === "key-package" &&
    toHex(e.resource) === toHex(X) &&
    toHex(parseKeyPackage(e.bytes).payload.recipient) === me(c)
      ? "drop-request"
      : undefined;
  const before = epochs(X);
  await a.service.upkeep();
  expect(epochs(X)).toBe(before + 1);
  const latest = BigInt(before);
  expect(keyOf(latest)).toBe(false);
  // The debt is listed, and the next ordinary upkeep pays it, without another key change.
  expect((await a.service.unfinished()).find((u) => u.kind === "handover")?.sections).toEqual([
    "Plans",
  ]);
  world.server.fault = () => undefined;
  await a.service.upkeep();
  expect(keyOf(latest)).toBe(true);
  expect(epochs(X)).toBe(before + 1);
  expect((await a.service.unfinished()).filter((u) => u.kind === "handover")).toEqual([]);
});

it("Finish now does not say up to date when a reachable server refused the registration, or none answered (B3)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  world.server.down.add(toHex(X));
  await pair(a, b, "edit");
  world.server.down.delete(toHex(X));
  world.server.fault = (e) =>
    e.op === "control" &&
    toHex(e.resource) === toHex(X) &&
    decodeControlRecord(e.bytes).body.type === "DEVICE_GRANT"
      ? { nack: "QUOTA_EXCEEDED" }
      : undefined;
  const refused = await a.service.upkeep(true);
  expect(refused.summary).not.toContain("up to date");
  expect(refused.summary).toContain('Refused by the server in "Plans".');
  world.server.fault = () => undefined;
  world.server.offline = true;
  const offline = await a.service.upkeep(true);
  expect(offline.summary).not.toContain("up to date");
  expect(offline.summary).toContain("could not be reached");
  world.server.offline = false;
  const done = await a.service.upkeep(true);
  expect(done.summary).toContain("up to date");
});

/** The coordinator refuses the package of X's epoch `epoch` for `recipient` (hex), until `lift`. */
function refusePackage(X: ResourceId, recipient: string, epoch: bigint) {
  world.server.fault = (e) => {
    if (e.op !== "key-package" || toHex(e.resource) !== toHex(X)) return undefined;
    const p = parseKeyPackage(e.bytes).payload;
    return toHex(p.recipient) === recipient && p.dataEpoch === epoch
      ? { nack: "QUOTA_EXCEEDED" }
      : undefined;
  };
}

const hasKey = (X: ResourceId, recipient: string, epoch: bigint) =>
  world.server.packagesOf(X).some((p) => toHex(p.recipient) === recipient && p.dataEpoch === epoch);

it("a new key the server refused to a device during the key change is unfinished, then handed on (C2)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const c = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await pair(a, c, "edit");
  await b.service.remove(me(b), 0n, "Phone");
  await synced(a, X);
  const before = epochs(X);
  const latest = BigInt(before);
  refusePackage(X, me(c), latest);
  const first = await a.service.upkeep();
  expect(epochs(X)).toBe(before + 1);
  expect(hasKey(X, me(c), latest)).toBe(false);
  expect(first.summary).not.toContain("up to date");
  expect(first.summary).toContain('A key could not be handed on in "Plans".');
  world.server.fault = () => undefined;
  const second = await a.service.upkeep();
  expect(hasKey(X, me(c), latest)).toBe(true);
  expect(epochs(X)).toBe(before + 1);
  expect(second.summary).not.toContain("could not");
  expect((await a.service.upkeep(true)).summary).toContain("up to date");
});

it("an owner without a device list hands on a new key the server refused to another person's device (C1)", async () => {
  world = new DeviceWorld();
  const a = await world.installation(); // the owner of X: no device list
  const p = await world.installation(); // another person, with devices B and C
  const b = await world.installation();
  const c = await world.installation();
  const X = await a.section("Plans");
  const actx = a.runtime.collaborationContext();
  const pctx = p.runtime.collaborationContext();
  if (actx === null || pctx === null) throw new Error("not ready");
  // A grants P read and write in X, and seals X's key to P.
  const ach = await world.server.network().connect(actx.principal.signer, WORLD_URL);
  const x0 = await syncChain(actx.storage, ach, X);
  const grant = signControlRecord(
    { resourceId: X, controlSeq: x0.state.seq + 1n, prevControlId: x0.state.head },
    {
      type: "CAPABILITY_GRANT",
      subject: pctx.principal.signer.descriptor,
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
    recipients: [pctx.principal.signer.descriptor],
    deks: await heldDeks(actx.secrets, x1),
  });
  // P holds X, pairs B and C (both registered in X with X's key), then removes B.
  await synced(p, X);
  expect(await p.collab.openFromRoster(X, "Plans")).toBe(true);
  await b.service.progress(await pair(p, b, "edit"));
  await pair(p, c, "edit");
  expect((await p.service.remove(me(b), 1n, "Old phone")).kind).not.toBe("stop");
  // P may not change X's key: A, its owner, does, and the server refuses C's new key.
  await synced(a, X);
  const before = epochs(X);
  const latest = BigInt(before);
  refusePackage(X, me(c), latest);
  const first = await a.service.upkeep();
  expect(epochs(X)).toBe(before + 1);
  expect(first.reconciled).toBe(false);
  expect(first.summary).toContain('A key could not be handed on in "Plans".');
  expect(hasKey(X, me(c), latest)).toBe(false);
  expect((await a.service.unfinished()).find((u) => u.kind === "handover")?.sections).toEqual([
    "Plans",
  ]);
  // The server recovers: the next ordinary upkeep hands C the key, with no other key change.
  world.server.fault = () => undefined;
  const second = await a.service.upkeep();
  expect(hasKey(X, me(c), latest)).toBe(true);
  expect(epochs(X)).toBe(before + 1);
  expect(second.summary).toBe('Handed on the new key of "Plans".');
  expect((await a.service.unfinished()).filter((u) => u.kind === "handover")).toEqual([]);
  expect((await a.service.upkeep(true)).summary).toBe("Nothing to finish.");
});
