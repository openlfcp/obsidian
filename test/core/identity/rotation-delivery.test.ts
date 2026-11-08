// Holistic review of MVP 0.4, F1 and F2 (Shared Tasks 0.7.3, sdk-ts 0.5.1):
// the device upkeep on the SDK's own flows over the in-memory coordinator.
//
// F1: a key the upkeep hands on after an earlier key change (#handOver, the
// SDK's resumed rotations, #rotate) is sealed through the device list's
// removals (IDENTITY-PROFILE-01 §7.1 step 1): never to a device the person
// removed, nor to one whose chain passes through it, even while a section
// still counts it as active. Every KEY_PACKAGE_PUT of the upkeep is checked.
//
// F2: a key change committed by reconciliation whose new key is not handed
// on (a crash after the key was adopted, before the first package; a
// dropped connection during delivery) is listed as a handover, for another
// person's device too, and is finished by the next ordinary upkeep without
// another key change (§§8.2, 9.1, 9.2, 9.5).

import { deliverKeys, heldDeks, PackageLedger, pendingDekRef, syncChain } from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import type { SecretRef, SecretStore } from "@openlfcp/storage";
import { decodeControlRecord, parseKeyPackage, signControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { SDK_IDENTITY_FLOWS } from "../../../src/core/identity/flows";
import { DeviceService } from "../../../src/core/identity/service";
import { DeviceWorld, type Installation, pair, WORLD_URL } from "../../support/device-world";
import { sleep } from "../../support/lfcp-env";

vi.setConfig({ testTimeout: 60_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const epochs = (R: ResourceId) => world.server.chain(R).state.epochs.size;
const me = (i: Installation) =>
  toHex(i.runtime.collaborationContext()?.principal.id ?? new Uint8Array());

async function synced(i: Installation, R: ResourceId): Promise<void> {
  const ctx = i.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  const channel = await world.server.network().connect(ctx.principal.signer, WORLD_URL);
  await syncChain(ctx.storage, channel, R);
}

/** The recipients (hex) of every Key Package uploaded to X from upload index `from` on. */
const sealedTo = (X: ResourceId, from: number) =>
  world.server.uploads
    .slice(from)
    .filter((e) => e.op === "key-package" && toHex(e.resource) === toHex(X))
    .map((e) => toHex(parseKeyPackage(e.bytes).payload.recipient));

const hasKey = (X: ResourceId, recipient: string, epoch: bigint) =>
  world.server.packagesOf(X).some((p) => toHex(p.recipient) === recipient && p.dataEpoch === epoch);

type Fault = ReturnType<DeviceWorld["server"]["fault"]>;
type Upload = Parameters<DeviceWorld["server"]["fault"]>[0];

/** X refuses the package of `epoch` to each of `recipients` (hex) while `on()`. */
const refusingPackage =
  (X: ResourceId, recipients: readonly string[], epoch: bigint, on: () => boolean) =>
  (e: Upload): Fault => {
    if (!on() || e.op !== "key-package" || toHex(e.resource) !== toHex(X)) return undefined;
    const p = parseKeyPackage(e.bytes).payload;
    return recipients.includes(toHex(p.recipient)) && p.dataEpoch === epoch
      ? { nack: "QUOTA_EXCEEDED" }
      : undefined;
  };

/** X refuses the DEVICE_REVOKE of `device` (hex): as at the limit of W §17.5 rule 5. */
const refusingRevocation =
  (X: ResourceId, device: string) =>
  (e: Upload): Fault => {
    if (e.op !== "control" || toHex(e.resource) !== toHex(X)) return undefined;
    const b = decodeControlRecord(e.bytes).body;
    return b.type === "DEVICE_REVOKE" && toHex(b.device) === device
      ? { nack: "AUTHORIZATION_FAILED" }
      : undefined;
  };

const both =
  (...faults: ((e: Upload) => Fault)[]) =>
  (e: Upload): Fault => {
    for (const f of faults) {
      const r = f(e);
      if (r !== undefined) return r;
    }
    return undefined;
  };

/**
 * A (the first device), B (full: it pairs E), C and F (edit), all readers of
 * A's section X. F retires itself; A's upkeep changes X's key, and the server
 * refuses the new key to C, B and E: the key change owes it to them
 * (OWED_KEY), B and E included, before B is removed.
 */
async function owedKeyChange() {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const c = await world.installation();
  const e = await world.installation();
  const f = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await c.service.progress(await pair(a, c, "edit"));
  await f.service.progress(await pair(a, f, "edit"));
  // E's chain passes through B: B approved it.
  await e.service.progress(await pair(b, e, "edit"));
  await a.service.upkeep(true);
  await f.service.remove(me(f), 0n, "Tablet");
  await synced(a, X);
  const before = epochs(X);
  const epoch = BigInt(before);
  let refusing = true;
  world.server.fault = refusingPackage(X, [me(c), me(b), me(e)], epoch, () => refusing);
  const first = await a.service.upkeep();
  expect(epochs(X)).toBe(before + 1);
  for (const x of [c, b, e]) expect(hasKey(X, me(x), epoch)).toBe(false);
  expect(first.summary).toContain('A key could not be handed on in "Plans".');
  const lift = () => {
    refusing = false;
  };
  return { a, b, c, e, X, epoch, lift, refused: world.server.fault };
}

it("F1: the upkeep's hand-over seals nothing to a device removed in the device list only, nor through it", async () => {
  const { a, b, c, e, X, epoch, lift } = await owedKeyChange();
  // B is removed while X's server is down: X still counts B (and E through it) as active.
  world.server.down.add(toHex(X));
  expect((await a.service.remove(me(b), 1n, "Old phone")).kind).not.toBe("stop");
  world.server.down.delete(toHex(X));
  // And X refuses B's revocation: it stays unpropagated through the whole upkeep.
  world.server.fault = refusingRevocation(X, me(b));
  lift();
  expect(hasKey(X, me(b), epoch)).toBe(false);
  const from = world.server.uploads.length;
  await a.service.upkeep();
  const sealed = sealedTo(X, from);
  // The eligible reader the key change owed receives its key, without another key change.
  expect(hasKey(X, me(c), epoch)).toBe(true);
  // Every KEY_PACKAGE_PUT of the upkeep excludes B and E.
  expect(sealed).not.toContain(me(b));
  expect(sealed).not.toContain(me(e));
  expect(hasKey(X, me(b), epoch)).toBe(false);
  expect(hasKey(X, me(e), epoch)).toBe(false);
});

it("F1: a key change first filtered by reconciliation, then resumed by the upkeep, keeps the filter", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const c = await world.installation();
  const e = await world.installation();
  const f = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await c.service.progress(await pair(a, c, "edit"));
  await f.service.progress(await pair(a, f, "edit"));
  await e.service.progress(await pair(b, e, "edit"));
  await a.service.upkeep(true);
  // B is removed in the device list only (X unreachable), and X refuses its revocation.
  world.server.down.add(toHex(X));
  expect((await a.service.remove(me(b), 1n, "Old phone")).kind).not.toBe("stop");
  world.server.down.delete(toHex(X));
  // F retires itself: an exposing revocation in X. Reconciliation changes X's key, sealing
  // nothing to B (SDK filter); the server refuses C's new key, which stays owed.
  await f.service.remove(me(f), 0n, "Tablet");
  await synced(a, X);
  const before = epochs(X);
  const epoch = BigInt(before);
  let refusing = true;
  world.server.fault = both(
    refusingRevocation(X, me(b)),
    refusingPackage(X, [me(c)], epoch, () => refusing),
  );
  const first = await a.service.upkeep();
  expect(first.reconciled).toBe(true);
  expect(epochs(X)).toBe(before + 1);
  expect(hasKey(X, me(c), epoch)).toBe(false);
  expect(hasKey(X, me(b), epoch)).toBe(false);
  refusing = false;
  const from = world.server.uploads.length;
  await a.service.upkeep();
  expect(hasKey(X, me(c), epoch)).toBe(true);
  expect(epochs(X)).toBe(before + 1);
  const sealed = sealedTo(X, from);
  expect(sealed).not.toContain(me(b));
  expect(sealed).not.toContain(me(e));
});

class Crash extends Error {}

/** Secrets that crash the process right after a pending DEK slot of `X` is deleted. */
function crashingAfterAdoption(secrets: SecretStore, X: ResourceId): SecretStore {
  const prefix = String(pendingDekRef(X, "x")).slice(0, -1);
  return {
    put: (ref, value) => secrets.put(ref, value),
    get: (ref) => secrets.get(ref),
    delete: async (ref: SecretRef) => {
      await secrets.delete(ref);
      if (String(ref).startsWith(prefix)) throw new Crash("crash after the new key was adopted");
    },
  };
}

/**
 * A (first device, with a device list) owns X and shares it with another
 * person P (data/read and write, X's key sealed to P). A pairs B, which
 * retires itself: the next upkeep reconciles and changes X's key.
 */
async function sharedWithAnotherPerson(crash: { on: boolean }) {
  world = new DeviceWorld();
  // The section, once made: reconciliation crashes only on its key change.
  const made: { X?: ResourceId } = {};
  const a = await world.installation({
    reconcileDevices: (o: Parameters<typeof SDK_IDENTITY_FLOWS.reconcileDevices>[0]) =>
      SDK_IDENTITY_FLOWS.reconcileDevices(
        crash.on && made.X !== undefined
          ? { ...o, secrets: crashingAfterAdoption(o.secrets, made.X) }
          : o,
      ),
  });
  const p = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  made.X = X;
  const actx = a.runtime.collaborationContext();
  const pctx = p.runtime.collaborationContext();
  if (actx === null || pctx === null) throw new Error("not ready");
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
  await b.service.progress(await pair(a, b, "full"));
  await a.service.upkeep(true);
  await b.service.remove(me(b), 0n, "Phone");
  await synced(a, X);
  return { a, p, X };
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

const handover = async (s: DeviceService) =>
  (await s.unfinished()).filter((u) => u.kind === "handover").flatMap((u) => u.sections);

it("F2: a crash after the new key was adopted, before any package: the next upkeep hands it to the other person", async () => {
  const crash = { on: true };
  const { a, p, X } = await sharedWithAnotherPerson(crash);
  const before = epochs(X);
  const epoch = BigInt(before);
  const from = world.server.uploads.length;
  await expect(a.service.upkeep()).rejects.toThrow(Crash);
  crash.on = false;
  expect(epochs(X)).toBe(before + 1);
  expect(sealedTo(X, from)).toEqual([]);
  expect(hasKey(X, me(p), epoch)).toBe(false);
  // After the restart the handover is listed, the other person's device included.
  const service = restarted(a);
  expect(await handover(service)).toContain("Plans");
  const r = await service.upkeep();
  expect(hasKey(X, me(p), epoch)).toBe(true);
  expect(epochs(X)).toBe(before + 1);
  expect(r.handedOn).toContain(toHex(X));
  expect(await handover(service)).toEqual([]);
});

it("F2: a dropped connection while handing on the new key: listed until the next upkeep delivers it", async () => {
  const { a, p, X } = await sharedWithAnotherPerson({ on: false });
  const before = epochs(X);
  const epoch = BigInt(before);
  let dropping = true;
  world.server.fault = (e) =>
    dropping &&
    e.op === "key-package" &&
    toHex(e.resource) === toHex(X) &&
    toHex(parseKeyPackage(e.bytes).payload.recipient) === me(p) &&
    parseKeyPackage(e.bytes).payload.dataEpoch === epoch
      ? "drop-request"
      : undefined;
  await a.service.upkeep();
  expect(epochs(X)).toBe(before + 1);
  expect(hasKey(X, me(p), epoch)).toBe(false);
  expect(await handover(a.service)).toContain("Plans");
  // Still failing: listed again, no other key change.
  await a.service.upkeep();
  expect(epochs(X)).toBe(before + 1);
  expect(await handover(restarted(a))).toContain("Plans");
  dropping = false;
  await a.service.upkeep();
  expect(hasKey(X, me(p), epoch)).toBe(true);
  expect(epochs(X)).toBe(before + 1);
  expect(await handover(a.service)).toEqual([]);
});

it("F1: while the device list is forked, the upkeep hands no key on its behalf", async () => {
  const { a, b, X, epoch, lift } = await owedKeyChange();
  lift();
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  const ctx = a.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  // The device list's chain stored as a conflict (§9.7), as syncChain stores a fork.
  const control = ctx.storage.control;
  const forked = new Proxy(control, {
    get: (target, key) =>
      key === "conflict"
        ? (r: ResourceId) =>
            toHex(r) === toHex(I) ? Promise.resolve({ heads: [] }) : target.conflict(r)
        : (Reflect.get(target, key, target) as (...x: unknown[]) => unknown).bind(target),
  });
  const service = new DeviceService({
    runtime: () => a.runtime,
    context: () => ({
      ...ctx,
      storage: new Proxy(ctx.storage, {
        get: (target, key) => {
          if (key === "control") return forked;
          const v = Reflect.get(target, key, target) as unknown;
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      }),
    }),
    collab: () => a.collab,
    defaultServer: () => WORLD_URL,
    platform: "desktop",
    sections: true,
    sleep,
    pacing: null,
    flows: { ...SDK_IDENTITY_FLOWS, connectionNetwork: () => world.server.network() },
  });
  const from = world.server.uploads.length;
  const r = await service.upkeep();
  expect(sealedTo(X, from)).toEqual([]);
  expect(r.issues.some((i) => i.resource === toHex(X) && i.kind === "conflict")).toBe(true);
  expect(hasKey(X, me(b), epoch)).toBe(false);
});
