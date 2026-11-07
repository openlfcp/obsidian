// Decision I18 (LFCP-04-414): the pace of the device flows. The dialogs'
// backoff, the token bucket every connection of one installation's device
// flows takes from, and the device service using it.

import { describe, expect, it } from "vitest";
import {
  ConnectionPacer,
  DEVICE_FLOW_PACING,
  POLL_BACKOFF_MS,
  pollDelay,
} from "../../../src/core/identity/pacing";
import { DeviceWorld, pair } from "../../support/device-world";

describe("the dialogs' backoff", () => {
  it("is 4 s, 8 s, 15 s, then 30 s for good", () => {
    expect(POLL_BACKOFF_MS).toEqual([4000, 8000, 15_000, 30_000]);
    expect([0, 1, 2, 3, 4, 50].map(pollDelay)).toEqual([
      4000, 8000, 15_000, 30_000, 30_000, 30_000,
    ]);
  });
});

/** A clock that moves only when the pacer sleeps. */
function clock() {
  let now = 0;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ConnectionPacer", () => {
  it("gives a burst at once, then one token per 60/perMinute s, in order", async () => {
    const c = clock();
    const p = new ConnectionPacer({ burst: 3, perMinute: 6, now: c.now, sleep: c.sleep });
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4, 5].map((i) => p.take().then(() => order.push(i))));
    expect(order).toEqual([1, 2, 3, 4, 5]);
    // Three at once; the fourth and fifth 10 s apart.
    expect(c.slept).toEqual([10_000, 10_000]);
    expect(p.taken).toBe(5);
    expect(p.waitedMs).toBe(20_000);
  });

  it("refills with time, never above the burst", async () => {
    const c = clock();
    const p = new ConnectionPacer({ burst: 2, perMinute: 6, now: c.now, sleep: c.sleep });
    await p.take();
    await p.take();
    c.advance(600_000);
    await p.take();
    await p.take();
    expect(c.slept).toEqual([]);
    await p.take();
    expect(c.slept).toEqual([10_000]);
  });

  it("the default keeps two installations within a server's 20 a minute", () => {
    expect(DEVICE_FLOW_PACING.burst * 2).toBeLessThan(20);
    expect(DEVICE_FLOW_PACING.perMinute * 2).toBeLessThan(20);
  });
});

describe("the device service paces every connection of its flows", () => {
  it("a pairing waits for its turn instead of opening connections at once", async () => {
    const world = new DeviceWorld();
    try {
      // A clock that stands still: no token comes back with the time the flows
      // take (on a slow runner 100 ms of work would refill one at 600 a
      // minute), so every connection beyond the burst waits, whatever the speed.
      const a = await world.installation({}, { burst: 2, perMinute: 600, now: () => 0 });
      const b = await world.installation();
      await a.section("Plans");
      await b.service.progress(await pair(a, b));
      const pacer = a.service.pacer;
      if (pacer === null) throw new Error("no pacer");
      // Beyond the burst of two: the managing device's flows waited for their
      // tokens, each one 60/600 s.
      expect(pacer.taken).toBeGreaterThan(2);
      expect(pacer.waitedMs).toBe((pacer.taken - 2) * 100);
    } finally {
      await world.stop();
    }
  });
});
