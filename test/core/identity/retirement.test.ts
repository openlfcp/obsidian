// sdk-ts 0.5.0 (IDENTITY-PROFILE-01 §7.1 step 4, §8.2): the plugin's
// identity document port has the `retirement` capability, so marking a
// device removed writes its `revoked` flag alone and sees every concurrent
// value of it. A concurrent rename of the device stays a conflict for the
// person to settle; neither "Remove device…" nor the upkeep resolves it.
// The model is sdk-ts conformance/identity/replica-flows.test.ts, here on
// the plugin's own stack (DeviceService, its document port, the in-memory
// coordinator).

import {
  fetchDeks,
  type IdentityAuthor,
  type IdentityDocumentPort,
  identityWriterClass,
  loadIdentityDocument,
  principalRefOf,
  sealIdentityUnit,
  syncChain,
} from "@openlfcp/client";
import { fromHex, type PrincipalId, type ResourceId, toHex } from "@openlfcp/core";
import { IdentityReplica, identityCodec } from "@openlfcp/shared-objects/identity";
import { afterEach, expect, it, vi } from "vitest";
import { identityDocument } from "../../../src/core/identity/document";
import { DeviceWorld, type Installation, pair, WORLD_URL } from "../../support/device-world";

// Several installations and a coordinator per test, on the real SDK flows: slower than a unit.
vi.setConfig({ testTimeout: 60_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const me = (i: Installation) =>
  fromHex(toHex(i.runtime.collaborationContext()?.principal.id ?? new Uint8Array())) as PrincipalId;

/** A port over a bare IdentityReplica: the test reads every concurrent value of a field with it. */
function replicaReader(resource: ResourceId, root: PrincipalId) {
  const replica = IdentityReplica.empty({ resource, root });
  const writer = (a: IdentityAuthor) => ({
    signer: a.signer,
    actorSeq: a.actorSeq,
    writerClass: a.writerClass,
  });
  const map = <T>(o: Readonly<Record<string, T>>) => new Map(Object.entries(o));
  const port: IdentityDocumentPort = {
    write: (author, intents) => identityCodec.encode(replica.write(writer(author), intents)),
    receive: (plaintext, author) => {
      const r = replica.receive(plaintext, writer(author));
      return r.admitted.length + r.duplicates.length > 0;
    },
    initialized: () => replica.validate().usable && replica.heads().length > 0,
    roster: () => map(replica.validate().roster),
    devices: () => map(replica.validate().devices),
    requests: () => map(replica.validate().requests),
    origins: (table, key) => replica.origins(table, key),
  };
  return { port, replica };
}

/** The device list as installation `who` reads it from the coordinator, through `doc`. */
async function open(who: Installation, I: ResourceId, doc: IdentityDocumentPort) {
  const flow = world.flowOf(who);
  const channel = await world.server.network().connect(flow.installation.signer, WORLD_URL);
  const chain = await syncChain(flow.storage, channel, I);
  const deks = await fetchDeks(flow.storage, flow.secrets, channel, chain, flow.installation);
  const load = await loadIdentityDocument({ channel, chain, deks, doc });
  return { flow, channel, chain, deks, doc, load };
}

/** A person with three devices: A (first), B (Full, renames too) and C (the one removed). */
async function threeDevices() {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const c = await world.installation();
  await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await c.service.progress(await pair(a, c, "edit"));
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  const root = world.server.chain(I).state.owner.principalId;
  const key = principalRefOf(me(c));
  /** Every value of C's label and of its `revoked` flag, read by A from the coordinator. */
  const values = async () => {
    const reader = replicaReader(I, root);
    await open(a, I, reader.port);
    expect(reader.replica.validate().problems).toEqual([]);
    return {
      label: [...reader.replica.fieldValues("devices", key, "label")].sort(),
      revoked: reader.replica.fieldValues("devices", key, "revoked"),
    };
  };
  /** A and B rename C concurrently: each writes from a view that does not hold the other's change. */
  const renameConcurrently = async () => {
    const views = [
      { view: await open(a, I, identityDocument(I, root)), label: "alpha" },
      { view: await open(b, I, identityDocument(I, root)), label: "beta" },
    ];
    for (const { view, label } of views) {
      const entry = view.doc.devices().get(key);
      if (entry === undefined) throw new Error("no device entry");
      const bytes = await sealIdentityUnit({
        storage: view.flow.storage,
        chain: view.chain,
        deks: view.deks,
        signer: view.flow.installation.signer,
        doc: view.doc,
        latest: view.load.latest,
        intents: [{ intent: "device.put", key, entry: { ...entry, label } }],
      });
      expect((await view.channel.putDataUnit(I, bytes)).kind).toBe("ack");
    }
    expect(await values()).toEqual({ label: ["alpha", "beta"], revoked: [] });
  };
  return { a, c, I, root, key, values, renameConcurrently };
}

it("the plugin's document port reads every value of revoked and writes the flag alone", async () => {
  const { a, I, root, key, renameConcurrently } = await threeDevices();
  await renameConcurrently();
  const { doc, chain, flow } = await open(a, I, identityDocument(I, root));
  expect(doc.retirement).toBeDefined();
  expect(doc.retirement?.revokedValues(key)).toEqual([]);
  // A write that only retires: the label conflict is in the document after it.
  const reader = replicaReader(I, root);
  await open(a, I, reader.port);
  const signer = flow.installation.signer.descriptor.principalId;
  const author: IdentityAuthor = {
    signer,
    actorSeq: 1_000_000n,
    writerClass: identityWriterClass(chain.state, root, signer),
  };
  const plaintext = doc.retirement?.write(author, [], [key]);
  expect(plaintext).toBeInstanceOf(Uint8Array);
  expect(doc.retirement?.revokedValues(key)).toEqual([true]);
  expect(reader.port.receive(plaintext as Uint8Array, author)).toBe(true);
  expect([...reader.replica.fieldValues("devices", key, "label")].sort()).toEqual([
    "alpha",
    "beta",
  ]);
  expect(reader.replica.fieldValues("devices", key, "revoked")).toEqual([true]);
});

it("removing a device whose name is in conflict marks it removed and keeps the conflict (§8.2)", async () => {
  const { a, c, values, renameConcurrently } = await threeDevices();
  await renameConcurrently();
  const view = await a.service.remove(toHex(me(c)), 1n, "Tablet");
  expect(view).toMatchObject({ kind: "done" });
  expect(await values()).toEqual({ label: ["alpha", "beta"], revoked: [true] });
});

it("the upkeep that marks a removed device after a refused write keeps its name conflict (§7.1 step 4)", async () => {
  const { a, c, I, values, renameConcurrently } = await threeDevices();
  await renameConcurrently();
  // The removal's write to the device list is refused: the flag is not set.
  world.server.fault = (e) =>
    e.op === "data-unit" && toHex(e.resource) === toHex(I)
      ? { nack: "AUTHORIZATION_FAILED" }
      : undefined;
  const view = await a.service.remove(toHex(me(c)), 1n, "Tablet");
  world.server.fault = () => undefined;
  expect(view.kind).toBe("retry");
  expect((await values()).revoked).toEqual([]);
  // "Finish now" (the upkeep, forced) restores the display data: the flag alone.
  await a.service.upkeep(true);
  expect(await values()).toEqual({ label: ["alpha", "beta"], revoked: [true] });
});
