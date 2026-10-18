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
});
