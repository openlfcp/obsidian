// LFCP-03-048, ADR 0002 design 2: the sweep of the bases of notes that are
// gone. What it must never do (remove the base of a note that exists, touch a
// candidate, act on a vault that is not loaded, trust a clock that jumped,
// leave a half-done state after a stop) and what it does (remove after 30
// days, close the unfinished operations, drop the bases of a Resource that
// left). Real stores over an in-memory key-value with a key listing.

import { describe, expect, it } from "vitest";
import { diagnosticReport } from "../../../src/core/diagnostics";
import { collectDiagnostics } from "../../../src/core/diagnostics-collect";
import type { JournalEntry } from "../../../src/core/sections/journal";
import {
  expired,
  knownResources,
  MIN_OBSERVED_DAYS,
  MISSING_TTL_MS,
  missingNoteStats,
  NOTE_DELETED,
  observed,
  sweepDue,
  sweepMissingNotes,
} from "../../../src/core/sections/missing-notes";
import { adoptedBase } from "../../../src/core/sections/repair";
import {
  type KeyValue,
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { id, PLAN, shared } from "../../support/section-vaults";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);

/** An in-memory KeyValue with a listing; `stopAt` makes the Nth write throw (a stop). */
function memoryKv() {
  const m = new Map<string, unknown>();
  const state = { writes: 0, stopAt: Number.POSITIVE_INFINITY };
  const write = (k: string, v: unknown) => {
    if (++state.writes === state.stopAt) throw new Error("stopped");
    m.set(k, v);
  };
  const kv: KeyValue = {
    get: async (k) => m.get(k),
    put: async (k, v) => write(k, v),
    update: async (k, f) => write(k, f(m.get(k))),
    keys: async (prefix) =>
      [...m]
        .filter(([k, v]) => k.startsWith(prefix) && v !== null && v !== undefined)
        .map(([k]) => k),
  };
  return { kv, state, raw: m };
}

const snap = { revision: "r", nodes: {}, order: {} } as never;

async function world() {
  const { kv, state, raw } = memoryKv();
  const bases = new KeyValueSectionBaseStore(kv);
  const journal = new KeyValueSectionJournalStore(kv);
  const notes = new Set<string>(["Other.md"]);
  let now = T0;
  const env = (over: Partial<Parameters<typeof sweepMissingNotes>[0]> = {}) => ({
    kv,
    bases,
    journal,
    exists: (p: string) => notes.has(p),
    noteCount: () => notes.size,
    resources: new Set([PLAN.R]) as ReadonlySet<string> | null,
    now: () => now,
    ...over,
  });
  const sweep = (over?: Partial<Parameters<typeof sweepMissingNotes>[0]>) =>
    sweepMissingNotes(env(over));
  /** One sweep a day for `days` days. */
  const daily = async (days: number) => {
    for (let i = 0; i < days; i++) {
      now += DAY;
      await sweep();
    }
  };
  const base = (path: string, ref = PLAN.ref) => adoptedBase(path, ref, snap);
  return {
    kv,
    state,
    raw,
    bases,
    journal,
    notes,
    sweep,
    daily,
    base,
    setNow: (t: number) => (now = t),
    now: () => now,
  };
}

const entry = (
  operationId: string,
  projectionId: string,
  phase: JournalEntry["phase"],
): JournalEntry => ({
  operationId,
  projectionId,
  resource: PLAN.R,
  phase,
  sourceHash: "h",
  allocatedIds: {},
});

describe("the clock rules of the marks", () => {
  it("a note must be missing for 30 days and seen so on 7 different days", () => {
    let m = observed(undefined, T0);
    expect(expired(m, T0 + 40 * DAY)).toBe(false);
    for (let d = 1; d < MIN_OBSERVED_DAYS; d++) m = observed(m, T0 + d * DAY);
    expect(m.days).toBe(MIN_OBSERVED_DAYS);
    expect(expired(m, T0 + MISSING_TTL_MS - 1)).toBe(false);
    expect(expired(m, T0 + MISSING_TTL_MS)).toBe(true);
  });

  it("a clock set back starts again; the same day counts once", () => {
    const m = observed(undefined, T0 + 10 * DAY);
    expect(observed(m, T0 + 10 * DAY + 1000).days).toBe(1);
    expect(observed(m, T0)).toEqual({ since: T0, lastDay: Math.floor(T0 / DAY), days: 1 });
  });
});

describe("the sweep of the bases of missing notes (LFCP-03-048)", () => {
  it("keeps a missing note's base for 30 days, then removes it, closes its operations, keeps its copies", async () => {
    const w = await world();
    await w.bases.save("p1", w.base("Gone.md"));
    await w.journal.put(entry("op-open", "p1", "committed"));
    await w.journal.put(entry("op-other", "p-elsewhere", "committed"));
    await w.journal.putCandidate({
      candidateId: "c1",
      projectionId: "p1",
      sectionKey: `${PLAN.R}#${PLAN.sid}`,
      reason: "read-only",
      sourceText: "Secret",
    });
    await w.daily(29);
    expect(await w.bases.projectionsOf("Gone.md")).toEqual(["p1"]);
    await w.daily(2);
    expect(await w.bases.projectionsOf("Gone.md")).toEqual([]);
    expect(await w.bases.load("p1")).toBeUndefined();
    expect((await w.journal.get("op-open"))?.phase).toBe("abandoned");
    expect((await w.journal.get("op-open"))?.reason).toBe(NOTE_DELETED);
    // Another projection's operation and every candidate are untouched.
    expect((await w.journal.get("op-other"))?.phase).toBe("committed");
    expect((await w.journal.allCandidates()).map((c) => c.sourceText)).toEqual(["Secret"]);
    // No mark is left behind.
    expect(await w.kv.keys?.("section-missing:")).toEqual([]);
  });

  it("never removes the base of a note that exists, however old its mark", async () => {
    const w = await world();
    await w.bases.save("p1", w.base("Back.md"));
    await w.daily(20); // missing: marked for 20 days
    w.notes.add("Back.md"); // restored from the trash
    await w.daily(40);
    expect(await w.bases.projectionsOf("Back.md")).toEqual(["p1"]);
    expect(await w.kv.keys?.("section-missing:")).toEqual([]);
  });

  it("a base at an existing note's path stays when another note's base is swept (rename while closed)", async () => {
    const w = await world();
    // Renamed outside Obsidian: the old path is gone, the new one has its own base and note.
    await w.bases.save("old", w.base("Old.md"));
    await w.bases.save("new", w.base("New.md"));
    w.notes.add("New.md");
    await w.daily(35);
    expect(await w.bases.projectionsOf("Old.md")).toEqual([]);
    expect(await w.bases.projectionsOf("New.md")).toEqual(["new"]);
  });

  it("a vault that lists no note is not loaded: nothing is marked or removed", async () => {
    const w = await world();
    await w.bases.save("p1", w.base("Gone.md"));
    w.notes.clear();
    const r = await w.sweep();
    expect(r.skipped).toBe("vault-empty");
    await w.daily(60);
    expect(await w.bases.projectionsOf("Gone.md")).toEqual(["p1"]);
    expect(await w.kv.keys?.("section-missing:")).toEqual([]);
  });

  it("a vault read in part (layout not ready) only marks; a later full read clears it", async () => {
    const w = await world();
    await w.bases.save("p1", w.base("Late.md"));
    await w.sweep(); // Late.md not listed yet
    expect(await w.kv.keys?.("section-missing:")).toHaveLength(1);
    w.setNow(T0 + 90 * DAY);
    w.notes.add("Late.md");
    await w.sweep();
    expect(await w.bases.projectionsOf("Late.md")).toEqual(["p1"]);
    expect(await w.kv.keys?.("section-missing:")).toEqual([]);
  });

  it("a clock set forward alone removes nothing; set back, it starts again", async () => {
    const w = await world();
    await w.bases.save("p1", w.base("Gone.md"));
    await w.sweep();
    w.setNow(T0 + 400 * DAY);
    await w.sweep();
    expect(await w.bases.projectionsOf("Gone.md")).toEqual(["p1"]);
    // Back to a time before the first sighting: the age cannot be trusted.
    w.setNow(T0 - 5 * DAY);
    await w.sweep();
    expect(await w.bases.projectionsOf("Gone.md")).toEqual(["p1"]);
    await w.daily(31);
    expect(await w.bases.projectionsOf("Gone.md")).toEqual([]);
  });

  it("removes at once the bases of a Resource that left, only for a missing note and a known list", async () => {
    const w = await world();
    const left = shared(9, id(3));
    await w.bases.save("gone-note", w.base("Gone.md", left.ref));
    await w.bases.save("kept-note", w.base("Here.md", left.ref));
    w.notes.add("Here.md");
    await w.sweep({ resources: null });
    expect(await w.bases.projectionsOf("Gone.md")).toEqual(["gone-note"]);
    const r = await w.sweep();
    expect(r.resourceGone).toBe(1);
    expect(await w.bases.projectionsOf("Gone.md")).toEqual([]);
    expect(await w.bases.projectionsOf("Here.md")).toEqual(["kept-note"]);
  });

  it("a note made again while the sweep works keeps its base", async () => {
    const w = await world();
    await w.bases.save("p1", w.base("Race.md"));
    await w.daily(31);
    expect(await w.bases.projectionsOf("Race.md")).toEqual([]);
    await w.bases.save("p2", w.base("Race2.md"));
    await w.daily(30);
    // From the day it expires the note appears: asked at the start, true by the removal.
    let calls = 0;
    w.setNow(w.now() + DAY);
    await w.sweep({ exists: (p) => (p === "Race2.md" ? ++calls > 1 : true) });
    expect(await w.bases.projectionsOf("Race2.md")).toEqual(["p2"]);
  });

  async function expiring() {
    const w = await world();
    await w.bases.save("p1", w.base("Race.md"));
    await w.journal.put(entry("op1", "p1", "committed"));
    await w.daily(30);
    w.setNow(w.now() + DAY);
    return w;
  }

  it("a note back before the operations are closed: nothing is closed, the base stays", async () => {
    const w = await expiring();
    // The note appears as the sweep reads the unfinished operations.
    const journal = new Proxy(w.journal, {
      get(target, key) {
        if (key === "unfinished")
          return async () => {
            w.notes.add("Race.md");
            return target.unfinished();
          };
        const v = Reflect.get(target, key) as unknown;
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await w.sweep({ journal });
    expect((await w.journal.get("op1"))?.phase).toBe("committed");
    expect(await w.bases.projectionsOf("Race.md")).toEqual(["p1"]);
  });

  it("a note back between closing the operations and removing the base: the base stays", async () => {
    const w = await expiring();
    const journal = new Proxy(w.journal, {
      get(target, key) {
        if (key === "put")
          return async (e: JournalEntry) => {
            await target.put(e);
            if (e.phase === "abandoned") w.notes.add("Race.md");
          };
        const v = Reflect.get(target, key) as unknown;
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await w.sweep({ journal });
    expect(await w.bases.projectionsOf("Race.md")).toEqual(["p1"]);
    expect(await w.bases.load("p1")).toBeDefined();
  });

  it("an unknown list of Resources is not an empty one", () => {
    expect(knownResources(false, [])).toBeNull();
    expect(knownResources(true, null)).toBeNull();
    expect(knownResources(true, [])).toEqual(new Set());
  });

  it("with no storage the registry answers nothing, and no base is taken for a left Resource", async () => {
    const w = await world();
    await w.bases.save("p1", w.base("Gone.md"));
    // What the host passes when the runtime has no storage: null, not the empty list it reads.
    const r = await w.sweep({ resources: knownResources(false, []) });
    expect(r.resourceGone).toBe(0);
    expect(await w.bases.projectionsOf("Gone.md")).toEqual(["p1"]);
    // The empty set it would have been: everything looks gone.
    const wrong = await w.sweep({ resources: knownResources(true, []) });
    expect(wrong.resourceGone).toBe(1);
  });

  it("the daily sweep is due a day after a try, failed or not", () => {
    expect(sweepDue(0, T0 + 5 * DAY)).toBe(false);
    expect(sweepDue(T0, T0 + DAY - 1)).toBe(false);
    expect(sweepDue(T0, T0 + DAY + 1)).toBe(true);
  });

  it("a stop at any write leaves nothing lost; the next sweep finishes", async () => {
    // Count the writes of a full sweep, then stop at each one in turn.
    const setup = async () => {
      const w = await world();
      await w.bases.save("p1", w.base("Gone.md"));
      await w.bases.save("p2", w.base("Gone.md", shared(8, id(4)).ref));
      await w.journal.put(entry("op1", "p1", "ids-allocated"));
      await w.journal.putCandidate({
        candidateId: "c1",
        projectionId: "p1",
        sectionKey: `${PLAN.R}#${PLAN.sid}`,
        reason: "read-only",
        sourceText: "Secret",
      });
      await w.bases.save("live", w.base("Other.md"));
      await w.daily(30);
      w.setNow(w.now() + DAY);
      return w;
    };
    const probe = await setup();
    const before = probe.state.writes;
    await probe.sweep({ resources: new Set([PLAN.R, shared(8, id(4)).R]) });
    const total = probe.state.writes - before;
    expect(total).toBeGreaterThan(3);
    for (let k = 1; k <= total; k++) {
      const w = await setup();
      w.state.stopAt = w.state.writes + k;
      await w.sweep({ resources: new Set([PLAN.R, shared(8, id(4)).R]) }).catch(() => undefined);
      w.state.stopAt = Number.POSITIVE_INFINITY;
      // Whatever the stop, the live note's base and the copy are intact.
      expect(await w.bases.projectionsOf("Other.md")).toEqual(["live"]);
      expect((await w.journal.allCandidates()).map((c) => c.sourceText)).toEqual(["Secret"]);
      await w.sweep({ resources: new Set([PLAN.R, shared(8, id(4)).R]) });
      expect(await w.bases.projectionsOf("Gone.md")).toEqual([]);
      expect(await w.bases.projectionsOf("Other.md")).toEqual(["live"]);
      expect((await w.journal.get("op1"))?.phase).toBe("abandoned");
      expect(await w.kv.keys?.("section-missing:")).toEqual([]);
      expect((await w.journal.allCandidates()).map((c) => c.sourceText)).toEqual(["Secret"]);
    }
  });
});

describe("the diagnostics of the bases of missing notes (LFCP-03-048)", () => {
  it("counts the notes and the age of the oldest, and the report says so", async () => {
    const w = await world();
    await w.bases.save("p1", w.base("Gone.md"));
    await w.bases.save("p2", w.base("Gone2.md"));
    await w.daily(10);
    expect(await missingNoteStats(w.kv, w.now())).toEqual({ notes: 2, oldestDays: 9 });
    const input = await collectDiagnostics({
      runtime: null,
      collab: null,
      sections: {
        diagnostics: async () => ({
          sections: [],
          candidates: [],
          missingNotes: await missingNoteStats(w.kv, w.now()),
        }),
      },
      events: [],
      plugin: "t",
      obsidian: "t",
      platform: "t",
      needsRestart: false,
    });
    expect(diagnosticReport(input, false)).toContain(
      "Bases of notes that are gone: 2 (oldest 9 days",
    );
  });
});
