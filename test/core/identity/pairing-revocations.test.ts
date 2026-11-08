// sdk-ts 0.5.0 (IDENTITY-PROFILE-01 §7.1 step 1, §8.4; MVP 0.4 final
// review): every pairing session ends with its pairing device revoked in
// the device list, and that revocation is no longer carried into each
// shared section. Before, every finished session added a DEVICE_REVOKE to
// every section the person shares, each taking one of the 64 records a
// section keeps for devices never added there (LFCP-WIRE-01 §17.5 rule 5);
// enough pairings filled that limit and a removed device could then no
// longer be revoked in that section. A removal still revokes the device in
// every section where it was added.

import type { ResourceId } from "@openlfcp/core";
import { fromHex, type PrincipalId, toHex } from "@openlfcp/core";
import { revocationOf } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceWorld, type Installation, pair } from "../../support/device-world";

// Several installations and a coordinator per test, on the real SDK flows: slower than a unit.
vi.setConfig({ testTimeout: 60_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const me = (i: Installation) =>
  fromHex(toHex(i.runtime.collaborationContext()?.principal.id ?? new Uint8Array())) as PrincipalId;

/** The DEVICE_REVOKE records of a Resource's Control Chain on the coordinator. */
const revokes = (R: ResourceId) =>
  world.server
    .chain(R)
    .records.filter((r) => r.body.type === "DEVICE_REVOKE")
    .map((r) => r.body as { readonly device: PrincipalId });

/** A person shares two sections, pairs two devices and cancels a third link; every upkeep runs. */
async function pairedThrice() {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const c = await world.installation();
  const X = await a.section("Plans");
  const Y = await a.section("Errands");
  await b.service.progress(await pair(a, b, "full"));
  await c.service.progress(await pair(a, c, "edit"));
  const open = await a.service.startSession("Desk");
  if (open.kind !== "link") throw new Error(open.message);
  expect((await a.service.cancel(open.session)).kind).not.toBe("stop");
  // Finish now on both managing devices: reconciliation runs on every section.
  await a.service.upkeep(true);
  await b.service.upkeep(true);
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  return { a, b, c, I, X, Y };
}

it("pairing devices adds no revocation to a shared section (§7.1 step 1)", async () => {
  const { b, c, I, X, Y } = await pairedThrice();
  // The three pairing devices are revoked in the device list...
  expect(revokes(I).length).toBe(3);
  // ...and in no section, while both new devices were added to each.
  for (const R of [X, Y]) {
    expect(revokes(R)).toEqual([]);
    const devices = world.server.chain(R).state.devices;
    expect(devices.has(toHex(me(b)))).toBe(true);
    expect(devices.has(toHex(me(c)))).toBe(true);
  }
  // A second upkeep has nothing more to carry there.
  expect((await b.service.upkeep(true)).summary).toContain("up to date");
  for (const R of [X, Y]) expect(revokes(R)).toEqual([]);
});

it("removing a device still revokes it in every section it was added to (§8.4)", async () => {
  const { a, c, I, X, Y } = await pairedThrice();
  const view = await a.service.remove(toHex(me(c)), 1n, "Tablet");
  expect(view).toMatchObject({ kind: "done" });
  expect(view.message).not.toContain("later");
  for (const R of [I, X, Y]) {
    const root = world.server.chain(R).state.owner.principalId;
    expect(revocationOf(world.server.chain(R).state, root, me(c))).toBeDefined();
  }
  // In the sections, that is the only revocation: none for the pairing devices.
  for (const R of [X, Y]) expect(revokes(R).map((r) => toHex(r.device))).toEqual([toHex(me(c))]);
});
