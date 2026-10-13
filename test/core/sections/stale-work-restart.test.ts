// A vault restarted in the middle of re-applying own offline work an
// access change cut off (coverage gap 5, stale-work.ts): a new controller
// on the same stores (the stale-work store, the SDK's receipts and its
// stored units) after the process stopped at each step: the units cut, an
// operation's commit made but not recorded, recorded done but its stale
// units not yet discarded, waiting in review. After the restart's scan the
// work is sent once, nothing is held for good, and the stale outbound items
// go.

import { describe, expect, it } from "vitest";
import type { SectionIntent } from "../../../src/core/sections/port";
import {
  MemoryStaleWorkStore,
  type OwnOperation,
  reapplyId,
  type StaleOperation,
  type StaleState,
  StaleWorkController,
} from "../../../src/core/sections/stale-work";
import { observedFacts } from "../../../src/core/status/facts";
import { statusView } from "../../../src/core/status/reducer";
import { FakeSectionPort } from "./fake-port";

const R = "res";
const title = (id: string, t: string) =>
  ({ intent: "task.set_title", id, title: t }) as unknown as SectionIntent;
const op = (n: number, node: string): OwnOperation => ({
  operationId: `op-${n}`,
  resource: R,
  unitIds: [`u${n}`],
  intents: [title(node, `T${n}`)],
  before: { [node]: `fp-${node}` },
  at: n,
});

class Crash extends Error {}

/** A stale-work store that stops the process right after an operation reaches `at`. */
class CrashingStore extends MemoryStaleWorkStore {
  at: StaleState | null = null;
  override async put(o: StaleOperation): Promise<void> {
    await super.put(o);
    if (o.state === this.at) {
      this.at = null;
      throw new Crash(`stopped at ${o.state}`);
    }
  }
}

/** One device: its durable stores, and a controller started on them (again). */
function device(ops: OwnOperation[]) {
  const port = new FakeSectionPort();
  const store = new CrashingStore();
  const prints: Record<string, string> = {};
  for (const o of ops) Object.assign(prints, o.before);
  /** The SDK's stored units: quarantined ones, and those whose outbound item is still queued. */
  const quarantined = new Set<string>();
  const queued = new Set<string>(ops.flatMap((o) => o.unitIds));
  const settled: string[] = [];
  const failures: unknown[] = [];
  const start = () =>
    new StaleWorkController({
      store,
      port: {
        commit: (r, i, o) => port.commit(r, i, o),
        canWrite: (r) => port.canWrite(r),
        receiptOf: (r, o) => port.receiptOf(r, o),
        exclusive: (_r, fn) => fn(),
        fingerprints: (_r, ids) => Object.fromEntries(ids.map((id) => [id, prints[id] ?? ""])),
      },
      unit: async (u) => ({ quarantined: quarantined.has(u), queued: queued.has(u) }),
      changed: () => {},
      failed: (e) => void failures.push(e),
      settle: async (units) => {
        for (const u of units) {
          settled.push(u);
          queued.delete(u);
        }
      },
      setTimer: () => undefined,
    });
  return { port, store, prints, quarantined, queued, settled, failures, start };
}

/** Recorded, then cut off by a Key Epoch: the SDK quarantined them. */
async function cutOff(d: ReturnType<typeof device>, ops: OwnOperation[]) {
  for (const o of ops) await d.store.recordOwn(o);
  for (const o of ops) for (const u of o.unitIds) d.quarantined.add(u);
}

const settledFor = async (c: StaleWorkController) => {
  for (let i = 0; i < 20 && c.waiting(R); i++) await new Promise((r) => setTimeout(r, 2));
};

describe("a restart in the middle of a stale-work re-apply", () => {
  it("after the guard, before the cut was stored: the scan cuts and re-applies, once", async () => {
    const ops = [op(1, "a")];
    const d = device(ops);
    await cutOff(d, ops);
    // The event came, the process stopped before the store had the cut.
    await d.start().scan(R);
    expect(d.port.changes.map((c) => c.operationId)).toEqual([reapplyId("op-1")]);
    expect(d.settled).toEqual(["u1"]);
    const again = d.start();
    await again.scan(R);
    expect(d.port.changes).toHaveLength(1);
    expect(again.waiting(R)).toBe(false);
  });

  it("cut and pending: the scan re-applies it", async () => {
    const ops = [op(1, "a")];
    const d = device(ops);
    await cutOff(d, ops);
    d.port.access = { allowed: false, reason: "unknown" };
    const first = d.start();
    first.epochReconciled(R, ["u1"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(first.counts(R)).toEqual({ pending: 1, review: 0 });
    // Restart, online.
    d.port.access = { allowed: true };
    const c = d.start();
    await c.scan(R);
    expect(d.port.changes.map((x) => x.operationId)).toEqual([reapplyId("op-1")]);
    expect(c.waiting(R)).toBe(false);
    expect(d.queued.size).toBe(0);
  });

  it("the commit made, the process stopped before it returned: the receipt is found, not sent twice", async () => {
    const ops = [op(1, "a")];
    const d = device(ops);
    await cutOff(d, ops);
    await d.store.cut(R, ["u1"]);
    d.port.fail({ kind: "crash-before" });
    // The commit failed before its transaction (no receipt): it waits.
    const first = d.start();
    await first.scan(R);
    expect(d.port.changes).toHaveLength(0);
    expect(first.counts(R).pending).toBe(1);
    // Now the transaction lands but the process stops right after.
    d.port.fail({ kind: "crash-after" });
    await d.start().scan(R);
    expect(d.port.changes).toHaveLength(1);
    const c = d.start();
    await c.scan(R);
    expect(d.port.changes).toHaveLength(1);
    expect(c.waiting(R)).toBe(false);
  });

  it("recorded done, stopped before its stale units were discarded: the restart discards them", async () => {
    const ops = [op(1, "a")];
    const d = device(ops);
    await cutOff(d, ops);
    await d.store.cut(R, ["u1"]);
    d.store.at = "done";
    await d
      .start()
      .scan(R)
      .catch((e) => {
        if (!(e instanceof Crash)) throw e;
      });
    expect(d.port.changes).toHaveLength(1);
    expect(d.settled).toEqual([]);
    const c = d.start();
    await c.scan(R);
    await settledFor(c);
    expect(d.port.changes).toHaveLength(1);
    expect(c.waiting(R)).toBe(false);
    // Its stale outbound item would count as an update waiting for good.
    expect(d.settled).toEqual(["u1"]);
    expect(d.queued.size).toBe(0);
  });

  it("the first of two re-applied, then stopped: the second only", async () => {
    const ops = [op(1, "a"), op(2, "b")];
    const d = device(ops);
    await cutOff(d, ops);
    await d.store.cut(R, ["u1", "u2"]);
    d.port.fail({ kind: "crash-after" });
    d.port.fail({ kind: "crash-before" });
    // op-1 lands (its receipt), op-2's commit fails before: it waits.
    await d.start().scan(R);
    const c = d.start();
    await c.scan(R);
    expect(d.port.changes.map((x) => x.operationId)).toEqual([
      reapplyId("op-1"),
      reapplyId("op-2"),
    ]);
    expect(c.waiting(R)).toBe(false);
  });

  it("waiting in review: still there after the restart, guarded; Keep sends it once", async () => {
    const ops = [op(1, "a")];
    const d = device(ops);
    await cutOff(d, ops);
    d.prints.a = "changed-remotely";
    const first = d.start();
    await first.scan(R);
    expect(first.counts(R)).toEqual({ pending: 0, review: 1 });
    const c = d.start();
    await c.scan(R);
    expect(c.counts(R)).toEqual({ pending: 0, review: 1 });
    expect(c.waiting(R)).toBe(true);
    expect(d.port.changes).toHaveLength(0);
    expect(await c.resolve(R, "op-1", true)).toBe("Sent again.");
    expect(d.port.changes).toHaveLength(1);
    expect(c.waiting(R)).toBe(false);
    expect(d.settled).toEqual(["u1"]);
  });

  it("Discard recorded, stopped before its stale units were discarded: the restart discards them", async () => {
    const ops = [op(1, "a")];
    const d = device(ops);
    await cutOff(d, ops);
    d.prints.a = "changed-remotely";
    const first = d.start();
    await first.scan(R);
    d.store.at = "discarded";
    await first.resolve(R, "op-1", false).catch((e) => {
      if (!(e instanceof Crash)) throw e;
    });
    expect(d.settled).toEqual([]);
    const c = d.start();
    await c.scan(R);
    expect(c.waiting(R)).toBe(false);
    expect(d.port.changes).toHaveLength(0);
    expect(d.settled).toEqual(["u1"]);
  });

  it("the card after such a restart: current, no update waiting for good", async () => {
    const ops = [op(1, "a")];
    const d = device(ops);
    await cutOff(d, ops);
    await d.store.cut(R, ["u1"]);
    d.store.at = "done";
    const first = d.start();
    await first.scan(R).catch((e) => {
      if (!(e instanceof Crash)) throw e;
    });
    /** The section's status as the host computes it, after a restart (the SDK knows no batch). */
    const status = (c: StaleWorkController) =>
      statusView(
        observedFacts({
          session: "s",
          load: { ready: true, loaded: true },
          phase: "LIVE",
          wasLive: true,
          problems: [],
          projections: [{ id: "p", source: "clean", application: "current" }],
          sdk: {
            revision: 3,
            batches: [],
            unconfirmed: new Set(),
            access: { allowed: true },
            accessCurrent: true,
            pendingControl: [],
            section: "ready",
            catchUp: "current-at-checkpoint",
            needsSnapshot: false,
          },
          queuedUnits: d.queued.size,
          settledOperations: c.settled(R),
          staleWork: c.counts(R),
        }),
      );
    // The re-applied work's stale item still queued: an update shown waiting.
    expect(status(first).state).not.toBe("CURRENT");
    const c = d.start();
    await c.scan(R);
    expect(status(c)).toMatchObject({ state: "CURRENT", pendingBatches: 0 });
  });
});
