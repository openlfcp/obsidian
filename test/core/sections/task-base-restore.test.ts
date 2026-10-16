// LFCP-03-043 (obsidian#35): a projection without a base (a copied section,
// a note opened without its base) seeds one only when the note shows the
// model. A Task's fields are part of that: a title, checkbox or due date the
// note changed is the user's, kept as a base-unknown comparison candidate,
// never accepted as the base and then overwritten by the model on the next
// pass. Formatting the renderer keeps (the inline ref's place, an unowned
// glyph) is not a difference.

import { fromBase64url, principalId, resourceId } from "@openlfcp/core";
import {
  createTask,
  SharedObjectsReplica,
  setTitle,
  type Task,
  type TaskView,
} from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { MemorySectionBaseStore, markdownState } from "../../../src/core/sections/base";
import {
  applyChanges,
  type EngineDeps,
  type PassContext,
  SectionEngine,
} from "../../../src/core/sections/engine";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { MemorySectionJournalStore } from "../../../src/core/sections/journal";
import { parseSections } from "../../../src/core/sections/parser";
import { FakeSectionPort } from "./fake-port";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const T = "019a2f85-7b31-7c42-b85a-fc843e2f4009";
const S = parseSectionRef(`lfcp1:${R}#section:${SID}`) as SectionRef;
const REF = `<!-- lfcp-ref: lfcp1:${R}#task:${T} -->`;
const me = principalId(new Uint8Array(32).fill(4));
const CTX: PassContext = { caretLine: null, deletedIds: new Set(), origin: "other" };

/** A note whose section holds one Task `line`, its ref on the next line unless the line has it. */
const note = (line: string) =>
  [
    "## Section",
    formatBoundary("start", S),
    line,
    ...(line.includes("lfcp-ref") ? [] : [`  ${REF}`]),
    formatBoundary("end", S),
    "",
  ].join("\n");

const MODEL = note("- [ ] Original 📅 2026-11-01");

function replicaWith(due = "2026-11-01") {
  const { replica } = SharedObjectsReplica.create({
    resource: resourceId(fromBase64url(R)),
    principal: me,
  });
  replica.apply(createTask({ id: T as never, title: "Original", createdBy: me, due }).intent);
  return replica;
}

/** An engine without a base, the model being MODEL's section and `view`'s Task. */
function setup(view: () => TaskView | undefined, stores = fresh()) {
  const port = stores.port;
  const engine = new SectionEngine({
    port,
    bases: stores.bases,
    journal: stores.journal,
    newNodeId: () => T,
    newOperationId: () => `op-${++stores.op}`,
    newProjectionId: () => `projection-${++stores.projection}`,
    createdBy: me,
    tasks: ((_r, id) => (id === T ? { view: view() } : undefined)) as EngineDeps["tasks"],
    newTask: () => ({ id: T, title: "unused" }),
  });
  const run = async (path: string, md: string) => {
    const pass = await engine.pass(path, md, CTX);
    const out = applyChanges(md, pass.changes);
    await engine.written(pass, out);
    return { pass, out };
  };
  return { ...stores, engine, run };
}

function fresh() {
  const port = new FakeSectionPort();
  const s = parseSections(MODEL).sections[0];
  if (s === undefined) throw new Error("no section");
  port.host(R, SID, markdownState(MODEL, s).state);
  return {
    port,
    bases: new MemorySectionBaseStore(),
    journal: new MemorySectionJournalStore(),
    op: 0,
    projection: 0,
  };
}

/** The note's edit survives two passes and a restart: no base, no batch, a candidate. */
async function expectKept(edited: string, view: () => TaskView | undefined) {
  const h = setup(view);
  let projectionId = "";
  for (let i = 0; i < 2; i++) {
    const { pass, out } = await h.run("note.md", edited);
    expect(pass.sections[0]?.skipped, `pass ${i + 1}`).toBe("base-unknown");
    expect(pass.sections[0]?.base).toBeUndefined();
    expect(out, `pass ${i + 1}`).toBe(edited);
    projectionId = pass.sections[0]?.projectionId ?? "";
  }
  // A restart: the same stores, a new engine.
  const again = setup(view, h);
  const { pass, out } = await again.run("note.md", edited);
  expect(pass.sections[0]?.skipped).toBe("base-unknown");
  expect(out).toBe(edited);
  expect(h.port.changes).toEqual([]);
  expect(await h.bases.projectionsOf("note.md")).toEqual([]);
  const candidates = await h.journal.candidates(projectionId);
  expect(candidates.map((c) => c.reason)).toEqual(["base-unknown"]);
  expect(candidates[0]?.sourceText).toContain(edited.split("\n")[2]);
  return h;
}

describe("a Task edit without a base is kept (LFCP-03-043)", () => {
  it("a changed title", async () => {
    const replica = replicaWith();
    await expectKept(note("- [ ] Local edit 📅 2026-11-01"), () => replica.task(T));
    expect(replica.task(T)?.task?.title).toBe("Original");
  });

  it("a ticked checkbox", async () => {
    const replica = replicaWith();
    await expectKept(note("- [x] Original 📅 2026-11-01"), () => replica.task(T));
    expect(replica.task(T)?.task?.status).toBe("todo");
  });

  it("a changed due date", async () => {
    const replica = replicaWith();
    await expectKept(note("- [ ] Original 📅 2026-11-05"), () => replica.task(T));
    expect(replica.task(T)?.task?.due).toBe("2026-11-01");
  });

  it("a removed due date", async () => {
    const replica = replicaWith();
    await expectKept(note("- [ ] Original"), () => replica.task(T));
  });

  it("an edit on the line that holds its inline ref", async () => {
    const replica = replicaWith();
    await expectKept(note(`- [ ] Local edit ${REF} 📅 2026-11-01`), () => replica.task(T));
  });

  it("a copy of the section in another note, without a base, keeps its edit", async () => {
    const replica = replicaWith();
    const h = setup(() => replica.task(T));
    const seeded = await h.run("a.md", MODEL);
    expect(seeded.pass.sections[0]?.base).toBeDefined();
    const copy = note("- [ ] Local edit 📅 2026-11-01");
    for (let i = 0; i < 2; i++) {
      const { pass, out } = await h.run("b.md", copy);
      expect(pass.sections[0]?.skipped).toBe("base-unknown");
      expect(out).toBe(copy);
    }
    expect(await h.bases.projectionsOf("b.md")).toEqual([]);
    expect(h.port.changes).toEqual([]);
    // The original note still shows the model, untouched.
    const a = await h.run("a.md", MODEL);
    expect(a.out).toBe(MODEL);
  });

  it("a Task whose shared object is not here yet is not taken as shown; it seeds once it is", async () => {
    const replica = replicaWith();
    let ready = false;
    const h = setup(() => (ready ? replica.task(T) : undefined));
    const first = await h.run("note.md", MODEL);
    expect(first.pass.sections[0]?.skipped).toBe("base-unknown");
    expect(first.out).toBe(MODEL);
    ready = true;
    const second = await h.run("note.md", MODEL);
    expect(second.pass.sections[0]?.base).toBeDefined();
    expect(second.out).toBe(MODEL);
    expect(await h.journal.candidates(first.pass.sections[0]?.projectionId ?? "")).toEqual([]);
  });

  it("a conflicted title the note shows otherwise than the visible value is kept", async () => {
    const replica = replicaWith();
    const other = SharedObjectsReplica.fromChanges(replica.changes(), {
      resource: resourceId(fromBase64url(R)),
      principal: principalId(new Uint8Array(32).fill(9)),
    }).replica;
    expect(other.task(T)?.task?.title).toBe("Original");
    const theirs = other.apply(setTitle(other.task(T)?.task as Task, "Theirs").intent);
    replica.apply(setTitle(replica.task(T)?.task as Task, "Mine").intent);
    replica.receiveChange(theirs?.change as Uint8Array);
    const view = replica.task(T);
    expect(view?.fields.title.conflicted).toBe(true);
    const visible = String(view?.fields.title.value);
    const other_ = visible === "Mine" ? "Theirs" : "Mine";
    await expectKept(note(`- [ ] ${other_} 📅 2026-11-01`), () => replica.task(T));
  });
});

describe("a note that shows the model's fields seeds its base (LFCP-03-043)", () => {
  const seeds = async (md: string, expected = md) => {
    const replica = replicaWith();
    const h = setup(() => replica.task(T));
    const first = await h.run("note.md", md);
    expect(first.pass.sections[0]?.skipped).toBeUndefined();
    expect(first.pass.sections[0]?.base).toBeDefined();
    expect(h.port.changes).toEqual([]);
    expect(await h.journal.candidates(first.pass.sections[0]?.projectionId ?? "")).toEqual([]);
    const second = await h.run("note.md", first.out);
    expect(second.out).toBe(expected);
    expect(h.port.changes).toEqual([]);
    return replica;
  };

  it("the same fields", async () => {
    await seeds(MODEL);
  });

  it("the inline ref after the fields, the late form (formatting only)", async () => {
    await seeds(
      note(`- [ ] Original 📅 2026-11-01 ${REF}`),
      note(`- [ ] Original ${REF} 📅 2026-11-01`),
    );
  });

  it("the inline ref before the fields (formatting only)", async () => {
    await seeds(note(`- [ ] Original ${REF} 📅 2026-11-01`));
  });

  it("a local recurrence, another list marker and trailing spaces (local pieces)", async () => {
    await seeds(note("* [ ] Original 🔁 every week 📅 2026-11-01  "));
  });

  it("an unowned glyph is the user's presentation, not a status", async () => {
    await seeds(note("- [>] Original 📅 2026-11-01"));
  });
});

describe("a node the base does not know, adopted as the note shows it (LFCP-03-043 review round 2)", () => {
  /** A base for the section that does not know its node: a crash after the note was written, before written(). */
  const lostNode = (h: { bases: MemorySectionBaseStore; port: FakeSectionPort }) =>
    h.bases.save("projection-known", {
      locator: { path: "note.md", section: S },
      state: { title: "Section", nodes: {}, order: {} },
      revision: h.port.snapshot(R, SID)?.revision ?? "",
    });

  it("a note that shows the adopted Task as the model sends nothing", async () => {
    const replica = replicaWith();
    const h = setup(() => replica.task(T));
    await lostNode(h);
    let md = MODEL;
    for (let i = 0; i < 2; i++) md = (await h.run("note.md", md)).out;
    expect(md).toBe(MODEL);
    expect(
      h.port.changes.flatMap((c) => c.intents).filter((i) => i.intent.startsWith("task.")),
    ).toEqual([]);
  });

  it("a collaborator's title after the crash reaches the note; it is never sent back", async () => {
    const replica = replicaWith();
    const h = setup(() => replica.task(T));
    await lostNode(h);
    replica.apply(setTitle(replica.task(T)?.task as Task, "Peer title").intent);
    h.port.remote(R, () => {});
    let md = MODEL;
    for (let i = 0; i < 3; i++) md = (await h.run("note.md", md)).out;
    expect(md).toBe(note("- [ ] Peer title 📅 2026-11-01"));
    expect(replica.task(T)?.task?.title).toBe("Peer title");
    expect(h.port.changes).toEqual([]);
  });

  it("a collaborator's paragraph Text after the crash reaches the note; it is never sent back", async () => {
    const P = "019a2f85-7b31-7c42-b85a-fc843e2f4010";
    const para = (text: string) =>
      [
        "## Section",
        formatBoundary("start", S),
        formatNodeMarker("paragraph", P),
        text,
        formatBoundary("end", S),
        "",
      ].join("\n");
    const port = new FakeSectionPort();
    const model = para("Original text");
    const s = parseSections(model).sections[0];
    if (s === undefined) throw new Error("no section");
    port.host(R, SID, markdownState(model, s).state);
    const h = setup(() => undefined, {
      port,
      bases: new MemorySectionBaseStore(),
      journal: new MemorySectionJournalStore(),
      op: 0,
      projection: 0,
    });
    await lostNode(h);
    port.remote(R, (x) => {
      const n = x.state.nodes[P];
      if (n === undefined) throw new Error("no node");
      x.state = { ...x.state, nodes: { ...x.state.nodes, [P]: { ...n, text: "Peer text" } } };
    });
    let md = model;
    for (let i = 0; i < 3; i++) md = (await h.run("note.md", md)).out;
    expect(md).toBe(para("Peer text"));
    expect(port.sections.get(R)?.state.nodes[P]?.text).toBe("Peer text");
    expect(port.changes).toEqual([]);
  });
});

describe("a pasted node the base does not know is held, not overwritten (LFCP-03-047)", () => {
  const P = "019a2f85-7b31-7c42-b85a-fc843e2f4010";
  /** A base for the section that does not know its node. */
  const unknown = (h: { bases: MemorySectionBaseStore; port: FakeSectionPort }) =>
    h.bases.save("projection-known", {
      locator: { path: "note.md", section: S },
      state: { title: "Section", nodes: {}, order: {} },
      revision: h.port.snapshot(R, SID)?.revision ?? "",
    });
  const pasted = (id: string): PassContext => ({ ...CTX, inserted: new Set([id]) });
  const para = (text: string) =>
    [
      "## Section",
      formatBoundary("start", S),
      formatNodeMarker("paragraph", P),
      text,
      formatBoundary("end", S),
      "",
    ].join("\n");
  function paragraphSetup() {
    const port = new FakeSectionPort();
    const model = para("Original text");
    const s = parseSections(model).sections[0];
    if (s === undefined) throw new Error("no section");
    port.host(R, SID, markdownState(model, s).state);
    return setup(() => undefined, {
      port,
      bases: new MemorySectionBaseStore(),
      journal: new MemorySectionJournalStore(),
      op: 0,
      projection: 0,
    });
  }
  /** One pass as the host runs it, with `ctx`. */
  const runWith = async (h: ReturnType<typeof setup>, md: string, ctx: PassContext) => {
    const pass = await h.engine.pass("note.md", md, ctx);
    const out = applyChanges(md, pass.changes);
    await h.engine.written(pass, out);
    return { pass, out };
  };

  /** The pasted note survives the paste's pass, later passes and a restart: nothing sent, a candidate. */
  async function expectHeld(h: ReturnType<typeof setup>, edited: string, id: string) {
    const first = await runWith(h, edited, pasted(id));
    expect(first.pass.sections[0]?.skipped).toBe("base-unknown");
    expect(first.out).toBe(edited);
    for (let i = 0; i < 2; i++) {
      const { pass, out } = await h.run("note.md", edited);
      expect(pass.sections[0]?.skipped, `pass ${i + 2}`).toBe("base-unknown");
      expect(out, `pass ${i + 2}`).toBe(edited);
    }
    const again = setup(() => undefined, h);
    const after = await again.run("note.md", edited);
    expect(after.out).toBe(edited);
    expect(h.port.changes).toEqual([]);
    expect((await h.bases.load("projection-known"))?.pasted).toEqual([id]);
    const candidates = await h.journal.candidates("projection-known");
    expect(candidates.map((c) => [c.candidateId, c.reason])).toEqual([
      ["pasted:projection-known", "base-unknown"],
    ]);
    expect(candidates[0]?.sourceText).toContain(edited.split("\n")[2]);
  }

  it("a pasted Task with a changed title and date (the reviewer's probe)", async () => {
    const replica = replicaWith();
    const h = setup(() => replica.task(T));
    await unknown(h);
    const edited = note("- [ ] Local edit 📅 2026-11-05");
    const first = await runWith(h, edited, pasted(T));
    expect(first.out).toBe(edited);
    // The rest with the Task readable on every engine, the restart's included.
    const again = setup(() => replica.task(T), h);
    for (let i = 0; i < 3; i++) {
      const { pass, out } = await again.run("note.md", edited);
      expect(pass.sections[0]?.skipped).toBe("base-unknown");
      expect(out).toBe(edited);
    }
    expect(h.port.changes).toEqual([]);
    expect(replica.task(T)?.task?.title).toBe("Original");
    expect(replica.task(T)?.task?.due).toBe("2026-11-01");
    expect((await h.journal.candidates("projection-known")).map((c) => c.reason)).toEqual([
      "base-unknown",
    ]);
  });

  it("a pasted paragraph with changed Text", async () => {
    const h = paragraphSetup();
    await unknown(h);
    await expectHeld(h, para("Local text"), P);
    expect(h.port.sections.get(R)?.state.nodes[P]?.text).toBe("Original text");
  });

  it("a pasted Task the model shows is taken at once, nothing held or kept", async () => {
    const replica = replicaWith();
    const h = setup(() => replica.task(T));
    await unknown(h);
    const { pass, out } = await runWith(h, MODEL, pasted(T));
    expect(pass.sections[0]?.skipped).toBeUndefined();
    expect(out).toBe(MODEL);
    expect((await h.bases.load("projection-known"))?.state.nodes[T]).toBeDefined();
    expect(await h.journal.candidates("projection-known")).toEqual([]);
    expect(h.port.changes).toEqual([]);
  });

  it("held, then the note shows the model there: taken, the hold and its copy end", async () => {
    const h = paragraphSetup();
    await unknown(h);
    await runWith(h, para("Local text"), pasted(P));
    const { pass, out } = await h.run("note.md", para("Original text"));
    expect(pass.sections[0]?.skipped).toBeUndefined();
    expect(out).toBe(para("Original text"));
    const base = await h.bases.load("projection-known");
    expect(base?.state.nodes[P]?.text).toBe("Original text");
    expect(base?.pasted).toBeUndefined();
    expect(await h.journal.candidates("projection-known")).toEqual([]);
    expect(h.port.changes).toEqual([]);
  });

  it("without the user's hint a different node is still taken as shown (D23: the crash case)", async () => {
    const h = paragraphSetup();
    await unknown(h);
    // As the note an older model rendered before a crash: the model wins, nothing is sent.
    const { out } = await h.run("note.md", para("Older text"));
    expect((await h.run("note.md", out)).out).toBe(para("Original text"));
    expect(h.port.changes).toEqual([]);
  });
});
