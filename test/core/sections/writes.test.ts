// LFCP-02-042: the plugin's own writes come back as no intent; everything
// else in the same note, before or after them, is still reconciled.

import { describe, expect, it } from "vitest";
import { markdownState, planSection, type SectionState } from "../../../src/core/sections/base";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { parseSections } from "../../../src/core/sections/parser";
import type { ModelNode, SectionSnapshot } from "../../../src/core/sections/port";
import { applyRemote, planRemote, type RemotePatch } from "../../../src/core/sections/remote";
import {
  type GeneratedWrite,
  GeneratedWrites,
  pendingBase,
} from "../../../src/core/sections/writes";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;
const A = id(2);
const B = id(3);
const PATH = "Launch.md";

const note = (a: string, b: string, title = "Launch") =>
  [
    `## ${title}`,
    formatBoundary("start", S),
    formatNodeMarker("paragraph", A),
    a,
    "",
    formatNodeMarker("paragraph", B),
    b,
    formatBoundary("end", S),
    "",
  ].join("\n");

const stateOf = (md: string): SectionState => {
  const s = parseSections(md).sections[0];
  if (s === undefined) throw new Error("no section");
  return markdownState(md, s).state;
};

const model = (
  base: SectionState,
  texts: Record<string, string>,
  title?: string,
): SectionSnapshot => {
  const nodes: Record<string, ModelNode> = {};
  for (const [k, n] of Object.entries(base.nodes))
    nodes[k] = {
      kind: n.kind,
      parent: n.parent,
      lifecycle: "active",
      text: texts[k] ?? n.text ?? "",
    };
  return {
    revision: "h2",
    title: title ?? base.title,
    ready: true,
    nodes,
    order: base.order,
    problems: [],
  };
};

/** A remote change to A, planned and recorded as a write, and the note it produces. */
function remoteWrite(writes: GeneratedWrites, md: string, text: string, op = "op-1") {
  const prior = stateOf(md);
  const section = parseSections(md).sections[0];
  if (section === undefined) throw new Error("no section");
  const patch = planRemote(
    md,
    section,
    prior,
    model(prior, { [A]: text }),
    () => undefined,
  ) as RemotePatch;
  const content = applyRemote(md, patch) as string;
  const write = writes.record({
    operationId: op,
    projectionId: "p1",
    path: PATH,
    before: patch.sourceRevision,
    prior,
    next: patch.base,
    content,
  });
  return { prior, content, write };
}

/** The user's intents in `md` against `base` (the shared state equals the base: nothing else pending). */
const intents = (base: SectionState, md: string) => {
  const p = planSection(base, stateOf(md), base);
  return { title: p.title, textEdits: p.textEdits, moves: p.moves, missing: p.missing };
};

const NONE = { title: undefined, textEdits: [], moves: [], missing: [] };

describe("recognizing the plugin's own writes", () => {
  it("knows an editor transaction by its operation ID, once", () => {
    const writes = new GeneratedWrites();
    const { write } = remoteWrite(writes, note("Draft", "Notes"), "Draft v2");
    expect(writes.ownTransaction("op-1")).toEqual(write);
    expect(writes.ownTransaction("op-1")).toBeUndefined();
  });

  it("knows a file event by its exact content; a repeated event is no longer its own, and still sends nothing", () => {
    const writes = new GeneratedWrites();
    const { content, write } = remoteWrite(writes, note("Draft", "Notes"), "Draft v2");
    expect(writes.observe(PATH, content)).toEqual(write);
    expect(intents(write.next, content)).toEqual(NONE);
    // The vault reports the same file again.
    expect(writes.observe(PATH, content)).toBeUndefined();
    expect(intents(write.next, content)).toEqual(NONE);
  });

  it("consumes older writes of the path with the one seen", () => {
    const writes = new GeneratedWrites();
    const md = note("Draft", "Notes");
    const first = remoteWrite(writes, md, "Draft v2", "op-1");
    const second = remoteWrite(writes, first.content, "Draft v3", "op-2");
    expect(writes.observe(PATH, second.content)?.operationId).toBe("op-2");
    expect(writes.pendingFor("p1")).toEqual([]);
  });

  it("forgets abandoned writes, and follows a rename", () => {
    const writes = new GeneratedWrites();
    const { content } = remoteWrite(writes, note("Draft", "Notes"), "Draft v2");
    writes.rename(PATH, "Renamed.md");
    expect(writes.observe(PATH, content)).toBeUndefined();
    expect(writes.pendingFor("p1").map((w) => w.path)).toEqual(["Renamed.md"]);
    writes.abandon("op-1");
    expect(writes.observe("Renamed.md", content)).toBeUndefined();
  });
});

describe("reconciling while a write is pending", () => {
  it("sends only the user's edit when they typed elsewhere in the note after the write", () => {
    const writes = new GeneratedWrites();
    const { content, write } = remoteWrite(writes, note("Draft", "Notes"), "Draft v2");
    writes.confirm("op-1");
    const typed = content.replace("Notes", "Notes and more");
    expect(writes.observe(PATH, typed)).toBeUndefined();
    const [w] = writes.pendingFor("p1");
    const p = intents(pendingBase(w as GeneratedWrite, stateOf(typed)), typed);
    expect(p.textEdits).toEqual([
      { nodeId: B, edit: { index: 5, deleteCount: 0, insert: " and more" } },
    ]);
  });

  it("does not repeat the remote change when the user typed on top of a confirmed write", () => {
    const writes = new GeneratedWrites();
    const { content } = remoteWrite(writes, note("Draft", "Notes"), "Draft v2");
    writes.confirm("op-1");
    const typed = content.replace("Draft v2", "Draft v2!");
    const [w] = writes.pendingFor("p1");
    const p = intents(pendingBase(w as GeneratedWrite, stateOf(typed)), typed);
    expect(p.textEdits).toEqual([{ nodeId: A, edit: { index: 8, deleteCount: 0, insert: "!" } }]);
  });

  it("never reverts a remote change whose write was lost to an external one (the 0.3.1 race)", () => {
    const writes = new GeneratedWrites();
    const md = note("Draft", "Notes");
    remoteWrite(writes, md, "Draft v2");
    // Another program rewrote the file from the old content, with its own change to B.
    const external = md.replace("Notes", "Notes ✅");
    const [w] = writes.pendingFor("p1");
    // Against the written base, "Draft" would read as the user's edit and revert the change.
    expect(intents((w as GeneratedWrite).next, external).textEdits).toContainEqual(
      expect.objectContaining({ nodeId: A }),
    );
    const p = intents(pendingBase(w as GeneratedWrite, stateOf(external)), external);
    expect(p.textEdits).toEqual([{ nodeId: B, edit: { index: 5, deleteCount: 0, insert: " ✅" } }]);
  });

  it("keeps an unconfirmed write's node on the prior base when it changed from both", () => {
    const writes = new GeneratedWrites();
    const md = note("Draft", "Notes");
    remoteWrite(writes, md, "Draft v2");
    const other = md.replace("Draft", "Draft (mine)");
    const [w] = writes.pendingFor("p1");
    const p = intents(pendingBase(w as GeneratedWrite, stateOf(other)), other);
    expect(p.textEdits).toEqual([
      { nodeId: A, edit: { index: 5, deleteCount: 0, insert: " (mine)" } },
    ]);
  });

  it("a written title and a removal follow the note too", () => {
    const writes = new GeneratedWrites();
    const md = note("Draft", "Notes");
    const prior = stateOf(md);
    const section = parseSections(md).sections[0];
    if (section === undefined) throw new Error("no section");
    const m = model(prior, {}, "Launch plan");
    const deleted: SectionSnapshot = {
      ...m,
      nodes: { ...m.nodes, [B]: { ...(m.nodes[B] as ModelNode), lifecycle: "deleted" } },
    };
    const patch = planRemote(md, section, prior, deleted, () => undefined) as RemotePatch;
    const content = applyRemote(md, patch) as string;
    const write = writes.record({
      operationId: "op-1",
      projectionId: "p1",
      path: PATH,
      before: patch.sourceRevision,
      prior,
      next: patch.base,
      content,
    });
    // Landed: no intent; lost: no intent either (no deletion is inferred, no title sent back).
    expect(intents(pendingBase(write, stateOf(content)), content)).toEqual(NONE);
    expect(intents(pendingBase(write, stateOf(md)), md)).toEqual(NONE);
  });

  it("a marker insertion (a newly bound node) is no intent", () => {
    const md = note("Draft", "Notes");
    const bound = stateOf(md);
    const prior: SectionState = {
      ...bound,
      nodes: { [A]: bound.nodes[A] as never },
      order: { "": [A] },
    };
    const writes = new GeneratedWrites();
    const write = writes.record({
      operationId: "op-1",
      projectionId: "p1",
      path: PATH,
      before: "x",
      prior,
      next: bound,
      content: md,
    });
    expect(intents(pendingBase(write, stateOf(md)), md)).toEqual(NONE);
  });
});
