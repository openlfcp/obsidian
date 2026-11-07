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
