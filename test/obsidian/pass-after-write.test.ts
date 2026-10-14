// @vitest-environment happy-dom
// The safety net after a write (soak #5): a pass that wrote a
// collaborator's change and reported the note as not the model's (here a
// Task "shown again", as a pass judging the text it read rather than the
// text it wrote did) is followed by exactly one more pass on the written
// note, whose result is the one the badge gets. That pass never asks for
// another: a fact that stays is left for the badge, never a loop.

import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { describe, expect, it } from "vitest";
import type { NotePass, SectionEngine } from "../../src/core/sections/engine";
import { sectionEditorExtension } from "../../src/obsidian/section-editor";
import { PATH, twoVaults } from "../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "", "A paragraph."];
const PHANTOM = "019a2f85-7b31-7c42-b85a-fc843e2f40ff";

const settle = async () => {
  for (let i = 0; i < 80; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A's note in an editor; `stale(p)` says which passes report the phantom as shown again. */
async function setup(stale: (p: NotePass) => boolean) {
  const { a, b } = await twoVaults(BODY);
  const engine = new Proxy(a.engine, {
    get(target, key, receiver) {
      if (key !== "pass") return Reflect.get(target, key, receiver);
      return async (...args: Parameters<SectionEngine["pass"]>) => {
        const p = await target.pass(...args);
        if (!stale(p)) return p;
        return { ...p, sections: p.sections.map((s) => ({ ...s, reappeared: [PHANTOM] })) };
      };
    },
  }) as SectionEngine;
  let file = a.note();
  const passes: NotePass[] = [];
  const editor = sectionEditorExtension({
    engine: () => engine,
    files: {
      rewrite: async (_p: string, fn: (c: string) => string) => {
        file = fn(file);
        return file;
      },
      read: async () => file,
    },
    timer: {
      set: (fn: () => void) => setTimeout(fn, 0),
      clear: (h: unknown) => clearTimeout(h as number),
    },
    onPass: (_path, p) => passes.push(p),
  });
  const info = { file: { path: PATH }, getMode: () => "source" };
  const view = new EditorView({
    doc: file,
    extensions: [editor.extension, editorInfoField.init(() => info as never)],
  });
  /** B renames Beta; A's editor hears of it. */
  const rename = async (title: string) => {
    await b.pass(b.note().replace(/- \[ \] Beta[^\n]*\n/, `- [ ] ${title}\n`));
    for (const [res, rb] of b.replicas) a.replicas.get(res)?.receiveChanges(rb.changes());
    editor.remoteChanged(PATH);
    await settle();
  };
  return { view, passes, rename };
}

const wroteRemote = (p: NotePass) =>
  p.sections.some((s) => s.remote?.kind === "patch" && s.remote.changes.length > 0);

describe("one more pass after a write that reported the note as not the model's", () => {
  it("runs once, and its clean result is the last the badge gets", async () => {
    const s = await setup(wroteRemote);
    const before = s.passes.length;
    await s.rename("Beta from B");
    const after = s.passes.slice(before);
    expect(s.view.state.doc.toString()).toContain("- [ ] Beta from B");
    expect(after.length).toBe(2);
    expect(after[0]?.sections[0]?.reappeared).toEqual([PHANTOM]);
    expect(after[1]?.sections[0]?.reappeared).toBeUndefined();
    s.view.destroy();
  });

  it("a fact that stays after it is left for the badge: no loop", async () => {
    const s = await setup(() => true);
    const before = s.passes.length;
    await s.rename("Beta again");
    await settle();
    expect(s.passes.length - before).toBe(2);
    s.view.destroy();
  });

  it("a clean write asks for no more pass", async () => {
    const s = await setup(() => false);
    const before = s.passes.length;
    await s.rename("Beta clean");
    expect(s.passes.length - before).toBe(1);
    s.view.destroy();
  });
});
