// The sessions' restartable reconnect backoff, and the runtime connecting a
// disconnected session at once when the network comes back (window
// "online"), offline sockets standing in for the network.

import { afterEach, describe, expect, it } from "vitest";
import {
  cappedReconnect,
  RECONNECT_CAP_MS,
  restartableReconnect,
} from "../../../src/core/lfcp/reconnect";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";

/** The policy without jitter (random 0.5: the nominal wait). */
const nominal = () => cappedReconnect(() => 0.5);

describe("the plugin's reconnect policy (soak finding #8)", () => {
  it("waits 1 s, doubling, at most 15 s, for ever", () => {
    const p = nominal();
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((a) => p(a))).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000,
    ]);
    expect(RECONNECT_CAP_MS).toBe(15_000);
  });

  it("puts each wait within ±20 % of its nominal value", () => {
    expect([1, 3, 9].map((a) => cappedReconnect(() => 0)(a))).toEqual([800, 3_200, 12_000]);
    expect([1, 3, 9].map((a) => cappedReconnect(() => 0.999999)(a))).toEqual([
      1_200, 4_800, 18_000,
    ]);
    // Never past 18 s, whatever the attempt and the draw.
    const p = cappedReconnect();
    for (let a = 1; a < 200; a++) {
      const w = p(a) as number;
      expect(w).toBeGreaterThanOrEqual(800);
      expect(w).toBeLessThanOrEqual(18_000);
    }
  });
});

describe("the restartable reconnect backoff", () => {
  it("is the plugin's policy until restarted, then waits as from the first attempt", () => {
    const r = restartableReconnect(nominal());
    const waits = [1, 2, 3, 4, 5, 6, 7].map((a) => r.policy(a));
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    r.restart();
    expect([8, 9, 10].map((a) => r.policy(a))).toEqual([1_000, 2_000, 4_000]);
  });

  it("is the jittered, capped policy by default", () => {
    const w = restartableReconnect().policy(10) as number;
    expect(w).toBeGreaterThanOrEqual(12_000);
    expect(w).toBeLessThanOrEqual(18_000);
  });

  it("follows the SDK counting again from 1 after a session was ready", () => {
    const r = restartableReconnect(nominal());
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
