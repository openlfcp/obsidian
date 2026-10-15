// One flow per key at a time (F-03, F-C04): a second start meanwhile does
// nothing and is handed the running flow, which reveals its open dialog or
// says where it stands (LFCP-03-002); the key is free again once the first
// settles, also when it threw.

import { describe, expect, it, vi } from "vitest";
import { type Flow, InFlight, type Reconciled } from "../../src/core/in-flight";

describe("InFlight", () => {
  it("a second run under the same key meanwhile does nothing; another key runs", async () => {
    const f = new InFlight();
    let release = () => {};
    const ran: string[] = [];
    const busy: string[] = [];
    const first = f.run(
      "note:A.md",
      () => busy.push("A"),
      () =>
        new Promise<string>((r) => {
          ran.push("A1");
          release = () => r("done");
        }),
    );
    expect(f.busy("note:A.md")).toBe(true);
    expect(
      await f.run(
        "note:A.md",
        () => busy.push("A"),
        async () => ran.push("A2"),
      ),
    ).toBe(undefined);
    await f.run(
      "note:B.md",
      () => busy.push("B"),
      async () => ran.push("B1"),
    );
    release();
    expect(await first).toBe("done");
    expect(ran).toEqual(["A1", "B1"]);
    expect(busy).toEqual(["A"]);
    await f.run(
      "note:A.md",
      () => busy.push("A"),
      async () => ran.push("A3"),
    );
    expect(ran.at(-1)).toBe("A3");
  });

  it("a flow that throws frees its key", async () => {
    const f = new InFlight();
    await expect(
      f.run(
        "k",
        () => {},
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(f.busy("k")).toBe(false);
  });

  it("a second start is handed the running flow: its open dialog while shown, else its stage", async () => {
    const f = new InFlight();
    const seen: string[] = [];
    const busy = (running: Flow) => {
      if (!running.reveal()) seen.push(`stage: ${running.stage}`);
    };
    let step = () => {};
    const first = f.run(
      "note:1",
      busy,
      (flow) =>
        new Promise<void>((done) => {
          flow.showing(() => seen.push("preview brought forward"));
          step = () => {
            flow.showing(null);
            flow.stage = "creating";
            step = done;
          };
        }),
      "starting",
    );
    await f.run("note:1", busy, async () => seen.push("second flow"));
    step();
    await f.run("note:1", busy, async () => seen.push("second flow"));
    step();
    await first;
    expect(seen).toEqual(["preview brought forward", "stage: creating"]);
  });

  it("D12: an unknown outcome keeps the key until a reconcile settles it; one check at a time", async () => {
    const f = new InFlight();
    const closed: string[] = [];
    let answer: (r: Reconciled) => void = () => undefined;
    let fail: (e: Error) => void = () => undefined;
    let checks = 0;
    await f.run(
      "note:1",
      () => undefined,
      async (flow) => {
        flow.unresolved("being checked", () => {
          checks++;
          return new Promise<Reconciled>((r, x) => {
            answer = r;
            fail = x;
          });
        });
      },
      "starting",
      () => closed.push("closed"),
    );
    const flow = f.get("note:1") as Flow;
    expect(flow.unknown).toBe(true);
    expect(flow.stage).toBe("being checked");
    // A repeated start is handed the flow and checks it; a check meanwhile joins that one.
    const ran: string[] = [];
    await f.run(
      "note:1",
      (running) => void running.check(),
      async () => ran.push("second"),
    );
    const joined = flow.check();
    expect(checks).toBe(1);
    expect(flow.checking).toBe(true);
    answer("unknown");
    await joined;
    expect(f.busy("note:1")).toBe(true);
    // A reconcile that throws leaves it unknown.
    const failing = flow.check();
    expect(checks).toBe(2);
    fail(new Error("offline"));
    await failing;
    expect(f.busy("note:1")).toBe(true);
    expect(closed).toEqual([]);
    // Settled: closed once, the key free; a new run is a new flow.
    const settle = flow.check();
    answer("settled");
    await settle;
    expect(f.busy("note:1")).toBe(false);
    expect(closed).toEqual(["closed"]);
    expect(ran).toEqual([]);
    await f.run(
      "note:1",
      () => undefined,
      async () => ran.push("later"),
    );
    expect(ran).toEqual(["later"]);
  });

  it("late callbacks on a closed flow are ignored: its dialog, stage, check and generation", async () => {
    const f = new InFlight();
    let kept: Flow | undefined;
    await f.run(
      "k",
      () => undefined,
      async (flow) => {
        kept = flow;
      },
    );
    const flow = kept as Flow;
    expect(flow.closed).toBe(true);
    let revealed = false;
    flow.showing(() => {
      revealed = true;
    });
    expect(flow.reveal()).toBe(false);
    expect(revealed).toBe(false);
    flow.stage = "late";
    expect(flow.stage).toBe("running");
    flow.unresolved("late", async () => "settled");
    expect(flow.unknown).toBe(false);
    await flow.check();
    expect(f.byGeneration(flow.generation)).toBeUndefined();
    // A new flow under the same key is another generation.
    await f.run(
      "k",
      () => undefined,
      async (next) => {
        expect(next.generation).not.toBe(flow.generation);
        expect(f.byGeneration(next.generation)).toBe(next);
      },
    );
  });

  it("an unknown outcome's check is bounded: it says so, stays unknown, and a later check joins it (LFCP-03-017)", async () => {
    vi.useFakeTimers();
    try {
      const f = new InFlight(1000);
      let calls = 0;
      let answer: (r: Reconciled) => void = () => undefined;
      let kept: Flow | undefined;
      await f.run(
        "note:A.md",
        () => undefined,
        async (flow) => {
          kept = flow;
          flow.unresolved("being checked", () => {
            calls++;
            return new Promise<Reconciled>((r) => {
              answer = r;
            });
          });
        },
      );
      const flow = kept as Flow;
      let late = 0;
      const first = flow.check(() => late++);
      expect(flow.checking).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      await first;
      // No answer in time: said once, still unknown, the key still held.
      expect(late).toBe(1);
      expect(flow.checking).toBe(false);
      expect(flow.unknown).toBe(true);
      expect(f.busy("note:A.md")).toBe(true);
      // A second check while the first reconcile still runs joins it: nothing runs again.
      const second = flow.check(() => late++);
      expect(calls).toBe(1);
      answer("settled");
      await second;
      expect(late).toBe(1);
      expect(flow.closed).toBe(true);
      expect(f.busy("note:A.md")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late settle of a timed-out check still frees the key", async () => {
    vi.useFakeTimers();
    try {
      const f = new InFlight(1000);
      let answer: (r: Reconciled) => void = () => undefined;
      let kept: Flow | undefined;
      await f.run(
        "k",
        () => undefined,
        async (flow) => {
          kept = flow;
          flow.unresolved(
            "being checked",
            () =>
              new Promise<Reconciled>((r) => {
                answer = r;
              }),
          );
        },
      );
      const flow = kept as Flow;
      const check = flow.check();
      await vi.advanceTimersByTimeAsync(1000);
      await check;
      expect(flow.unknown).toBe(true);
      answer("settled");
      await vi.advanceTimersByTimeAsync(0);
      expect(flow.closed).toBe(true);
      expect(f.busy("k")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unfinished flow holds its key; its resume waits for the user, with no time limit", async () => {
    vi.useFakeTimers();
    try {
      const f = new InFlight(1000);
      let approve: (r: Reconciled) => void = () => undefined;
      let kept: Flow | undefined;
      await f.run(
        "k",
        () => undefined,
        async (flow) => {
          kept = flow;
          flow.unresolved(
            "unfinished",
            () =>
              new Promise<Reconciled>((r) => {
                approve = r;
              }),
            "unfinished",
          );
        },
      );
      const flow = kept as Flow;
      expect(flow.unfinished).toBe(true);
      expect(flow.unknown).toBe(false);
      expect(flow.held).toBe(true);
      expect(f.busy("k")).toBe(true);
      let late = 0;
      const resume = flow.check(() => late++);
      await vi.advanceTimersByTimeAsync(5000);
      expect(late).toBe(0);
      expect(flow.checking).toBe(true);
      approve("settled");
      await resume;
      expect(flow.closed).toBe(true);
      expect(f.busy("k")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
