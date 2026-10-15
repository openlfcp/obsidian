// Own work a Key Epoch cut off, re-applied (§19.1, stale-work.ts), on the
// fake port: the order and IDs of the re-apply, never twice (a restart in
// the middle), a node changed meanwhile or a refusal going to review, Keep
// and Discard, no access (it waits), the guard set at once, and a scan at
// start.

import { describe, expect, it } from "vitest";
import type { SectionIntent } from "../../../src/core/sections/port";
import {
  MemoryStaleWorkStore,
  type OwnOperation,
  reapplyId,
  reapplyStale,
  StaleWorkController,
  staleLabel,
  touchedNodes,
} from "../../../src/core/sections/stale-work";
import { FakeSectionPort } from "./fake-port";

const R = "res";
const title = (id: string, t: string) =>
  ({ intent: "task.set_title", id, title: t }) as unknown as SectionIntent;
const op = (n: number, intents: SectionIntent[], before: Record<string, string>): OwnOperation => ({
  operationId: `op-${n}`,
  resource: R,
  unitIds: [`u${n}`],
  intents,
  before,
  at: n,
});

/** A port, a store with recorded ops cut off, and the model's fingerprints (settable). */
async function setup(ops: OwnOperation[]) {
  const port = new FakeSectionPort();
  const store = new MemoryStaleWorkStore();
  for (const o of ops) await store.recordOwn(o);
  let prints: Record<string, string> = {};
  for (const o of ops) Object.assign(prints, o.before);
  const deps = {
    port,
    store,
    fingerprints: (_r: string, ids: readonly string[]) =>
      Object.fromEntries(ids.map((id) => [id, prints[id] ?? ""])),
  };
  return {
    port,
    store,
    deps,
    set: (p: Record<string, string>) => {
      prints = { ...prints, ...p };
    },
  };
}

describe("cutting own operations off", () => {
  it("marks the operations of the cut units stale, once; others stay", async () => {
    const s = await setup([
      op(1, [title("a", "A1")], { a: "fp-a" }),
      op(2, [title("b", "B1")], { b: "fp-b" }),
    ]);
    expect((await s.store.cut(R, ["u2", "other"])).map((o) => o.operationId)).toEqual(["op-2"]);
    expect(await s.store.cut(R, ["u2"])).toEqual([]);
    expect((await s.store.open(R)).map((o) => [o.operationId, o.state])).toEqual([
      ["op-2", "pending"],
    ]);
  });

  it("names what an operation did", () => {
    expect(staleLabel({ intents: [title("a", "Beta retitled")] })).toBe(
      'task title "Beta retitled"',
    );
    expect(
      staleLabel({
        intents: [
          { intent: "node.move", id: "a", parent: "s", after: null },
          {
            intent: "task.create_in_section",
            task: { id: "t", title: "Delta" },
            parent: "s",
            after: null,
          } as unknown as SectionIntent,
        ],
      }),
    ).toBe('a move, new task "Delta"');
    expect(
      touchedNodes([{ intent: "node.move", id: "a", parent: "s", after: null }, title("b", "x")]),
    ).toEqual(["a", "b"]);
  });
});

describe("re-applying", () => {
  it("in commit order, each under its fixed re-apply ID; then done", async () => {
    const s = await setup([
      op(1, [title("a", "A1")], { a: "fp-a" }),
      op(2, [title("b", "B1")], { b: "fp-b" }),
    ]);
    await s.store.cut(R, ["u2", "u1"]);
    const r = await reapplyStale(s.deps, R);
    expect(r).toEqual({ done: ["op-1", "op-2"], review: [], waiting: false });
    expect(s.port.changes.map((c) => c.operationId)).toEqual([
      reapplyId("op-1"),
      reapplyId("op-2"),
    ]);
    expect(await s.store.open(R)).toEqual([]);
  });

  it("never twice: a restart after the commit, before 'done', finds the receipt", async () => {
    const s = await setup([op(1, [title("a", "A1")], { a: "fp-a" })]);
    await s.store.cut(R, ["u1"]);
    s.port.fail({ kind: "crash-after" });
    const first = await reapplyStale(s.deps, R);
    // The commit happened; the crash came after it: its receipt says so.
    expect(first.done).toEqual(["op-1"]);
    expect(s.port.changes).toHaveLength(1);
    // A pending state left by a crash before "done" is put back: a second run writes nothing.
    await s.store.put({ ...op(1, [title("a", "A1")], { a: "fp-a" }), state: "pending" });
    await reapplyStale(s.deps, R);
    expect(s.port.changes).toHaveLength(1);
  });

  it("an unknown outcome without a receipt waits for the next run, still pending", async () => {
    const s = await setup([op(1, [title("a", "A1")], { a: "fp-a" })]);
    await s.store.cut(R, ["u1"]);
    s.port.fail({ kind: "crash-before" });
    expect(await reapplyStale(s.deps, R)).toMatchObject({ done: [], review: [], waiting: true });
    expect((await s.store.open(R)).map((o) => o.state)).toEqual(["pending"]);
    expect((await reapplyStale(s.deps, R)).done).toEqual(["op-1"]);
  });

  it("a node changed meanwhile (someone else's edit came first) goes to review, not sent", async () => {
    const s = await setup([op(1, [title("a", "A1")], { a: "fp-a" })]);
    await s.store.cut(R, ["u1"]);
    s.set({ a: "fp-a-changed-remotely" });
    expect(await reapplyStale(s.deps, R)).toEqual({ done: [], review: ["op-1"], waiting: false });
    expect(s.port.changes).toEqual([]);
    expect((await s.store.open(R))[0]).toMatchObject({ state: "review", reason: "changed" });
    // Keep: sent again as it was, causally after the other edit.
    expect((await reapplyStale(s.deps, R, new Set(["op-1"]))).done).toEqual(["op-1"]);
    expect(s.port.changes.map((c) => c.operationId)).toEqual([reapplyId("op-1")]);
  });

  it("a refused commit goes to review with its code", async () => {
    const s = await setup([op(1, [title("a", "A1")], { a: "fp-a" })]);
    await s.store.cut(R, ["u1"]);
    s.port.fail({ kind: "refuse", code: "INVALID_PREDECESSOR" });
    expect((await reapplyStale(s.deps, R)).review).toEqual(["op-1"]);
    expect((await s.store.open(R))[0]).toMatchObject({
      state: "review",
      reason: "INVALID_PREDECESSOR",
    });
  });

  it("without write access it waits, pending, and sends nothing", async () => {
    const s = await setup([op(1, [title("a", "A1")], { a: "fp-a" })]);
    await s.store.cut(R, ["u1"]);
    s.port.access = { allowed: false, reason: "unknown" };
    expect(await reapplyStale(s.deps, R)).toEqual({
      done: [],
      review: [],
      waiting: true,
      reason: "no write access (unknown)",
    });
    expect(s.port.changes).toEqual([]);
    expect((await s.store.open(R)).map((o) => o.state)).toEqual(["pending"]);
  });
});

describe("the controller", () => {
  const controller = async (
    ops: OwnOperation[],
    quarantined: string[] = [],
    queued: string[] = [],
  ) => {
    const s = await setup(ops);
    const changed: string[] = [];
    /** The counts the status reads at each change announced. */
    const seen: { pending: number; review: number }[] = [];
    const lookups = { unit: 0, quarantined: 0, queued: 0 };
    const c = new StaleWorkController({
      store: s.store,
      port: {
        commit: (r, i, o) => s.port.commit(r, i, o),
        canWrite: (r) => s.port.canWrite(r),
        receiptOf: (r, o) => s.port.receiptOf(r, o),
        exclusive: (_r, fn) => fn(),
        fingerprints: (r, ids) => s.deps.fingerprints(r, ids),
      },
      unit: async (u) => {
        lookups.unit++;
        return { quarantined: quarantined.includes(u), queued: queued.includes(u) };
      },
      quarantined: async () => {
        lookups.quarantined++;
        return [...quarantined];
      },
      queued: async () => {
        lookups.queued++;
        return [...queued];
      },
      changed: (r) => {
        changed.push(r);
        seen.push(c.counts(r));
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
    });
    return { ...s, c, changed, seen, lookups };
  };

  it("guards the Resource at once on a cut, then re-applies and lets its notes pass", async () => {
    const s = await controller([op(1, [title("a", "A1")], { a: "fp-a" })]);
    expect(s.c.waiting(R)).toBe(false);
    s.c.epochReconciled(R, ["u1"]);
    // Synchronously: no pass of the rebuilt model can run before the store answers.
    expect(s.c.waiting(R)).toBe(true);
    expect(s.c.counts(R).pending).toBeGreaterThan(0);
    for (let i = 0; i < 20 && s.c.waiting(R); i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.c.waiting(R)).toBe(false);
    expect(s.port.changes.map((c) => c.operationId)).toEqual([reapplyId("op-1")]);
    expect(s.changed).toContain(R);
  });

  it("a cut of units that are not this device's lifts the guard and changes nothing", async () => {
    const s = await controller([op(1, [title("a", "A1")], { a: "fp-a" })]);
    s.c.epochReconciled(R, ["someone-else"]);
    for (let i = 0; i < 20 && s.c.waiting(R); i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.c.waiting(R)).toBe(false);
    expect(s.port.changes).toEqual([]);
  });

  it("offline: the work waits, guarded; once live it goes on", async () => {
    const s = await controller([op(1, [title("a", "A1")], { a: "fp-a" })]);
    s.port.access = { allowed: false, reason: "unknown" };
    s.c.epochReconciled(R, ["u1"]);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.c.waiting(R)).toBe(true);
    expect(s.c.counts(R)).toEqual({ pending: 1, review: 0 });
    s.port.access = { allowed: true };
    s.c.live(R);
    for (let i = 0; i < 20 && s.c.waiting(R); i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.c.waiting(R)).toBe(false);
    expect(s.port.changes).toHaveLength(1);
  });

  it("a pass that comes before the Key Epoch's event: check() finds the quarantined unit and waits", async () => {
    const quarantined: string[] = [];
    const s = await controller([], quarantined, ["u1"]);
    await s.c.ownWork.recordOwn(op(1, [title("a", "A1")], { a: "fp-a" }));
    s.set({ a: "fp-a" });
    expect(await s.c.check(R)).toBe(false);
    quarantined.push("u1");
    expect(await s.c.check(R)).toBe(true);
    for (let i = 0; i < 20 && s.c.waiting(R); i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.port.changes.map((c) => c.operationId)).toEqual([reapplyId("op-1")]);
  });

  it("many units watched, none quarantined: one query a check, never one per unit", async () => {
    const ops = Array.from({ length: 100 }, (_, i) => op(i + 1, [title(`n${i}`, "x")], {}));
    const s = await controller(
      [],
      [],
      ops.flatMap((o) => o.unitIds),
    );
    for (const o of ops) await s.c.ownWork.recordOwn(o);
    for (let i = 0; i < 10; i++) expect(await s.c.check(R)).toBe(false);
    expect(s.lookups).toEqual({ unit: 0, quarantined: 10, queued: 0 });
    expect(s.c.diagnostics(R).unsettled).toBe(100);
  });

  it("units no longer queued (accepted) leave the watch, with one query now and then", async () => {
    const queued = ["u1", "u2", "u3"];
    const s = await controller([], [], queued);
    for (const n of [1, 2, 3]) await s.c.ownWork.recordOwn(op(n, [title(`n${n}`, "x")], {}));
    queued.splice(0, 2); // u1 and u2 accepted
    for (let i = 0; i < 40; i++) await s.c.check(R);
    expect(s.lookups.queued).toBe(1);
    expect(s.lookups.unit).toBe(0);
    expect(s.c.diagnostics(R).unsettled).toBe(1);
  });

  it("at start, own units found quarantined are cut and re-applied", async () => {
    const s = await controller(
      [op(1, [title("a", "A1")], { a: "fp-a" }), op(2, [title("b", "B1")], { b: "fp-b" })],
      ["u2"],
    );
    await s.c.scan(R);
    expect(s.port.changes.map((c) => c.operationId)).toEqual([reapplyId("op-2")]);
  });

  it("work gone to review is announced: the last status read shows it in review, not pending (LFCP-03-036)", async () => {
    // Nothing else re-applied: no "done" to announce it along with.
    const s = await controller([op(1, [title("a", "A1")], { a: "fp-a" })]);
    s.set({ a: "changed" });
    s.c.epochReconciled(R, ["u1"]);
    for (let i = 0; i < 20 && s.c.counts(R).review < 1; i++)
      await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 10));
    expect(s.c.counts(R)).toEqual({ pending: 0, review: 1 });
    // The card is drawn from the status read at the last change: never "being sent again".
    expect(s.seen.at(-1)).toEqual({ pending: 0, review: 1 });
  });

  it("the guard lifted with the work still waiting: the real pending count is announced", async () => {
    const s = await controller([
      op(1, [title("a", "A1")], { a: "fp-a" }),
      op(2, [title("b", "B1")], { b: "fp-b" }),
    ]);
    s.port.access = { allowed: false, reason: "unknown" };
    s.c.epochReconciled(R, ["u1", "u2"]);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.c.counts(R)).toEqual({ pending: 2, review: 0 });
    expect(s.seen.at(-1)).toEqual({ pending: 2, review: 0 });
  });

  it("Review conflicts: Keep sends it again, Discard drops it; either lets the notes pass", async () => {
    const s = await controller([
      op(1, [title("a", "A1")], { a: "fp-a" }),
      op(2, [title("b", "B1")], { b: "fp-b" }),
    ]);
    s.set({ a: "changed", b: "changed" });
    s.c.epochReconciled(R, ["u1", "u2"]);
    for (let i = 0; i < 20 && s.c.counts(R).review < 2; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(s.c.counts(R)).toEqual({ pending: 0, review: 2 });
    expect(s.c.review(R).map((o) => o.operationId)).toEqual(["op-1", "op-2"]);
    expect(await s.c.resolve(R, "op-1", true)).toBe("Sent again.");
    expect(await s.c.resolve(R, "op-2", false)).toBe(
      "Discarded: your note shows the shared version.",
    );
    expect(s.port.changes.map((c) => c.operationId)).toEqual([reapplyId("op-1")]);
    expect(s.c.waiting(R)).toBe(false);
  });
});
