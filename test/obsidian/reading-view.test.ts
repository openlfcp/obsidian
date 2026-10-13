// @vitest-environment happy-dom
// A note shown only in Reading view (LFCP-02-069). Obsidian keeps the note's
// editor behind its Reading view; a collaborator's change written there was
// never saved, the Reading view kept the old text, the badge said CURRENT,
// and the next switch to editing reloaded the file: the change was gone from
// the note. Now such a note goes by its file: the change is written to the
// file (which the Reading view renders), nothing is written into the hidden
// editor, and back to editing the editor takes the file before any pass, so
// the collaborator's change stays and nothing is sent back.

import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { describe, expect, it } from "vitest";
import type { NotePass, SectionEngine } from "../../src/core/sections/engine";
import { sectionEditorExtension, sectionWrite } from "../../src/obsidian/section-editor";
import { PATH, reconnect, twoVaults, type Vault } from "../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "", "A paragraph."];

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

/** `v`'s engine, its next pass held until released. */
function gated(v: Vault) {
  let hold: Promise<void> | null = null;
  let release = () => {};
  let started = () => {};
  const engine = new Proxy(v.engine, {
    get(target, key, receiver) {
      if (key !== "pass") return Reflect.get(target, key, receiver);
      return async (...args: Parameters<SectionEngine["pass"]>) => {
        const p = await target.pass(...args);
        if (hold !== null) {
          started();
          await hold;
        }
        return p;
      };
    },
  });
  return {
    engine: engine as SectionEngine,
    holdNext(): Promise<void> {
      hold = new Promise((r) => {
        release = () => {
          hold = null;
          r();
        };
      });
      return new Promise((r) => {
        started = r;
      });
    },
    release: () => release(),
  };
}

/** A's note in an editor whose mode the test sets, its file in memory, and B the collaborator. */
async function setup() {
  const { a, b } = await twoVaults(BODY);
  const gate = gated(a);
  let file = a.note();
  const files = {
    rewrite: async (_path: string, fn: (current: string) => string) => {
      file = fn(file);
      return file;
    },
    read: async () => file,
  };
  const passes: NotePass[] = [];
  const timer = {
    set: (fn: () => void) => setTimeout(fn, 0),
    clear: (h: unknown) => clearTimeout(h as number),
  };
  const editor = sectionEditorExtension({
    engine: () => gate.engine,
    files,
    timer,
    onPass: (_p, p) => passes.push(p),
  });
  let mode: "source" | "preview" = "source";
  const info = { file: { path: PATH }, getMode: () => mode };
  const writes: string[] = [];
  const watch = EditorView.updateListener.of((u) => {
    for (const tr of u.transactions)
      if (tr.annotation(sectionWrite) !== undefined) writes.push(tr.newDoc.toString());
  });
  const view = new EditorView({
    doc: file,
    extensions: [editor.extension, watch, editorInfoField.init(() => info as never)],
  });
  /** B renames Beta to `title`; A gets it (the host's remote notice, with the file for a closed note). */
  const rename = async (title: string) => {
    await b.pass(b.note().replace(/- \[ \] Beta[^\n]*\n/, `- [ ] ${title}\n`));
    for (const [res, rb] of b.replicas) a.replicas.get(res)?.receiveChanges(rb.changes());
    editor.remoteChanged(PATH, mode === "preview" ? file : undefined);
    await settle();
  };
  return {
    a,
    b,
    gate,
    editor,
    view,
    passes,
    writes,
    file: () => file,
    setMode: async (m: "source" | "preview") => {
      mode = m;
      editor.refresh();
      await settle();
    },
    rename,
  };
}

describe("a note shown only in Reading view", () => {
  it("a collaborator's change goes to the file, never into the hidden editor", async () => {
    const s = await setup();
    await s.setMode("preview");
    const hidden = s.view.state.doc.toString();
    await s.rename("Beta from B");
    expect(s.file()).toContain("- [ ] Beta from B");
    expect(s.view.state.doc.toString()).toBe(hidden);
    expect(s.writes).toEqual([]);
    s.view.destroy();
  });

  it("back to editing: the editor takes the file first; the change stays, A sends nothing back", async () => {
    const s = await setup();
    await s.setMode("preview");
    await s.rename("Beta from B");
    const before = s.passes.length;
    await s.setMode("source");
    // The editor holds the file as written before the note is opened again.
    expect(s.view.state.doc.toString()).toBe(s.file());
    // Any pass since commits nothing (it plans on the file's text, the base's).
    await settle();
    for (const p of s.passes.slice(before))
      expect(p.sections.every((r) => r.local?.kind !== "committed")).toBe(true);
    await reconnect(s.a, s.b);
    expect(s.b.note()).toContain("- [ ] Beta from B");
    expect(s.a.model()?.nodes).toEqual(s.b.model()?.nodes);
    s.view.destroy();
  });

  it("a pass in flight when the view goes into Reading view writes nothing into the editor", async () => {
    const s = await setup();
    // B's change arrives while A edits; its pass is held.
    await s.b.pass(s.b.note().replace("- [ ] Beta\n", "- [ ] Beta held\n"));
    for (const [res, rb] of s.b.replicas) s.a.replicas.get(res)?.receiveChanges(rb.changes());
    const held = s.gate.holdNext();
    s.editor.remoteChanged(PATH);
    await held;
    const before = s.view.state.doc.toString();
    // The user switches to Reading view; then the pass finishes.
    await s.setMode("preview");
    s.gate.release();
    await settle();
    expect(s.view.state.doc.toString()).toBe(before);
    expect(s.writes).toEqual([]);
    // The note went by its file: the change is there.
    expect(s.file()).toContain("- [ ] Beta held");
    s.view.destroy();
  });
});
