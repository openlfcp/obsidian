// @vitest-environment happy-dom
// A bound Task's line selected whole (the owner's check of 0.4.0-beta.19:
// with the mouse from its end to its start), then cut or deleted: its
// hidden ref line stayed behind, alone and damaged. The editor now takes
// the Task's own binding lines along: the cut's selection before the
// editor copies it (the clipboard holds the whole Task), the delete's range.

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { describe, expect, it } from "vitest";
import { sectionEditorExtension } from "../../src/obsidian/section-editor";
import { PATH, twoVaults } from "../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Gamma", "  - [ ] Delta", "- [ ] Omega", "", "A paragraph."];

async function setup() {
  const { a } = await twoVaults(BODY);
  let file = a.note();
  const editor = sectionEditorExtension({
    engine: () => a.engine,
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
  });
  const info = { file: { path: PATH }, getMode: () => "source" };
  const view = new EditorView({
    doc: file,
    extensions: [editor.extension, editorInfoField.init(() => info as never)],
  });
  const line = (title: string) => {
    const doc = view.state.doc;
    for (let n = 1; n <= doc.lines; n++)
      if (doc.line(n).text.includes(`] ${title}`)) return doc.line(n);
    throw new Error(`no ${title}`);
  };
  return { view, line };
}

const orphanRefs = (md: string) => {
  const L = md.split("\n");
  return L.filter((l, i) => l.includes("lfcp-ref:") && !/- \[.\] /.test(L[i - 1] ?? "")).length;
};

describe("a bound Task's whole line, cut or deleted", () => {
  it("Backspace on the line's text removes the Task with its ref, not its child", async () => {
    const { view, line } = await setup();
    const g = line("Gamma");
    view.dispatch({ selection: EditorSelection.range(g.to, g.from) });
    view.dispatch(
      view.state.update({ changes: { from: g.from, to: g.to }, userEvent: "delete.backward" }),
    );
    const md = view.state.doc.toString();
    expect(md).not.toContain("Gamma");
    expect(md).toContain("  - [ ] Delta");
    expect(orphanRefs(md)).toBe(0);
    view.destroy();
  });

  it("a cut widens the selection over the ref before the editor copies it", async () => {
    const { view, line } = await setup();
    const g = line("Gamma");
    view.dispatch({ selection: EditorSelection.range(g.to, g.from) });
    // The selection the plugin's cut handler sets, before the editor copies it.
    let atCut = "";
    const dispatch = view.dispatch.bind(view);
    view.dispatch = ((...specs: Parameters<EditorView["dispatch"]>) => {
      const spec = specs[0] as { selection?: unknown; changes?: unknown };
      if (atCut === "" && spec?.selection !== undefined && spec.changes === undefined) {
        dispatch(...specs);
        const r = view.state.selection.main;
        atCut = view.state.sliceDoc(r.from, r.to);
        return;
      }
      dispatch(...specs);
    }) as EditorView["dispatch"];
    view.contentDOM.dispatchEvent(new Event("cut", { bubbles: true, cancelable: true }));
    expect(atCut.split("\n")[0]).toBe("- [ ] Gamma");
    expect(atCut.split("\n")[1]).toMatch(/^ {2}<!-- lfcp-ref: /);
    expect(atCut).not.toContain("Delta");
    expect(orphanRefs(view.state.doc.toString())).toBe(0);
    view.destroy();
  });
});
