// LFCP-03-048 (obsidian#46), phase A: what a deleted note leaves behind in the
// local records (bases, journal, candidates, facts), and what each way of
// getting the note back does with them. These tests pin today's behaviour (the
// host keeps a deleted note's bases) and, where a test says "naive drop", the
// harm of the reverted change (5942b25, "drop the projection bases of a deleted
// note"), which the design in docs/architecture/decisions/0002-deleted-note-records.md
// has to avoid. Real section replica (test/support/section-vaults).

import { describe, expect, it } from "vitest";
import { keptCandidates } from "../../../src/core/diagnostics-collect";
import { SectionActions } from "../../../src/core/sections/actions";
import { MemorySectionBaseStore } from "../../../src/core/sections/base";
import { formatBoundary } from "../../../src/core/sections/grammar";
import type { PendingCandidate } from "../../../src/core/sections/journal";
import { adoptedBase } from "../../../src/core/sections/repair";
import {
  type KeyValue,
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { forgetDeletedNote, ProjectionFactsStore } from "../../../src/core/status/projections";
import {
  count,
  id,
  PATH,
  PLAN,
  sectionNote,
  shared,
  taskId,
  twoVaults,
  type Vault,
} from "../../support/section-vaults";

const CTX = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };

/** The note with a Task typed at the end of the section, still without its binding. */
const typed = (md: string, title: string) =>
  md.replace(formatBoundary("end", PLAN.ref), `- [ ] ${title}\n${formatBoundary("end", PLAN.ref)}`);

/** How many Tasks the model has. */
const tasksInModel = (v: Vault) =>
  Object.values(v.model()?.nodes ?? {}).filter((n) => n.kind === "task").length;

/** What the reverted commit 5942b25 did when the note was deleted. */
async function naiveDrop(v: Vault, path = PATH) {
  for (const id of await v.bases.projectionsOf(path)) await v.bases.save(id, null);
}

/** The host's "Keep mine" on a lost base (actions.ts shareMine, no pasted nodes). */
async function keepMine(v: Vault, path = PATH) {
  const snap = v.model();
  if (snap === undefined) throw new Error("no model");
  await v.bases.save("keep-mine-projection", adoptedBase(path, PLAN.ref, snap));
}

describe("a deleted note and its bases (LFCP-03-048)", () => {
  it("today: bases stay after the delete, so a note back from the trash merges through them", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "- [ ] Beta"]);
    const trashed = a.note();
    // The note is deleted (the host forgets only its index); a peer adds a Task meanwhile.
    await b.pass(typed(b.note(), "Remote"));
    await b.pass(b.note());
    a.replica().receiveChanges(b.replica().changes());
    expect(await a.bases.projectionsOf(PATH)).toHaveLength(1);
    // Restored from the trash: the old base is found, the peer's Task is rendered, nothing is sent.
    const r = await a.pass(trashed);
    expect(r?.local?.kind).toBe("nothing");
    expect(count(a.note(), "Remote")).toBe(1);
    expect(count(a.note(), "Alpha")).toBe(1);
    expect(a.model()?.nodes).toEqual(b.model()?.nodes);
  });

  it("today: a committed entry the note never showed is resumed after restore, one Task", async () => {
    const { a } = await twoVaults(["- [ ] Alpha"]);
    const before = tasksInModel(a);
    // The pass committed "Gamma"; the process stopped before the note was written; the note is deleted.
    const text = typed(a.note(), "Gamma");
    await a.engine.pass(PATH, text, CTX);
    expect(tasksInModel(a)).toBe(before + 1);
    expect(await a.journal.unfinished()).toHaveLength(1);
    // Restored from the trash with the text the user had.
    for (let i = 0; i < 3; i++) await a.pass(a.note() === "" || i === 0 ? text : a.note());
    expect(tasksInModel(a)).toBe(before + 1);
    expect(count(a.note(), "Gamma")).toBe(1);
    expect(await a.journal.unfinished()).toEqual([]);
  });

  it("naive drop: the same restore is held as base-unknown; Keep mine ends in a lost binding, the entry never closes", async () => {
    const { a } = await twoVaults(["- [ ] Alpha"]);
    const before = tasksInModel(a);
    const text = typed(a.note(), "Gamma");
    await a.engine.pass(PATH, text, CTX);
    expect(tasksInModel(a)).toBe(before + 1);
    await naiveDrop(a);
    // Back from the trash: no base, the note does not show the model: held.
    const held = await a.pass(text);
    expect(held?.skipped).toBe("base-unknown");
    // The committed entry belongs to the dropped projection: nothing resumes it.
    expect(await a.journal.unfinished()).toHaveLength(1);
    // "Keep mine": the base is the model's, which has Gamma; the note's Gamma line has no
    // binding to it. Not a duplicate (the issue feared one): a NODE_BINDING_LOST projection,
    // blocked until repaired, with the model's Gamma and the note's line apart for good.
    await keepMine(a);
    for (let i = 0; i < 3; i++) {
      const r = await a.pass(a.note());
      expect(r?.lost).toHaveLength(1);
    }
    expect(tasksInModel(a)).toBe(before + 1);
    expect(a.note()).not.toContain("task:019a2f85-7b31-7c42-b85a-fc843e2f4065");
    expect(count(a.note(), "Gamma")).toBe(1);
    expect(await a.journal.unfinished()).toHaveLength(1);
  });

  it("today: delete leaves the unfinished entry, the bases and the candidates in the state for good", async () => {
    const { a } = await twoVaults(["- [ ] Alpha"]);
    a.setAccess({ allowed: false, reason: "read-only" });
    // A read-only member's edit is kept as a candidate with its private text.
    await a.pass(typed(a.note(), "Secret plan"));
    const [projection] = await a.bases.projectionsOf(PATH);
    const kept = await a.journal.candidates(projection as string);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.sourceText).toContain("Secret plan");
    // Found by section, not only through the projection's base (LFCP-03-048).
    expect(kept[0]?.sectionKey).toBe(`${PLAN.R}#${PLAN.sid}`);
    // The note is deleted and never comes back: no code path ever resolves any of it.
    expect(await a.bases.projectionsOf(PATH)).toHaveLength(1);
    expect(await a.journal.candidates(projection as string)).toHaveLength(1);
  });
});

describe("every engine producer names the section of a kept copy (LFCP-03-048)", () => {
  const KEY = `${PLAN.R}#${PLAN.sid}`;
  const keysOf = async (v: Vault, projection: string) =>
    (await v.journal.candidates(projection)).map((c) => [c.reason, c.sectionKey]);

  it("base-unknown: a note whose base is lost and shows more than the model", async () => {
    const { a } = await twoVaults(["- [ ] Alpha"]);
    const [projection] = await a.bases.projectionsOf(PATH);
    await a.bases.save(projection as string, null);
    const r = await a.pass(typed(a.note(), "Local only"));
    expect(r?.skipped).toBe("base-unknown");
    expect(await keysOf(a, r?.projectionId as string)).toEqual([["base-unknown", KEY]]);
  });

  it("drift: text typed after a refused edit is kept first, with its section", async () => {
    const { a, b } = await twoVaults(["- [ ] Alpha", "", "A paragraph."]);
    const pid = Object.entries(a.model()?.nodes ?? {}).find(
      ([, n]) => n.kind === "paragraph",
    )?.[0] as string;
    const [projection] = await a.bases.projectionsOf(PATH);
    await b.pass(b.note().replace("A paragraph.", "A paragraph, remote."));
    a.replica().receiveChanges(b.replica().changes());
    await a.engine.drifted(projection as string, [pid]);
    const local = a.note().replace("A paragraph.", "A paragraph, local.");
    await a.pass(local);
    await a.pass(local);
    const kept = (await a.journal.candidates(projection as string)).filter((c) =>
      c.candidateId.startsWith("drift:"),
    );
    expect(kept.map((c) => c.sectionKey)).toEqual([KEY]);
  });

  it("pasted: nodes the user put in that the base does not know and the model shows otherwise", async () => {
    const { a } = await twoVaults(["- [ ] Alpha", "- [ ] a1"]);
    const a1 = taskId(a.note(), "a1");
    const [projection] = await a.bases.projectionsOf(PATH);
    const stored = await a.bases.load(projection as string);
    if (stored === undefined) throw new Error("no base");
    const nodes = { ...stored.state.nodes };
    delete nodes[a1];
    const order = Object.fromEntries(
      Object.entries(stored.state.order).map(([k, ids]) => [k, ids.filter((x) => x !== a1)]),
    );
    await a.bases.save(projection as string, {
      ...stored,
      state: { ...stored.state, nodes, order },
    });
    const r = await a.pass(a.note().replace("- [ ] a1", "- [ ] a1 pasted over"), {
      inserted: new Set([a1]),
    });
    expect(r?.held).toBeDefined();
    const kept = (await a.journal.candidates(projection as string)).filter((c) =>
      c.candidateId.startsWith("pasted:"),
    );
    expect(kept.map((c) => c.sectionKey)).toEqual([KEY]);
  });
});

/** An in-memory KeyValue, as the install database is to the stores. */
function keyValue(): KeyValue {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k),
    put: async (k, v) => void m.set(k, v),
    update: async (k, f) => void m.set(k, f(m.get(k))),
  };
}

describe("kept copies of a deleted note's section (LFCP-03-048)", () => {
  const KEY = `${PLAN.R}#${PLAN.sid}`;
  const SECTION_TEXT = sectionNote(PLAN, "Plan", ["- [ ] Secret plan"]);

  async function discard(
    prepare: (
      bases: KeyValueSectionBaseStore,
      journal: KeyValueSectionJournalStore,
    ) => Promise<void>,
  ) {
    const kv = keyValue();
    const bases = new KeyValueSectionBaseStore(kv);
    const journal = new KeyValueSectionJournalStore(kv);
    await prepare(bases, journal);
    const notices: string[] = [];
    const resolved: string[] = [];
    const actions = new SectionActions({
      prompter: {
        notice: (m: string) => notices.push(m),
        confirm: () => ({ result: Promise.resolve(true) }),
      },
      notes: {},
      services: {
        bases: () => bases,
        candidates: () => ({
          putCandidate: (c: PendingCandidate) => journal.putCandidate(c),
          allCandidates: () => journal.allCandidates(),
          candidatesOfSection: (k: string) => journal.candidatesOfSection(k),
          resolveCandidate: async (id: string) => {
            resolved.push(id);
            await journal.resolveCandidate(id);
          },
        }),
        scheduleStatus: () => undefined,
      },
    } as never);
    await actions.discardLocalCopies(KEY, "Plan");
    return { notices, resolved, left: await journal.allCandidates(), journal };
  }

  const candidate = (projectionId: string, over: Partial<PendingCandidate> = {}) => ({
    candidateId: "c1",
    projectionId,
    sectionKey: KEY,
    reason: "read-only" as const,
    sourceText: SECTION_TEXT,
    ...over,
  });
  const base = (path: string) =>
    adoptedBase(path, PLAN.ref, { revision: "r", nodes: {}, order: {} } as never);

  it("found through the base of its projection, deleted note or not", async () => {
    const r = await discard(async (bases, journal) => {
      await bases.save("p1", base(PATH));
      await journal.putCandidate(candidate("p1"));
    });
    expect(r.resolved).toEqual(["c1"]);
  });

  it("F4: found by its section key when the base is gone", async () => {
    const r = await discard(async (bases, journal) => {
      await bases.save("p1", base(PATH));
      await journal.putCandidate(candidate("p1"));
      await bases.save("p1", null);
    });
    expect(r.resolved).toEqual(["c1"]);
    expect(r.left).toEqual([]);
  });

  it("F5: a Repair recovery copy (repair:<path>) is found by its section key", async () => {
    const r = await discard(async (_bases, journal) => {
      await journal.putCandidate(candidate(`repair:${PATH}`, { reason: "base-unknown" }));
    });
    expect(r.resolved).toEqual(["c1"]);
  });

  it("a copy of another section is left alone", async () => {
    const other = `${PLAN.R}#other-section`;
    const r = await discard(async (_bases, journal) => {
      await journal.putCandidate(candidate("p1", { sectionKey: other }));
    });
    expect(r.resolved).toEqual([]);
    expect(r.left).toHaveLength(1);
  });

  it("a record without a key is still found by its base, as before the backfill", async () => {
    const r = await discard(async (bases, journal) => {
      await bases.save("p1", base(PATH));
      const { sectionKey: _key, ...unkeyed } = candidate("p1");
      await journal.putCandidate(unkeyed);
    });
    expect(r.resolved).toEqual(["c1"]);
  });
});

describe("the section key backfill (LFCP-03-048)", () => {
  const KEY = `${PLAN.R}#${PLAN.sid}`;
  const legacy = (
    candidateId: string,
    projectionId: string,
    sourceText = "text",
  ): PendingCandidate => ({
    candidateId,
    projectionId,
    reason: "base-unknown",
    sourceText,
  });

  it("derives the key from the base, a provisional ID or the text; keeps the rest and counts it", async () => {
    const kv = keyValue();
    const bases = new KeyValueSectionBaseStore(kv);
    const journal = new KeyValueSectionJournalStore(kv);
    await bases.save(
      "p1",
      adoptedBase(PATH, PLAN.ref, { revision: "r", nodes: {}, order: {} } as never),
    );
    await journal.putCandidate(legacy("by-base", "p1"));
    await journal.putCandidate(legacy("by-id", `pending:Dir/A#B.md#${KEY}#0`));
    await journal.putCandidate(
      legacy("by-text", `repair:${PATH}`, sectionNote(PLAN, "Plan", ["- [ ] Secret plan"])),
    );
    await journal.putCandidate(legacy("unknown", "gone", "no markers here"));
    const first = await journal.backfillSectionKeys();
    expect(first).toEqual({ filled: 3, unresolved: 1 });
    expect((await journal.candidatesOfSection(KEY)).map((c) => c.candidateId).sort()).toEqual([
      "by-base",
      "by-id",
      "by-text",
    ]);
    // Idempotent; nothing is deleted, the unplaced record stays.
    const again = await journal.backfillSectionKeys();
    expect(again).toEqual({ filled: 0, unresolved: 1 });
    expect(await journal.allCandidates()).toHaveLength(4);
    expect(
      (await journal.candidatesOfSection(KEY)).filter((c) => c.sourceText !== ""),
    ).toHaveLength(3);
    // Diagnostics count the unplaced one.
    const kept = await keptCandidates(journal);
    expect(kept.filter((k) => k.unkeyed === true)).toHaveLength(1);
  });

  it("a text of more than one section says no section: left unkeyed, counted", async () => {
    const journal = new KeyValueSectionJournalStore(keyValue());
    const other = shared(9, id(7));
    const two = `${sectionNote(PLAN, "Plan", ["- [ ] One"])}${sectionNote(other, "Other", ["- [ ] Two"])}`;
    await journal.putCandidate(legacy("two", "gone", two));
    expect(await journal.backfillSectionKeys()).toEqual({ filled: 0, unresolved: 1 });
    expect((await journal.allCandidates())[0]?.sectionKey).toBeUndefined();
  });

  /**
   * A KV as the runtime's localState is: updates of one key run one at a time, a put does not
   * wait for them. `onRead` runs once, right after the first read of a candidate record: the
   * window between the backfill's read and its write.
   */
  function racingKeyValue() {
    const m = new Map<string, unknown>();
    const chains = new Map<string, Promise<void>>();
    const hook: {
      onRead: (() => Promise<void>) | null;
      /** Once, inside an update of a candidate record, between its read and its write. */
      inUpdate: (() => void) | null;
    } = { onRead: null, inUpdate: null };
    const kv: KeyValue = {
      get: async (k) => {
        const v = m.get(k);
        if (k.startsWith("section-candidate:") && hook.onRead !== null) {
          const run = hook.onRead;
          hook.onRead = null;
          await run();
        }
        return v;
      },
      put: async (k, v) => void m.set(k, v),
      update: (k, change) => {
        const run = async () => {
          const current = m.get(k);
          if (k.startsWith("section-candidate:") && hook.inUpdate !== null) {
            const start = hook.inUpdate;
            hook.inUpdate = null;
            start();
            // Time for a put that does not wait for updates to land in the window.
            await new Promise((r) => setTimeout(r, 5));
          }
          await kv.put(k, change(current));
        };
        const done = (chains.get(k) ?? Promise.resolve()).then(run, run);
        chains.set(
          k,
          done.then(
            () => undefined,
            () => undefined,
          ),
        );
        return done;
      },
    };
    return { kv, hook };
  }

  it("a copy resolved while the backfill runs stays resolved", async () => {
    const { kv, hook } = racingKeyValue();
    const journal = new KeyValueSectionJournalStore(kv);
    await journal.putCandidate(legacy("c1", "gone", sectionNote(PLAN, "Plan", ["- [ ] One"])));
    hook.onRead = () => journal.resolveCandidate("c1");
    await journal.backfillSectionKeys();
    expect(await journal.allCandidates()).toEqual([]);
    expect(await kv.get("section-candidate:c1")).toBeNull();
    expect(await journal.candidatesOfSection(KEY)).toEqual([]);
  });

  it("a copy kept again while the backfill runs is not overwritten by the older text", async () => {
    const { kv, hook } = racingKeyValue();
    const journal = new KeyValueSectionJournalStore(kv);
    await journal.putCandidate(legacy("c1", "gone", sectionNote(PLAN, "Plan", ["- [ ] Old"])));
    const fresh = legacy("c1", "gone", sectionNote(PLAN, "Plan", ["- [ ] Fresh"]));
    hook.onRead = () => journal.putCandidate(fresh);
    await journal.backfillSectionKeys();
    const [kept] = await journal.allCandidates();
    expect(kept?.sourceText).toBe(fresh.sourceText);
    expect(await journal.allCandidates()).toHaveLength(1);
  });

  it("a copy resolved or kept again inside the backfill's own write is not undone by it", async () => {
    for (const act of ["resolve", "put"] as const) {
      const { kv, hook } = racingKeyValue();
      const journal = new KeyValueSectionJournalStore(kv);
      await journal.putCandidate(legacy("c1", "gone", sectionNote(PLAN, "Plan", ["- [ ] Old"])));
      const fresh = legacy("c1", "gone", sectionNote(PLAN, "Plan", ["- [ ] Fresh"]));
      let other: Promise<void> = Promise.resolve();
      hook.inUpdate = () => {
        other = act === "resolve" ? journal.resolveCandidate("c1") : journal.putCandidate(fresh);
      };
      await journal.backfillSectionKeys();
      await other;
      const kept = await journal.allCandidates();
      // The record itself, not only the index: a resurrected record would be unlisted but kept.
      if (act === "resolve") {
        expect(kept).toEqual([]);
        expect(await kv.get("section-candidate:c1")).toBeNull();
      } else expect(kept.map((c) => c.sourceText)).toEqual([fresh.sourceText]);
    }
  });

  it("the backfill leaves a record replaced since it was read: by another text, by another projection", async () => {
    const oldText = sectionNote(PLAN, "Plan", ["- [ ] Old"]);
    const replaced = [
      legacy("c1", "gone", sectionNote(PLAN, "Plan", ["- [ ] Fresh"])),
      legacy("c1", "elsewhere", oldText),
    ];
    for (const fresh of replaced) {
      const { kv, hook } = racingKeyValue();
      const journal = new KeyValueSectionJournalStore(kv);
      await journal.putCandidate(legacy("c1", "gone", oldText));
      hook.onRead = () => journal.putCandidate(fresh);
      await journal.backfillSectionKeys();
      const [kept] = await journal.allCandidates();
      expect(kept?.sourceText).toBe(fresh.sourceText);
      expect(kept?.projectionId).toBe(fresh.projectionId);
      // Not keyed from the record it replaced; the next start's backfill keys it.
      expect(kept?.sectionKey).toBeUndefined();
      expect(await journal.candidatesOfSection(KEY)).toEqual([]);
    }
  });

  it("F9: a pending projection's candidate follows its note's rename", async () => {
    const journal = new KeyValueSectionJournalStore(keyValue());
    await journal.putCandidate({
      candidateId: `base-unknown:pending:Old.md#${KEY}#0`,
      projectionId: `pending:Old.md#${KEY}#0`,
      sectionKey: KEY,
      reason: "base-unknown",
      sourceText: "private",
    });
    await journal.renamePending("Old.md", "New.md");
    const all = await journal.allCandidates();
    expect(all.map((c) => c.candidateId)).toEqual([`base-unknown:pending:New.md#${KEY}#0`]);
    expect(all[0]?.sourceText).toBe("private");
    expect(await journal.candidates(`pending:Old.md#${KEY}#0`)).toEqual([]);
    expect(await journal.candidatesOfSection(KEY)).toHaveLength(1);
    // The pass that seeds the projection at the new path resolves it by that ID.
    await journal.resolveCandidate(`base-unknown:pending:New.md#${KEY}#0`);
    expect(await journal.allCandidates()).toEqual([]);
    expect(await journal.candidatesOfSection(KEY)).toEqual([]);
  });
});

describe("the badge facts of a deleted note (LFCP-03-048)", () => {
  const key = `${PLAN.R}#${PLAN.sid}`;
  const result = (projectionId: string, skipped?: "base-unknown") =>
    ({
      projectionId,
      section: PLAN.ref,
      ...(skipped ? { skipped } : {}),
      lost: [],
      held: [],
      entries: [],
    }) as never;

  async function withFacts() {
    const facts = new ProjectionFactsStore();
    const bases = new MemorySectionBaseStore();
    await bases.save(
      "p1",
      adoptedBase(PATH, PLAN.ref, { revision: "r", nodes: {}, order: {} } as never),
    );
    facts.note(key, result("p1"));
    facts.held(key, "p1", { path: PATH } as never);
    const pending = `pending:${PATH}#${key}#0`;
    facts.note(key, result(pending, "base-unknown"));
    facts.held(key, pending, { path: PATH } as never);
    return { facts, bases };
  }

  it("is forgotten when the note is deleted: bases and provisional projections alike", async () => {
    const { facts, bases } = await withFacts();
    expect(facts.projections(key)).toHaveLength(2);
    expect(await forgetDeletedNote(facts, bases, PATH, () => false)).toBe(true);
    expect(facts.projections(key)).toEqual([]);
    expect(facts.holds(PATH)).toBe(false);
    // The base stays: a restore merges through it.
    expect(await bases.projectionsOf(PATH)).toEqual(["p1"]);
  });

  it("is kept when the note is made again meanwhile (a sync's delete, then create)", async () => {
    const { facts, bases } = await withFacts();
    let exists = false;
    const slow = {
      load: bases.load.bind(bases),
      projectionsOf: async (path: string) => {
        const ids = await bases.projectionsOf(path);
        // The create and its pass land while the bases are read.
        exists = true;
        facts.note(key, result("p1"));
        return ids;
      },
    };
    expect(await forgetDeletedNote(facts, slow, PATH, () => exists)).toBe(false);
    expect(facts.projections(key).length).toBeGreaterThan(0);
    expect(facts.holds(PATH)).toBe(true);
  });
});
