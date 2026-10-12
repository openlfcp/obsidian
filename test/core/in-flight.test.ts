// One flow per key at a time (F-03, F-C04): a second start meanwhile is told
// so and does nothing; the key is free again once the first settles, also
// when it threw.

import { describe, expect, it } from "vitest";
import { InFlight } from "../../src/core/in-flight";

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
});
