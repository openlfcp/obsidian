// LFCP-04-413 (review obsidian#107 P2-4): re-certifying a device with the
// SDK's identity flows over the in-memory coordinator. Success is said only
// once the device list accepted the new certificate; the sections follow
// by reconciliation.

import type { ResourceId } from "@openlfcp/core";
import { toHex } from "@openlfcp/core";
import { decodeControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceWorld, type Installation, pair } from "../../support/device-world";

// Several installations and a coordinator per test, on the real SDK flows: slower than a unit.
vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const me = (i: Installation) =>
  toHex(i.runtime.collaborationContext()?.principal.id ?? new Uint8Array());
const issuers = (R: ResourceId, device: string) =>
  (world.server.chain(R).state.devices.get(device)?.issuers ?? []).map((e) => toHex(e));

/** A (first device) adds B (Full); B adds C: C's certificate passes through B. */
async function chainOfThree() {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const c = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await c.service.progress(await pair(b, c, "edit"));
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  return { a, b, c, X, I };
}

it("a certificate the device list refuses is not a re-certification (P2-4)", async () => {
  const { a, b, c, I } = await chainOfThree();
  expect(issuers(I, me(c))).toEqual([me(b)]);
  world.server.fault = (e) =>
    e.op === "control" &&
    toHex(e.resource) === toHex(I) &&
    decodeControlRecord(e.bytes).body.type === "DEVICE_GRANT"
      ? { nack: "QUOTA_EXCEEDED" }
      : undefined;
  const text = await a.service.recertify([me(c)]);
  expect(text).toContain("was not re-certified");
  expect(text).toContain("QUOTA_EXCEEDED");
  expect(text).not.toContain("is re-certified");
  expect(issuers(I, me(c))).toEqual([me(b)]);
});

it("an accepted certificate is said, and reaches the sections (P2-4)", async () => {
  const { a, b, c, X, I } = await chainOfThree();
  expect(issuers(X, me(c))).toEqual([me(b)]);
  const text = await a.service.recertify([me(c)]);
  expect(text).toMatch(/is re-certified in your device list\.$/);
  expect(issuers(I, me(c))).toEqual([]);
  expect(issuers(X, me(c))).toEqual([]);
});

it("a section not reached now is said as later, not as done (P2-4)", async () => {
  const { a, c, X, I } = await chainOfThree();
  world.server.down.add(toHex(X));
  const text = await a.service.recertify([me(c)]);
  expect(text).toContain("is re-certified in your device list.");
  expect(text).toContain('Not reached yet, done later: "Plans".');
  expect(issuers(I, me(c))).toEqual([]);
});
