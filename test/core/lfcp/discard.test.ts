// A section Resource discarded before it was hosted (runtime.discardUnhosted,
// F-03): never sent, its rows and Data Epoch keys are deleted
// (deleteUnsentResource) and its discarded mark goes; one that may have
// been sent (RESOURCE_SENT) stays, marked, as before; a stop between the
// mark and the deletion leaves it marked, and the next start deletes it.

import { hash32, type ResourceId, toHex } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});
const start = async (device: Device, local: FakeLocal) => {
  const r = await LfcpRuntime.start(device.env(local));
  running.push(r);
  return r;
};

/** A device with a section Resource made and never sent, and the secret slots it added. */
async function made() {
  const device = new Device();
  const local = new FakeLocal();
  const r = await start(device, local);
  const before = new Set(device.slots.values.keys());
  const R = await r.createSectionResource({ name: "Plan", endpoints: [URL], coordinatorUrl: URL });
  const added = [...device.slots.values.keys()].filter((k) => !before.has(k));
  return { device, local, r, R, added, storage: r.storage as LfcpStorage };
}

/** Whether a secret slot holds a value (SlotSecretStore.delete empties it). */
const held = (device: Device, slot: string) => (device.slots.values.get(slot) ?? "") !== "";
const marked = (r: LfcpRuntime, R: ResourceId) =>
  r.localState.get(`resource-discarded:${toHex(R)}`);

describe("a section Resource discarded before it was hosted", () => {
  it("never sent: its rows and its Data Epoch key are deleted, and its mark goes", async () => {
    const { device, r, R, added, storage } = await made();
    expect(await storage.resources.get(R)).toBeDefined();
    expect(added).toHaveLength(1); // the epoch-0 DEK
    expect(await storage.control.epochs(R)).toHaveLength(1);
    await r.discardUnhosted(R);
    expect(await storage.resources.get(R)).toBeUndefined();
    expect((await storage.control.head(R)) ?? null).toBeNull();
    expect(await storage.control.epochs(R)).toEqual([]);
    expect(await storage.outbound.list(R)).toEqual([]);
    for (const slot of added) expect(held(device, slot)).toBe(false);
    expect(await marked(r, R)).toBeUndefined();
    expect((await r.registry()).map((e) => toHex(e.resourceId))).not.toContain(toHex(R));
    await expect(r.openSection(R)).rejects.toThrow("unknown Resource");
  });

  it("an open under way when it is discarded is closed with it, never left open", async () => {
    const { device, local, r, R } = await made();
    await r.stop();
    const again = await start(device, local);
    // The host opens the section at its start; a creation gives it up meanwhile.
    const [opened, discarded] = await Promise.allSettled([
      again.openSection(R),
      again.discardUnhosted(R),
    ]);
    expect(discarded.status).toBe("fulfilled");
    expect(opened.status).toBe("fulfilled");
    expect(again.sectionProfile(R)).toBeUndefined();
    expect((await again.registry()).map((e) => toHex(e.resourceId))).not.toContain(toHex(R));
  });

  it("the local Principal's keys stay: another Resource made afterwards works", async () => {
    const { r, R } = await made();
    await r.discardUnhosted(R);
    const again = await r.createSectionResource({
      name: "Plan",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    expect((await r.registry()).map((e) => toHex(e.resourceId))).toEqual([toHex(again)]);
    expect(await r.openSection(again)).toBeDefined();
  });

  it("maybe sent (an outbound item attempted): refused, it stays, marked, not listed or opened", async () => {
    const { device, r, R, added, storage } = await made();
    // Something of it was handed to a connection once (its first unit, say).
    await storage.commit([
      {
        op: "enqueue",
        item: {
          itemId: hash32(new Uint8Array(32).fill(5)),
          resourceId: R,
          kind: "data-unit",
          bytes: new Uint8Array([1]),
          attempts: 1,
          lastAttempt: new Date().toISOString(),
          nextAttempt: null,
          blocked: null,
        },
      },
    ]);
    await r.discardUnhosted(R);
    expect(await storage.resources.get(R)).toBeDefined();
    for (const slot of added) expect(held(device, slot)).toBe(true);
    expect(await marked(r, R)).toBe(true);
    expect((await r.registry()).map((e) => toHex(e.resourceId))).not.toContain(toHex(R));
    await expect(r.openSection(R)).rejects.toThrow("unknown Resource");
  });

  it("the deletion fails: it stays, marked; the next start deletes it", async () => {
    const { device, local, r, R, added, storage } = await made();
    const commit = storage.commit.bind(storage);
    storage.commit = async (writes) => {
      if (writes.some((w) => w.op === "delete-resource")) throw new Error("stopped");
      return commit(writes);
    };
    await r.discardUnhosted(R);
    storage.commit = commit;
    expect(await storage.resources.get(R)).toBeDefined();
    expect(await marked(r, R)).toBe(true);
    expect((await r.registry()).map((e) => toHex(e.resourceId))).not.toContain(toHex(R));
    // Restart: the discarded Resource, still stored, is deleted at start.
    await r.stop();
    const again = await start(device, local);
    const s = again.storage as LfcpStorage;
    expect(await s.resources.get(R)).toBeUndefined();
    expect(await s.control.epochs(R)).toEqual([]);
    for (const slot of added) expect(held(device, slot)).toBe(false);
    expect(await marked(again, R)).toBeUndefined();
  });

  it("stopped after the deletion, before the mark went: the start finds nothing to do", async () => {
    const { device, local, r, R, storage } = await made();
    const put = r.localState.put.bind(r.localState);
    r.localState.put = async (key, value) => {
      if (key === `resource-discarded:${toHex(R)}` && value === undefined)
        throw new Error("stopped");
      return put(key, value);
    };
    await expect(r.discardUnhosted(R)).rejects.toThrow("stopped");
    r.localState.put = put;
    expect(await storage.resources.get(R)).toBeUndefined();
    await r.stop();
    const again = await start(device, local);
    expect(await again.storage?.resources.get(R)).toBeUndefined();
    expect((await again.registry()).map((e) => toHex(e.resourceId))).not.toContain(toHex(R));
    await expect(again.openSection(R)).rejects.toThrow("unknown Resource");
  });

  it("a Resource not stored: a no-op", async () => {
    const { r, storage } = await made();
    const other = new Uint8Array(32).fill(9) as unknown as ResourceId;
    await r.discardUnhosted(other);
    expect(await storage.resources.list()).toHaveLength(1);
  });
});
