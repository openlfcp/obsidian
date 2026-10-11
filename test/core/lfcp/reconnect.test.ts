// The sessions' restartable reconnect backoff, and the runtime connecting a
// disconnected session at once when the network comes back (window
// "online"), offline sockets standing in for the network.

import { defaultReconnect } from "@openlfcp/client";
import { afterEach, describe, expect, it } from "vitest";
import { restartableReconnect } from "../../../src/core/lfcp/reconnect";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";

describe("the restartable reconnect backoff", () => {
  it("is the SDK's policy until restarted, then waits as from the first attempt", () => {
    const r = restartableReconnect();
    const waits = [1, 2, 3, 4, 5, 6, 7].map((a) => r.policy(a));
    expect(waits).toEqual([1, 2, 3, 4, 5, 6, 7].map((a) => defaultReconnect(a)));
    expect(waits.at(-1)).toBe(60_000);
    r.restart();
    expect([8, 9, 10].map((a) => r.policy(a))).toEqual([1_000, 2_000, 4_000]);
  });

  it("follows the SDK counting again from 1 after a session was ready", () => {
    const r = restartableReconnect();
    for (const a of [1, 2, 3, 4]) r.policy(a);
    r.restart();
    expect([1, 2].map((a) => r.policy(a))).toEqual([1_000, 2_000]);
  });
});

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

describe("the network coming back", () => {
  it("connects a disconnected session at once, not at the end of its backoff", async () => {
    const device = new Device();
    const r = await LfcpRuntime.start(device.env(new FakeLocal()));
    running.push(r);
    const R = await r.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await r.openSection(R);
    const attempts = () => device.sockets.opened.filter((o) => o.url === URL).length;
    await sleep(50);
    // The first attempt failed; the next one waits a second.
    expect(attempts()).toBe(1);
    r.networkBack();
    expect(attempts()).toBe(2);
  });

  it("without a session, nothing happens", async () => {
    const device = new Device();
    const r = await LfcpRuntime.start(device.env(new FakeLocal()));
    running.push(r);
    r.networkBack();
    expect(device.sockets.opened).toEqual([]);
  });
});
