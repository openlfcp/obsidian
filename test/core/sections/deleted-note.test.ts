// LFCP-03-048 (obsidian#46), phase A: what a deleted note leaves behind in the
// local records (bases, journal, candidates, facts), and what each way of
// getting the note back does with them. These tests pin today's behaviour (the
// host keeps a deleted note's bases) and, where a test says "naive drop", the
// harm of the reverted change (5942b25, "drop the projection bases of a deleted
// note"), which the design in docs/development/design/deleted-note-bases.md
// has to avoid. Real section replica (test/support/section-vaults).

import { describe, expect, it } from "vitest";
import { SectionActions } from "../../../src/core/sections/actions";
import { formatBoundary } from "../../../src/core/sections/grammar";
import type { PendingCandidate } from "../../../src/core/sections/journal";
import { adoptedBase } from "../../../src/core/sections/repair";
import {
  type KeyValue,
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { ProjectionFactsStore } from "../../../src/core/status/projections";
import { count, PATH, PLAN, twoVaults, type Vault } from "../../support/section-vaults";

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
    // The note is deleted and never comes back: no code path ever resolves any of it.
    expect(await a.bases.projectionsOf(PATH)).toHaveLength(1);
    expect(await a.journal.candidates(projection as string)).toHaveLength(1);
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
          resolveCandidate: async (id: string) => {
            resolved.push(id);
            await journal.resolveCandidate(id);
          },
        }),
        scheduleStatus: () => undefined,
      },
    } as never);
    await actions.discardLocalCopies(KEY, "Plan");
    return { notices, resolved, left: await journal.allCandidates() };
  }

  const candidate = (projectionId: string) => ({
    candidateId: "c1",
    projectionId,
    reason: "read-only" as const,
    sourceText: "Secret plan",
  });
  const base = (path: string) =>
    adoptedBase(path, PLAN.ref, { revision: "r", nodes: {}, order: {} } as never);

  it("today: found through the base of its projection, deleted note or not", async () => {
    const r = await discard(async (bases, journal) => {
      await bases.save("p1", base(PATH));
      await journal.putCandidate(candidate("p1"));
    });
    expect(r.resolved).toEqual(["c1"]);
  });

  it("naive drop: the base is gone, the copy is neither offered nor resolved, and still counted", async () => {
    const r = await discard(async (bases, journal) => {
      await bases.save("p1", base(PATH));
      await journal.putCandidate(candidate("p1"));
      await bases.save("p1", null);
    });
    expect(r.resolved).toEqual([]);
    expect(r.notices[0]).toContain("no local copy");
    expect(r.left).toHaveLength(1);
  });

  it("today (already, no delete needed): a Repair recovery copy keyed repair:<path> is never found by section", async () => {
    const r = await discard(async (_bases, journal) => {
      await journal.putCandidate({ ...candidate(`repair:${PATH}`), reason: "base-unknown" });
    });
    expect(r.resolved).toEqual([]);
    expect(r.left).toHaveLength(1);
  });
});

describe("the badge facts of a deleted note (LFCP-03-048)", () => {
  it("today: the host does not forget a deleted note's projections until a restart", () => {
    const facts = new ProjectionFactsStore();
    const key = `${PLAN.R}#${PLAN.sid}`;
    facts.note(key, {
      projectionId: "p1",
      section: PLAN.ref,
      skipped: "base-unknown",
      lost: [],
      held: [],
      entries: [],
    } as never);
    facts.held(key, "p1", { path: PATH } as never);
    // vaultChange("delete") calls damaged(path, ∅) and nothing else of the facts.
    facts.damaged(PATH, new Set());
    expect(facts.projections(key)).toHaveLength(1);
    expect(facts.holds(PATH)).toBe(true);
  });
});
