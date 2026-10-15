// @vitest-environment happy-dom
// A closed note's file pass that ends after the note was opened, while the
// user's deletion there waits for its pass (LFCP-03-016). The pass after a
// section was inserted into a closed note ran long enough for the peer to
// open the note and delete a Task before it was written (live
// sections-remote-delete with that pass). The file pass settled the
// file's text, the same as the opened editor's first document, so the
// coordinator ran no pass on it and dropped what the editor had noted: the
// deletion was passed later as a lost binding, never sent, and the other
// note kept the Task. An editor that shows other text than the one settled
// keeps its hints.

import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { describe, expect, it } from "vitest";
import type { NotePass } from "../../src/core/sections/engine";
import { sectionEditorExtension } from "../../src/obsidian/section-editor";
import { block, PATH, taskId, twoVaults } from "../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma"];

describe("a file pass ending after the note was opened and edited", () => {
  it("keeps the editor's deletion: it is sent, not passed as a lost binding", async () => {
    const { a } = await twoVaults(BODY);
    let file = a.note();
    const beta = taskId(file, "Beta");
    // The file pass waits at its write until released.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let due: (() => void)[] = [];
    const passes: NotePass[] = [];
    const editor = sectionEditorExtension({
      engine: () => a.engine,
      files: {
        rewrite: async (_p, fn) => {
          await gate;
          file = fn(file);
          return file;
        },
        read: async () => file,
      },
      timer: {
        set: (fn: () => void) => {
          due.push(fn);
          return fn;
        },
        clear: (h: unknown) => {
          due = due.filter((f) => f !== h);
        },
      },
      onPass: (_path, p) => passes.push(p),
    });
    const turn = () => new Promise((r) => setTimeout(r, 0));

    // The closed note is passed (the insertion's pass), and its file event comes meanwhile.
    editor.remoteChanged(PATH, file);
    await turn();
    editor.fileChanged(PATH, file);
    // The user opens the note and deletes Beta before its pass runs.
    const info = { file: { path: PATH }, getMode: () => "source" };
    const view = new EditorView({
      doc: file,
      extensions: [editor.extension, editorInfoField.init(() => info as never)],
    });
    const [from, to] = block(file, "Beta");
    const lines = file.split("\n");
    const start = lines.slice(0, from).join("\n").length + 1;
    const end = lines.slice(0, to).join("\n").length + 1;
    view.dispatch(
      view.state.update({ changes: { from: start, to: end }, userEvent: "delete.cut" }),
    );
    expect(view.state.doc.toString()).not.toContain("Beta");

    // The file pass is written now, before the editor's idle timer fires; then its pass runs.
    release();
    for (let i = 0; i < 20; i++) await turn();
    for (let i = 0; i < 50; i++) {
      const now = due;
      due = [];
      for (const fn of now) fn();
      await turn();
    }

    const last = passes.at(-1);
    expect(last?.sections[0]?.lost).toEqual([]);
    expect(last?.sections[0]?.local?.kind).toBe("committed");
    const node = a.model()?.nodes[beta];
    expect(node === undefined || node.lifecycle !== "active").toBe(true);
    view.destroy();
  });
});
