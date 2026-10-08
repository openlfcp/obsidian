// LFCP-02-045: several projections, each with its own trusted base, and a
// safe rebuild. MS07 (a complete copy is another projection with the same
// identities), MS11 and CM11 (no causal base is guessed after the index is
// lost; comparison candidates are kept), a rename, and two projections of
// one section in one note across a restart. Against the fake SDK port with
// a model, the records in a database that clones values.

import { principalId } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import { markdownState } from "../../../src/core/sections/base";
import { applyChanges, type PassContext, SectionEngine } from "../../../src/core/sections/engine";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import { parseSections } from "../../../src/core/sections/parser";
import {
  type KeyValue,
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { FakeSectionPort } from "./fake-port";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;
const P = id(2);
const section = (text = "Draft") => [
  "## Launch",
  formatBoundary("start", S),
  formatNodeMarker("paragraph", P),
  text,
  formatBoundary("end", S),
];
const note = (...parts: string[][]) => `${parts.map((p) => p.join("\n")).join("\n\n")}\n`;
const CTX: PassContext = { caretLine: null, deletedIds: new Set(), origin: "other" };

function kv(): KeyValue {
  const map = new Map<string, unknown>();
  let chain = Promise.resolve();
  const get = async (k: string) => structuredClone(map.get(k));
  const put = async (k: string, v: unknown) => void map.set(k, structuredClone(v));
  return {
    get,
    put,
    update: (k, change) => {
      chain = chain.then(async () => put(k, change(await get(k))));
      return chain;
    },
  };
}

function setup(model = note(section())) {
  const port = new FakeSectionPort();
  const s = parseSections(model).sections[0];
  if (s === undefined) throw new Error("no section");
  port.host(R, id(1), markdownState(model, s).state);
  const state = kv();
  let n = 100;
  const journal = new KeyValueSectionJournalStore(state);
  const bases = new KeyValueSectionBaseStore(state);
  const engine = () =>
    new SectionEngine({
      port,
      journal,
      bases,
      newNodeId: () => id(n++),
      newOperationId: () => `op-${n++}`,
      createdBy: principalId(new Uint8Array(32).fill(4)),
      newProjectionId: () => `projection-${n++}`,
      tasks: () => undefined,
      newTask: (line, taskId) => ({ id: taskId, title: line }),
    });
  let current = engine();
  const run = async (path: string, md: string) => {
    const pass = await current.pass(path, md, CTX);
    const out = applyChanges(md, pass.changes);
    await current.written(pass, out);
    return { pass, out };
  };
  return {
    port,
    bases,
    journal,
    run,
    restart: () => {
      current = engine();
    },
    model: () => port.sections.get(R)?.state,
  };
}

describe("LFCP-02-045: projections and rebuild", () => {
  it("MS07: a complete copy in another note is another projection of the same identities", async () => {
    const h = setup();
    await h.run("a.md", note(section()));
    // The section copied whole into another note: it shows the model, so it seeds its own base.
    const copy = await h.run("b.md", note(["Private."], section()));
    expect(copy.pass.sections[0]?.base).toBeDefined();
    expect(h.port.changes).toEqual([]);
    const [pa] = await h.bases.projectionsOf("a.md");
    const [pb] = await h.bases.projectionsOf("b.md");
    expect(pa).toBeDefined();
    expect(pb).toBeDefined();
    expect(pa).not.toBe(pb);
    // An edit in the copy is the user's edit against the copy's own base.
    const edited = await h.run("b.md", note(["Private."], section("Draft v2")));
    expect(h.port.changes).toHaveLength(1);
    expect(h.model()?.nodes[P]?.text).toBe("Draft v2");
    // The first note then receives it as a remote change.
    const first = await h.run("a.md", note(section()));
    expect(first.out).toBe(note(section("Draft v2")));
    expect(edited.out).toBe(note(["Private."], section("Draft v2")));
    expect(h.port.changes).toHaveLength(1);
  });

  it("two projections of one section in one note keep their bases across a restart", async () => {
    const h = setup();
    const md = note(section(), section());
    await h.run("a.md", md);
    const ids = await h.bases.projectionsOf("a.md");
    expect(ids).toHaveLength(2);
    h.restart();
    // The second projection edited after the restart: one batch, the first then follows.
    const edited = note(section(), section("Draft v2"));
    const { out } = await h.run("a.md", edited);
    expect(h.port.changes).toHaveLength(1);
    // Snapshots are taken at the start of a pass: the first projection follows on the next one.
    expect(out).toBe(edited);
    const next = await h.run("a.md", out);
    expect(next.out).toBe(note(section("Draft v2"), section("Draft v2")));
    expect(h.port.changes).toHaveLength(1);
    expect(await h.bases.projectionsOf("a.md")).toEqual(ids);
  });

  it("a rename keeps the projection and its base: only the locator changes", async () => {
    const h = setup();
    await h.run("a.md", note(section()));
    const [before] = await h.bases.projectionsOf("a.md");
    await h.bases.rename("a.md", "moved/b.md");
    expect(await h.bases.projectionsOf("moved/b.md")).toEqual([before]);
    const { pass } = await h.run("moved/b.md", note(["Lines above now."], section("Draft v2")));
    expect(pass.sections[0]?.skipped).toBeUndefined();
    expect(h.port.changes).toHaveLength(1);
  });

  it("MS11, CM11: after the index is lost, nothing is uploaded and the source is kept for comparison", async () => {
    const h = setup();
    // No base (lost, or the note was edited with the plugin off): the note differs from the model.
    const stale = note(section("Draft edited while away"));
    const { pass, out } = await h.run("a.md", stale);
    expect(pass.sections[0]?.skipped).toBe("base-unknown");
    expect(out).toBe(stale);
    expect(h.port.changes).toEqual([]);
    const projection = pass.sections[0]?.projectionId as string;
    const [c] = await h.journal.candidates(projection);
    expect(c).toMatchObject({ reason: "base-unknown" });
    expect(c?.sourceText).toContain("Draft edited while away");
    // The same occurrence keeps its provisional projection while it has no base.
    const again = await h.run("a.md", stale);
    expect(again.pass.sections[0]?.projectionId).toBe(projection);
    expect(await h.journal.candidates(projection)).toHaveLength(1);
    // Once the note shows the model again, the base is seeded and the candidate resolved.
    const seeded = await h.run("a.md", note(section()));
    expect(await h.journal.candidates(projection)).toEqual([]);
    expect(await h.bases.projectionsOf("a.md")).toEqual([seeded.pass.sections[0]?.projectionId]);
  });

  it("a standalone ref to a section's Task is not a section projection: nothing is deleted", async () => {
    const h = setup();
    await h.run("a.md", note(section()));
    const standalone = note(["- [ ] Elsewhere", `  <!-- lfcp-ref: lfcp1:${R}#task:${id(9)} -->`]);
    const { pass, out } = await h.run("b.md", standalone);
    expect(pass.sections).toEqual([]);
    expect(out).toBe(standalone);
    expect(h.port.changes).toEqual([]);
    expect(h.model()?.nodes[P]?.text).toBe("Draft");
  });
});
