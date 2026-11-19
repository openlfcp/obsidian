// E-022b (svc-1 R5, SERVICE-CONTROL-PROFILE-01 §7.4): the device upkeep and
// "Send keys again" open every control Resource C of the person's roster,
// archived ones included, pass this device's view of each to the SDK's
// reconciler (controlResources), and say why a kind-1 device's
// registration waits (TargetReconciliation.deferred). On the SDK's own
// identity flows over the in-memory coordinator.

import {
  createServiceControl,
  type IdentityFlowOptions,
  leafPayload,
  SyncClient,
  signChain,
  syncChain,
} from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import { decodeControlRecord, signControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { SERVICE_CONTROL_PROFILE_ID } from "../../../src/core/collab/profiles";
import { type IdentityFlows, SDK_IDENTITY_FLOWS } from "../../../src/core/identity/flows";
import { DeviceWorld, type Installation, pair, WORLD_URL } from "../../support/device-world";

vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const ctxOf = (i: Installation) => {
  const ctx = i.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  return ctx;
};

type ControlResources = Parameters<IdentityFlows["reconcileDevices"]>[0]["controlResources"];

/** The SDK's flows, recording the controlResources each reconciler run is given. */
function recording(seen: ControlResources[], archive = false): Partial<IdentityFlows> {
  return {
    reconcileDevices: (o) => {
      seen.push(o.controlResources);
      return SDK_IDENTITY_FLOWS.reconcileDevices(o);
    },
    resendKeys: (o) => {
      seen.push(o.controlResources);
      return SDK_IDENTITY_FLOWS.resendKeys(o);
    },
    // A roster whose control Resources are archived (IDENTITY §4 rule 6: it revokes nothing).
    ...(archive
      ? {
          loadIdentityDocument: async (o) => {
            const r = await SDK_IDENTITY_FLOWS.loadIdentityDocument(o);
            const roster = o.doc.roster.bind(o.doc);
            Object.assign(o.doc, {
              roster: () =>
                new Map(
                  [...roster()].map(([k, e]) => [
                    k,
                    e.profile === SERVICE_CONTROL_PROFILE_ID ? { ...e, archived: true } : e,
                  ]),
                ),
            });
            return r;
          },
        }
      : {}),
  };
}

/**
 * A (root, its device list made by pairing B) with section "Plans"; a
 * kind-1 device D with scope [Plans] granted in the device list but not
 * registered in the section yet; and, unless `control` is false, a control
 * Resource C created by A (its roster entry "Reminders bridge · MacBook Air").
 */
async function setup(o: { readonly control?: boolean; readonly archive?: boolean } = {}) {
  world = new DeviceWorld();
  const seen: ControlResources[] = [];
  const a = await world.installation(recording(seen, o.archive));
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  const f: IdentityFlowOptions = world.flowOf(a);
  let C: ResourceId | undefined;
  if (o.control !== false) {
    const created = await createServiceControl({ ...f, url: WORLD_URL, mac: "MacBook Air" });
    if (created.kind !== "created") throw new Error(`no C: ${JSON.stringify(created)}`);
    C = created.resource;
  }
  const d = ctxOf(await world.installation()).principal.signer.descriptor;
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  const channel = await f.network.connect(f.installation.signer, WORLD_URL);
  const i0 = await syncChain(f.storage, channel, I);
  const R = i0.state.owner.principalId;
  const grant = signControlRecord(
    { resourceId: I, controlSeq: i0.state.seq + 1n, prevControlId: i0.state.head },
    {
      type: "DEVICE_GRANT",
      root: R,
      chain: signChain(i0.state, f.installation.signer, leafPayload(R, d, 1, [1n, 2n], [X])),
    },
    f.installation.signer,
  );
  expect((await channel.putControl(I, i0.state.head, grant.bytes)).kind).toBe("ack");
  channel.close();
  return { a, X, C, D: toHex(d.principalId), seen };
}

/** Whether X's chain on the server registers device `hex`. */
const registered = (X: ResourceId, hex: string) =>
  world.server
    .chain(X)
    .records.map((r) => decodeControlRecord(r.signed.bytes).body)
    .some(
      (b) => b.type === "DEVICE_GRANT" && toHex(b.chain.leaf.payload.device.principalId) === hex,
    );

const WAITS =
  /is not added to "Plans" yet: it waits until "Reminders bridge · MacBook Air[^"]*" is up to date on this device\./;

it("the upkeep opens C, passes its view to the reconciler, and says why D waits", async () => {
  const { a, X, C, D, seen } = await setup();
  const r = await a.service.upkeep(true);
  expect(r.reconciled).toBe(true);
  // C is open on A for the gate, and the reconciler got this device's view of it.
  const port = a.runtime.controlPort(C as ResourceId);
  expect(port).toBeDefined();
  const given = seen.at(-1);
  expect(given).toBeDefined();
  expect(given?.(C as ResourceId)).toBe(port);
  // C is read only for the gate: not a section, not in the registry.
  expect((await a.runtime.registry()).map((e) => toHex(e.resourceId))).not.toContain(
    toHex(C as ResourceId),
  );
  // §7.4: C not synchronised here (no initial change yet) defers D's registration, said in words.
  expect(r.issues?.some((i) => i.kind === "deferred" && i.device === D)).toBe(true);
  expect(r.summary).toMatch(WAITS);
  expect(r.summary).not.toMatch(/control Resource|[0-9a-f]{64}/);
  expect(registered(X, D)).toBe(false);
});

it("an archived C is opened and gates too (§7.4: every C of the roster)", async () => {
  const { a, X, C, D, seen } = await setup({ archive: true });
  const r = await a.service.upkeep(true);
  expect(a.runtime.controlPort(C as ResourceId)).toBeDefined();
  expect(seen.at(-1)?.(C as ResourceId)).toBe(a.runtime.controlPort(C as ResourceId));
  expect(r.summary).toMatch(WAITS);
  expect(registered(X, D)).toBe(false);
});

it("without a C in the roster, D is registered as before", async () => {
  const { a, X, D, seen } = await setup({ control: false });
  const r = await a.service.upkeep(true);
  expect(seen.at(-1)).toBeDefined();
  expect(r.issues?.some((i) => i.kind === "deferred")).toBe(false);
  expect(registered(X, D)).toBe(true);
});

it("Send keys again passes the views and says why D waits", async () => {
  const { a, X, C, D, seen } = await setup();
  const text = await a.service.resendKeys(D, "MacBook Air");
  expect(seen.at(-1)?.(C as ResourceId)).toBe(a.runtime.controlPort(C as ResourceId));
  expect(text).toMatch(
    /"MacBook Air" is not added to "Plans" yet: it waits until "Reminders bridge · MacBook Air[^"]*" is up to date on this device\./,
  );
  expect(registered(X, D)).toBe(false);
});

/** What the runtime's sessions were given to open C, by spying on SyncClient.open. */
async function opensOf(C: ResourceId, run: () => Promise<unknown>) {
  const spy = vi.spyOn(SyncClient.prototype, "open");
  try {
    await run();
    return spy.mock.calls.map(([b]) => b).filter((b) => toHex(b.resourceId) === toHex(C));
  } finally {
    spy.mockRestore();
  }
}

it("two opens of C at once share one binding, the one the gate reads (review r1, 1)", async () => {
  const { a, C } = await setup();
  const R = C as ResourceId;
  const opens = await opensOf(R, () =>
    Promise.all([a.runtime.openControl(R, WORLD_URL), a.runtime.openControl(R, WORLD_URL)]),
  );
  expect(opens).toHaveLength(1);
  const port = a.runtime.controlPort(R);
  expect(port).toBeDefined();
  // A later open, and the upkeep's, keep that same view.
  expect(await opensOf(R, () => a.runtime.openControl(R, WORLD_URL))).toHaveLength(0);
  await a.service.upkeep(true);
  expect(a.runtime.controlPort(R)).toBe(port);
});

it("C is opened to be written by its manager, never as a Snapshot (E-022c; b review r1, 2)", async () => {
  const { a, C } = await setup();
  const R = C as ResourceId;
  const [binding, ...more] = await opensOf(R, () => a.runtime.openControl(R, WORLD_URL));
  expect(more).toEqual([]);
  expect(binding?.applier).toBeDefined();
  // SyncClient publishes a Snapshot only through binding.snapshot: none, so never one of C.
  expect(binding?.snapshot).toBeUndefined();
  // A3 writes through the commit binding (the write itself: live-control-approval.test.ts,
  // since no session reaches the coordinator in this world).
  expect(binding?.commit).toBeDefined();
});
