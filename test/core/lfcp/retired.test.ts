// "Delete earlier identity data…" (design 419 (b), decision I31): the
// install an earlier "Create a new identity" left behind is recorded, and
// deleting it blanks exactly its secret slots (recomputed from its own
// records, never by listing Obsidian's device-wide secret storage) and
// deletes its database. Another vault's slots and the new identity's stay.

import { afterEach, describe, expect, it } from "vitest";
import { databaseName, INSTALL_KEY } from "../../../src/core/lfcp/install";
import { RETIRED_KEY, retiredInstalls } from "../../../src/core/lfcp/retired";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { markerSlotId } from "../../../src/core/lfcp/secrets";
import { Device, deleteDatabase, FakeLocal } from "../../support/lfcp-env";

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

const start = async (device: Device, local: FakeLocal) => {
  const r = await LfcpRuntime.start(
    device.env(local, { deleteStorage: (name) => deleteDatabase(name) }),
  );
  running.push(r);
  return r;
};

/** The slot IDs holding a value now. */
const held = (device: Device) =>
  new Set([...device.slots.values].filter(([, v]) => v !== "").map(([k]) => k));

const databases = async () => (await indexedDB.databases()).map((d) => d.name);

/**
 * Vault B, then vault A with a section (a DEK), on one device; A's marker is
 * lost (locked), and a new identity replaces it. Returns the slot sets.
 */
async function retiredA(options: { loseDatabase?: boolean } = {}) {
  const device = new Device();
  const localB = new FakeLocal();
  await start(device, localB);
  const slotsB = held(device);
  const localA = new FakeLocal();
  const a = await start(device, localA);
  await a.createSectionResource({
    name: "Plans",
    endpoints: ["wss://example.test"],
    coordinatorUrl: "wss://example.test",
  });
  const oldId = localA.values.get(INSTALL_KEY) as string;
  const slotsOld = new Set([...held(device)].filter((s) => !slotsB.has(s)));
  await a.stop();
  running.splice(running.indexOf(a), 1);
  if (options.loseDatabase === true) await deleteDatabase(databaseName(oldId));
  else device.slots.set(markerSlotId(oldId), "");
  const locked = await start(device, localA);
  expect(locked.status.kind).toBe("locked");
  expect(locked.earlierIdentities()).toEqual([]);
  await locked.createNewPrincipal();
  expect(locked.status.kind).toBe("ready");
  const newId = localA.values.get(INSTALL_KEY) as string;
  const slotsNew = new Set([...held(device)].filter((s) => !slotsB.has(s) && !slotsOld.has(s)));
  return { device, localA, locked, oldId, newId, slotsB, slotsOld, slotsNew };
}

describe("earlier identity data (design 419 (b))", () => {
  it("records the retired install, then deletes its keys and database, and nothing else", async () => {
    const { device, locked, oldId, newId, slotsB, slotsOld, slotsNew } = await retiredA();
    expect(locked.earlierIdentities().map((r) => [r.installId, r.reason])).toEqual([
      [oldId, "marker-missing"],
    ]);
    expect(slotsOld.size).toBeGreaterThanOrEqual(4); // principal keys, DEK, local state key
    const valuesB = new Map([...slotsB].map((s) => [s, device.slots.values.get(s)]));
    const valuesNew = new Map([...slotsNew].map((s) => [s, device.slots.values.get(s)]));
    expect(await databases()).toContain(databaseName(oldId));
    const r = await locked.deleteEarlierIdentities();
    expect(r).toEqual({ kind: "deleted", count: 1 });
    // Every slot of the old install is blank; the marker too.
    for (const s of slotsOld) expect(device.slots.values.get(s) ?? "").toBe("");
    expect(device.slots.values.get(markerSlotId(oldId)) ?? "").toBe("");
    // Vault B's and the new identity's slots are untouched.
    for (const [s, v] of valuesB) expect(device.slots.values.get(s)).toBe(v);
    for (const [s, v] of valuesNew) expect(device.slots.values.get(s)).toBe(v);
    expect(await databases()).not.toContain(databaseName(oldId));
    expect(await databases()).toContain(databaseName(newId));
    expect(locked.earlierIdentities()).toEqual([]);
    // A second deletion finds nothing to do.
    expect(await locked.deleteEarlierIdentities()).toEqual({ kind: "none", count: 0 });
  });

  it("with the database already gone: partial, the principal keys and marker still blanked", async () => {
    const { device, locked, oldId, slotsOld } = await retiredA({ loseDatabase: true });
    expect(locked.earlierIdentities().map((r) => r.reason)).toEqual(["database-missing"]);
    const r = await locked.deleteEarlierIdentities();
    expect(r).toEqual({ kind: "partial", count: 1 });
    expect(device.slots.values.get(markerSlotId(oldId)) ?? "").toBe("");
    // The principal's keys are found from the marker's principal; the DEK slot of the
    // section, named only in the lost database, may remain (what "partial" says).
    const left = [...slotsOld].filter((s) => (device.slots.values.get(s) ?? "") !== "");
    expect(left.length).toBeLessThan(slotsOld.size);
    expect(await databases()).not.toContain(databaseName(oldId));
  });

  it("never deletes the current install, even when it is listed", async () => {
    const { localA, locked, newId } = await retiredA();
    localA.save(RETIRED_KEY, [
      ...retiredInstalls(localA),
      { installId: newId, principal: null, reason: null, retiredAt: 1 },
    ]);
    await expect(locked.deleteEarlierIdentities()).rejects.toThrow(/current install/);
    expect(locked.status.kind).toBe("ready");
  });
});
