// LFCP-065: the runtime's collaboration context, the SDK inputs of the
// hosting, invitation and join flows.

import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal } from "../../support/lfcp-env";

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

describe("LfcpRuntime.collaborationContext (LFCP-065)", () => {
  it("is the ready install's Principal, storage and pooled sessions; null once stopped", async () => {
    const device = new Device();
    const runtime = await LfcpRuntime.start(device.env(new FakeLocal()));
    running.push(runtime);
    const status = runtime.status;
    if (status.kind !== "ready") throw new Error(status.kind);
    const context = runtime.collaborationContext();
    expect(context?.principal.id).toEqual(status.principalId);
    expect(context?.storage).toBe(runtime.storage);
    const url = "wss://offline.example.invalid/v1/ws";
    expect(context?.session(url)).toBe(context?.session(url));
    expect(runtime.sessions).toBe(1);
    await runtime.stop();
    expect(runtime.collaborationContext()).toBeNull();
  });
});
