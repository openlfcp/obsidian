// LFCP-03-058: two runs of one creation (the share's flow and the resume at
// the host's start) make the section Resource under its journaled ID at the
// same time. The second used to put its own Data Epoch key over the first's
// before its Genesis was refused: the Resource stayed, never writable ("the
// DEK is not the one committed for epoch 0"), and the share never finished.

import { generateObjectId, generateResourceId } from "@openlfcp/core";
import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

describe("createSectionResource twice at once under one ID", () => {
  it("makes one Resource with one key, and it can be written", async () => {
    const device = new Device();
    const r = await LfcpRuntime.start(device.env(new FakeLocal()));
    running.push(r);
    const R = generateResourceId();
    const before = new Set(device.slots.values.keys());
    const o = { name: "Plan", endpoints: [URL], coordinatorUrl: URL, resourceId: R };
    const [a, b] = await Promise.all([r.createSectionResource(o), r.createSectionResource(o)]);
    expect(a).toEqual(R);
    expect(b).toEqual(R);
    expect([...device.slots.values.keys()].filter((k) => !before.has(k))).toHaveLength(1);
    await r.openSection(R);
    const status = r.status;
    if (status.kind !== "ready") throw new Error("not ready");
    const receipt = await r.commitSection(
      R,
      [
        {
          intent: "section.create",
          sectionId: generateObjectId(),
          title: "Plan",
          createdBy: status.principalId,
        },
      ],
      { operationId: "op-1" },
    );
    expect(receipt.operationId).toBe("op-1");
  });

  // LFCP-03-063: a failure between the Control Chain and the Resource row. The
  // retry under the same ID used to make a new key, which does not match the
  // Genesis already saved, and the Resource was never stored ("not stored").
  it("a retry after a failure between the Genesis and the row finishes the same Resource with its own key", async () => {
    const device = new Device();
    const r = await LfcpRuntime.start(device.env(new FakeLocal()));
    running.push(r);
    const storage = r.storage;
    if (storage === null) throw new Error("no storage");
    const R = generateResourceId();
    const o = { name: "Plan", endpoints: [URL], coordinatorUrl: URL, resourceId: R };
    const commit = storage.commit.bind(storage);
    let cut = true;
    storage.commit = ((writes: Parameters<typeof commit>[0]) => {
      if (cut && writes.some((w) => w.op === "put-resource")) {
        cut = false;
        return Promise.reject(new Error("cut after the Genesis"));
      }
      return commit(writes);
    }) as typeof storage.commit;
    const before = new Set(device.slots.values.keys());
    await expect(r.createSectionResource(o)).rejects.toThrow("cut after the Genesis");
    const made = [...device.slots.values.keys()].filter((k) => !before.has(k));
    const key = device.slots.values.get(made[0] as string);
    expect(await storage.resources.get(R)).toBeUndefined();
    expect((await storage.control.head(R))?.controlSeq).toBe(0n);
    expect(await r.createSectionResource(o)).toEqual(R);
    // The same key: no second one was made, and the Resource can be written.
    expect([...device.slots.values.keys()].filter((k) => !before.has(k))).toEqual(made);
    expect(device.slots.values.get(made[0] as string)).toBe(key);
    expect(await r.sectionNeverShared(R)).toBe(true);
    await r.openSection(R);
    const status = r.status;
    if (status.kind !== "ready") throw new Error("not ready");
    const receipt = await r.commitSection(
      R,
      [
        {
          intent: "section.create",
          sectionId: generateObjectId(),
          title: "Plan",
          createdBy: status.principalId,
        },
      ],
      { operationId: "op-1" },
    );
    expect(receipt.operationId).toBe("op-1");
  });

  it("a Genesis whose stored key is another is left as it is, never given a new key", async () => {
    const device = new Device();
    const r = await LfcpRuntime.start(device.env(new FakeLocal()));
    running.push(r);
    const storage = r.storage;
    if (storage === null) throw new Error("no storage");
    const R = generateResourceId();
    const o = { name: "Plan", endpoints: [URL], coordinatorUrl: URL, resourceId: R };
    const commit = storage.commit.bind(storage);
    storage.commit = ((writes: Parameters<typeof commit>[0]) =>
      writes.some((w) => w.op === "put-resource")
        ? Promise.reject(new Error("cut after the Genesis"))
        : commit(writes)) as typeof storage.commit;
    const before = new Set(device.slots.values.keys());
    await expect(r.createSectionResource(o)).rejects.toThrow("cut after the Genesis");
    const [slot] = [...device.slots.values.keys()].filter((k) => !before.has(k));
    // Another key under the slot: the 0.4.1 race's state.
    const other = new Device();
    const r2 = await LfcpRuntime.start(other.env(new FakeLocal()));
    running.push(r2);
    await r2.createSectionResource({ ...o, resourceId: generateResourceId() });
    const wrong = [...other.slots.values.values()].at(-1) as string;
    device.slots.values.set(slot as string, wrong);
    storage.commit = commit;
    await expect(r.createSectionResource(o)).rejects.toThrow("the Resource was not stored");
    expect(device.slots.values.get(slot as string)).toBe(wrong);
    expect(await storage.resources.get(R)).toBeUndefined();
  });
});
