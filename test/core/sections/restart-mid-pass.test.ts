// A vault restarted in the middle of a structural pass (coverage gap 5):
// a new engine on the same stores (journal, bases, the SDK's durable
// receipts) after the process stopped at each phase of the journal
// (ARCHITECTURE-02 §5), before or after the note was written. The pass then
// completes or is abandoned cleanly: every node once in the model and in
// the note, the user's edit kept, the note the model's, nothing left
// unfinished or held. Against the fake SDK port (mock evidence).

import { principalId } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import {
  MemorySectionBaseStore,
  markdownState,
  type StoredBase,
} from "../../../src/core/sections/base";
import { applyChanges, type PassContext, SectionEngine } from "../../../src/core/sections/engine";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import {
  type JournalEntry,
  MemorySectionJournalStore,
  type Phase,
} from "../../../src/core/sections/journal";
import { parseSections } from "../../../src/core/sections/parser";
import { FakeSectionPort, type Fault } from "./fake-port";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const SID = id(1);
const S = parseSectionRef(`lfcp1:${R}#section:${SID}`) as SectionRef;
const PATH = "Launch.md";
const P = id(2);
const Q = id(3);
const X = id(4);
const T = id(5);
const REF = (t: string) => `  <!-- lfcp-ref: lfcp1:${R}#task:${t} -->`;
const CTX: PassContext = { caretLine: null, deletedIds: new Set(), origin: "other" };

const note = (body: string[]) =>
  ["Intro.", "## Launch", formatBoundary("start", S), ...body, formatBoundary("end", S), ""].join(
    "\n",
  );

const BEFORE = note([
  formatNodeMarker("paragraph", P),
  "Draft",
  "",
  formatNodeMarker("paragraph", Q),
  "Notes",
  "",
  formatNodeMarker("paragraph", X),
  "Old",
  "",
  "- [ ] Contract",
  REF(T),
]);

/**
 * The user's edit, in one pass: Draft retitled, Old deleted, a new Task,
 * and Contract moved (cut and pasted) to the top.
 */
const EDITED = note([
  "- [ ] Contract",
  REF(T),
  "",
  formatNodeMarker("paragraph", P),
  "Draft v2",
  "",
  formatNodeMarker("paragraph", Q),
  "Notes",
  "",
  "- [ ] Call Anna",
]);
const EDIT_CTX: PassContext = {
  caretLine: null,
  deletedIds: new Set([X]),
  origin: "other",
  inserted: new Set([T]),
};

const stateOf = (md: string) => {
  const s = parseSections(md).sections[0];
  if (s === undefined) throw new Error("no section");
  return markdownState(md, s);
};

class Crash extends Error {}

/** A journal that stops the process right after an entry reaches `at` is stored. */
class CrashingJournal extends MemorySectionJournalStore {
  at: Phase | null = null;
  override async put(entry: JournalEntry): Promise<void> {
    await super.put(entry);
    if (entry.phase === this.at) {
      this.at = null;
      throw new Crash(`stopped at ${entry.phase}`);
    }
  }
}

/** Bases that stop the process before (or right after) the next save. */
class CrashingBases extends MemorySectionBaseStore {
  at: "before-save" | "after-save" | null = null;
  override async save(projectionId: string, base: StoredBase | null): Promise<void> {
    if (this.at === "before-save") {
      this.at = null;
      throw new Crash("stopped before the base was saved");
    }
    await super.save(projectionId, base);
    if (this.at === "after-save") {
      this.at = null;
      throw new Crash("stopped after the base was saved");
    }
  }
}

function vault() {
  const port = new FakeSectionPort();
  port.host(R, SID, stateOf(BEFORE).state);
  const journal = new CrashingJournal();
  const bases = new CrashingBases();
  let nodeId = 100;
  let op = 0;
  let projection = 0;
  /** A new engine on the same stores: the vault (re)started. */
  const start = () =>
    new SectionEngine({
      port,
      journal,
      bases,
      newNodeId: () => id(nodeId++),
      newOperationId: () => `op-${++op}`,
      createdBy: principalId(new Uint8Array(32).fill(4)),
      newProjectionId: () => `projection-${++projection}`,
      tasks: () => undefined,
      newTask: (line, taskId) => ({
        id: taskId,
        title: line.replace(/^[ \t]*[-*+][ \t]+\[.\][ \t]*/, "").trim(),
      }),
    });
  /** A pass written as the host writes it; the note on disk follows. */
  const run = async (engine: SectionEngine, md: string, ctx: PassContext = CTX) => {
    const pass = await engine.pass(PATH, md, ctx);
    const out = applyChanges(md, pass.changes);
    disk = out;
    await engine.written(pass, out);
    return { pass, out };
  };
  let disk = BEFORE;
  return {
    port,
    journal,
    bases,
    start,
    run,
    disk: () => disk,
    setDisk: (md: string) => {
      disk = md;
    },
  };
}

/** The note shows the model: the same nodes once each, in its order, with its Text. */
function expectNoteIsModel(port: FakeSectionPort, md: string) {
  const model = port.sections.get(R)?.state;
  const shown = stateOf(md);
  expect(shown.unbound).toEqual([]);
  const ids: string[] = [];
  const walk = (ns: ReturnType<typeof parseSections>["sections"][number]["nodes"]) => {
    for (const n of ns) {
      if (n.id !== null) ids.push(n.id);
      walk(n.children);
    }
  };
  walk(parseSections(md).sections[0]?.nodes ?? []);
  expect(new Set(ids).size).toBe(ids.length);
  expect(Object.keys(shown.state.nodes).sort()).toEqual(Object.keys(model?.nodes ?? {}).sort());
  expect(shown.state.order).toEqual(model?.order);
  for (const [nid, n] of Object.entries(model?.nodes ?? {}))
    if (n.text !== undefined) expect(shown.state.nodes[nid]?.text).toBe(n.text);
}

/** The user's edit is in the model and the note: no lost edit, one Task each. */
function expectEditKept(port: FakeSectionPort, md: string) {
  const model = port.sections.get(R)?.state;
  expect(model?.nodes[X]).toBeUndefined();
  expect(model?.nodes[P]?.text).toBe("Draft v2");
  expect(model?.order[""]?.[0]).toBe(T);
  const created = Object.keys(model?.nodes ?? {}).filter((n) => ![P, Q, T].includes(n));
  expect(created).toHaveLength(1);
  expect(md.match(/Call Anna/g)).toHaveLength(1);
  expect(md.match(/Contract/g)).toHaveLength(1);
  expect(md).not.toContain("Old");
}

/** After the restart: passes on the note on disk until it is stable, then nothing is left. */
async function settle(v: ReturnType<typeof vault>) {
  const engine = v.start();
  for (let i = 0; i < 3; i++) {
    const { pass } = await v.run(engine, v.disk());
    for (const s of pass.sections) expect(s.skipped).toBeUndefined();
  }
  const sent = v.port.changes.length;
  const last = await v.run(engine, v.disk());
  expect(last.pass.changes).toEqual([]);
  expect(v.port.changes).toHaveLength(sent);
  expect(await v.journal.unfinished()).toEqual([]);
  expect(await v.journal.candidates("projection-1")).toEqual([]);
  const s = last.pass.sections[0];
  expect(s?.held).toEqual([]);
  expect(s?.lost).toEqual([]);
  expect(s?.reappeared ?? []).toEqual([]);
}

/** Seeded, then the user's edit reaches a pass that stops as `stop` says. */
async function stopped(
  stop:
    | { readonly journal: Phase }
    | { readonly fault: Fault }
    | { readonly bases: "before-save" | "after-save" }
    | { readonly unwritten: true },
) {
  const v = vault();
  const first = v.start();
  await v.run(first, BEFORE);
  v.setDisk(EDITED);
  if ("journal" in stop) v.journal.at = stop.journal;
  if ("fault" in stop) v.port.fail(stop.fault);
  if ("bases" in stop) v.bases.at = stop.bases;
  if ("unwritten" in stop) {
    // The pass commits; the process stops before the host writes the note.
    await first.pass(PATH, EDITED, EDIT_CTX);
    return v;
  }
  await v.run(first, EDITED, EDIT_CTX).catch((e) => {
    if (!(e instanceof Crash) && !String(e).includes("crash")) throw e;
  });
  return v;
}

describe("a restart in the middle of a structural pass", () => {
  it("control: no stop, then a restart", async () => {
    const v = vault();
    const first = v.start();
    await v.run(first, BEFORE);
    await v.run(first, EDITED, EDIT_CTX);
    expect(v.port.changes).toHaveLength(1);
    await settle(v);
    expectEditKept(v.port, v.disk());
    expectNoteIsModel(v.port, v.disk());
  });

  it("a new operation is first stored with its batch: never left at captured", async () => {
    const v = vault();
    const first = v.start();
    await v.run(first, BEFORE);
    const phases: string[] = [];
    const put = v.journal.put.bind(v.journal);
    v.journal.put = async (e) => {
      phases.push(e.phase);
      await put(e);
    };
    await v.run(first, EDITED, EDIT_CTX);
    expect(phases).toEqual(["ids-allocated", "committed", "projected", "done"]);
  });

  // Inside pass(): the note on disk is the user's edit, no binding written.
  for (const phase of ["ids-allocated", "committed"] as const)
    it(`stopped once the journal recorded "${phase}": completes, once`, async () => {
      const v = await stopped({ journal: phase });
      expect(v.disk()).toBe(EDITED);
      await settle(v);
      expectEditKept(v.port, v.disk());
      expectNoteIsModel(v.port, v.disk());
    });

  it("stopped in the commit, before the SDK's transaction: sent once on the next pass", async () => {
    const v = await stopped({ fault: { kind: "crash-before" } });
    expect(v.port.changes).toHaveLength(0);
    await settle(v);
    expectEditKept(v.port, v.disk());
    expectNoteIsModel(v.port, v.disk());
  });

  it("stopped in the commit, after the SDK's transaction: the receipt is found, not sent again", async () => {
    const v = await stopped({ fault: { kind: "crash-after" } });
    expect(v.port.changes).toHaveLength(1);
    await settle(v);
    expect(v.port.changes).toHaveLength(1);
    expectEditKept(v.port, v.disk());
    expectNoteIsModel(v.port, v.disk());
  });

  it("committed, the note not written: the IDs allocated are projected, none new", async () => {
    const v = await stopped({ unwritten: true });
    expect(v.disk()).toBe(EDITED);
    await settle(v);
    expect(v.port.changes).toHaveLength(1);
    expectEditKept(v.port, v.disk());
    expectNoteIsModel(v.port, v.disk());
  });

  // In written(): the note on disk has the pass's bindings.
  it("the note written, its base not saved: the bindings on disk are the batch's", async () => {
    const v = await stopped({ bases: "before-save" });
    // The base as before the pass: without the batch, and saying so (none applied).
    expect((await v.bases.load("projection-1"))?.applied).toBeUndefined();
    expect(v.disk()).not.toBe(EDITED);
    expect(v.port.changes).toHaveLength(1);
    await settle(v);
    expect(v.port.changes).toHaveLength(1);
    expectEditKept(v.port, v.disk());
    expectNoteIsModel(v.port, v.disk());
  });

  it("the note written and its base saved, the journal still at committed", async () => {
    const v = await stopped({ bases: "after-save" });
    // The base saved knows it has the batch, which the journal does not yet.
    expect((await v.bases.load("projection-1"))?.applied).toEqual(["op-1"]);
    expect((await v.journal.get("op-1"))?.phase).toBe("committed");
    await settle(v);
    expect(v.port.changes).toHaveLength(1);
    expectEditKept(v.port, v.disk());
    expectNoteIsModel(v.port, v.disk());
  });

  for (const phase of ["projected", "done"] as const)
    it(`the note written, the journal at "${phase}": finishes, nothing sent again`, async () => {
      const v = await stopped({ journal: phase });
      await settle(v);
      expect(v.port.changes).toHaveLength(1);
      expectEditKept(v.port, v.disk());
      expectNoteIsModel(v.port, v.disk());
    });
});
