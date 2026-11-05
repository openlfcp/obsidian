// LFCP-04-413 (review obsidian#107): removing a device with the SDK's
// identity flows over the in-memory coordinator. What the result shows of
// each section's key change (§8.1, §8.4), and that an unfinished one can
// be finished (§9.1).

import { toHex } from "@openlfcp/core";
import { decodeControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceWorld, pair } from "../../support/device-world";

// Several installations and a coordinator per test, on the real SDK flows: slower than a unit.
vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const epochs = (w: DeviceWorld, R: Parameters<DeviceWorld["server"]["chain"]>[0]) =>
  w.server.chain(R).state.epochs.size;

it("a refused key change is shown, not hidden behind Removed, and Try again finishes it (P1-1)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  await pair(a, b);
  const phone = toHex(b.runtime.collaborationContext()?.principal.id ?? new Uint8Array());
  const before = epochs(world, X);
  // The coordinator refuses the section's new key (a quota), after accepting the revocation.
  world.server.fault = (e) =>
    e.op === "control" &&
    toHex(e.resource) === toHex(X) &&
    decodeControlRecord(e.bytes).body.type === "KEY_EPOCH"
      ? { nack: "QUOTA_EXCEEDED" }
      : undefined;
  const view = await a.service.remove(phone, 1n, "Phone");
  expect(view.kind).toBe("retry");
  expect(view.message).toContain('Removed "Phone"');
  expect(view.message).toContain('"Plans"');
  expect(view.message).toContain("QUOTA_EXCEEDED");
  expect(epochs(world, X)).toBe(before);
  // The refusal is lifted: Try again changes the key.
  world.server.fault = () => undefined;
  if (view.kind !== "retry") throw new Error(view.kind);
  const again = await a.service.remove(phone, 1n, "Phone", view.operation);
  expect(again).toMatchObject({ kind: "done" });
  expect(epochs(world, X)).toBe(before + 1);
});

it("a removed device is told it was removed, not sent to add devices from here (LFCP-04-414)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await a.section("Plans");
  await b.service.progress(await pair(a, b));
  const phone = toHex(b.runtime.collaborationContext()?.principal.id ?? new Uint8Array());
  // Still in the list: it adds devices from here.
  expect(await b.service.pairRefusal()).toContain("already in a device list");
  expect(await a.service.remove(phone, 0n, "Phone")).toMatchObject({ kind: "done" });
  const refusal = await b.service.pairRefusal();
  expect(refusal).toContain("This device was removed from your devices");
  expect(refusal).not.toContain("Add my other device");
  expect((await b.service.request("lfcp://pair/unused", "Phone")).kind).toBe("stop");
});

it("a device removed with its pairing unfinished is told it was removed, and stops waiting (R1)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  const op = await pair(a, b);
  // One section cannot be reached yet: approved, not finished; the request stays to resume.
  world.server.down.add(toHex(X));
  const first = await b.service.progress(op);
  expect(first).toMatchObject({ approved: true, final: false });
  expect((await b.service.openRequest())?.operation).toBe(op);
  expect(await b.service.pairRefusal()).toBeNull();
  world.server.down.delete(toHex(X));
  const phone = toHex(b.runtime.collaborationContext()?.principal.id ?? new Uint8Array());
  expect(await a.service.remove(phone, 1n, "Phone")).toMatchObject({ kind: "done" });
  // The resumed request ends with the removal, not an endless "Getting your sections…".
  const after = await b.service.progress(op);
  expect(after.final).toBe(true);
  expect(after.headline).toContain("This device was removed from your devices");
  expect(after.headline).toContain("new, empty vault");
  // The dialog (openRequest first, then pairRefusal) shows the removal, not the request.
  expect(await b.service.openRequest()).toBeNull();
  expect(await b.service.pairRefusal()).toContain("This device was removed from your devices");
  expect((await b.service.request("lfcp://pair/unused", "Phone")).kind).toBe("stop");
});
