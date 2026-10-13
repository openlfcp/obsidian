// @vitest-environment happy-dom
// The hints of a pass whose batch was refused (SectionResult.unsent), through
// the section editor as the host runs it: the user deletes Beta; the batch
// is refused (here once, by hand; the peer-structure property test, seed
// 3365, met INVALID_PREDECESSOR) and kept. Up to 0.4.0-beta.15 the pass took
// the deletion hint along: the next pass found Beta gone without it, a lost
// binding, the section suspended. Now the next pass of the note gets the
// hints again and sends the deletion; none outlive the pass that sends them,
// and a rename of the note takes them along, never to another note.

import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { describe, expect, it } from "vitest";
import type { PassContext } from "../../src/core/sections/engine";
import { CommitRefused } from "../../src/core/sections/port";
import { sectionEditorExtension } from "../../src/obsidian/section-editor";
import { block, lines, PATH, taskId, twoVaults } from "../support/section-vaults";

async function setup() {
  const { a } = await twoVaults(["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma"]);
  let due: (() => void)[] = [];
  const timer = {
    set: (fn: () => void) => {
      due.push(fn);
      return fn;
    },
    clear: (h: unknown) => {
      due = due.filter((f) => f !== h);
    },
  };
  // Every pass's hints, by note.
  const seen: { path: string; deletedIds: string[] }[] = [];
  const pass = a.engine.pass.bind(a.engine);
  a.engine.pass = async (path: string, md: string, ctx: PassContext) => {
    seen.push({ path, deletedIds: [...ctx.deletedIds] });
    const p = await pass(path, md, ctx);
    return p;
  };
  // The next commit is refused.
  let refuse = false;
  const port = a.port as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>;
  for (const k of ["commit", "submit"]) {
    const f = port[k];
    if (f === undefined) continue;
    port[k] = (...x: unknown[]) => {
      if (refuse) {
        refuse = false;
        return Promise.reject(new CommitRefused("INVALID_PREDECESSOR"));
      }
      return f.apply(a.port, x);
    };
  }
  const editor = sectionEditorExtension({ engine: () => a.engine, timer });
  // The field holds the note's view, whose file Obsidian renames in place.
  const open = (doc: string, info: { file: { path: string } }) =>
    new EditorView({
      doc,
      extensions: [editor.extension, editorInfoField.init(() => info as never)],
    });
  const info = { file: { path: PATH } };
  const view = open(a.note(), info);
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      const now = due;
      due = [];
      for (const fn of now) fn();
      await new Promise((r) => setTimeout(r, 0));
      if (now.length === 0 && due.length === 0 && i > 3) break;
    }
  };
  /** The user deletes Beta's line and its ref (one Backspace over the selection). */
  const deleteBeta = () => {
    const md = view.state.doc.toString();
    const [from, to] = block(md, "Beta");
    const at = (n: number) =>
      lines(md)
        .slice(0, n)
        .reduce((x, l) => x + l.length + 1, 0);
    view.dispatch({ changes: { from: at(from), to: at(to) }, userEvent: "delete" });
  };
  /** The user types at the end of the note's last line. */
  const type = (v: EditorView, text: string) =>
    v.dispatch({ changes: { from: v.state.doc.length, insert: text }, userEvent: "input.type" });
  return {
    a,
    editor,
    view,
    open,
    info,
    seen,
    settle,
    deleteBeta,
    type,
    refuseNext: () => {
      refuse = true;
    },
  };
}

describe("hints of a pass whose batch was refused", () => {
  it("go to the note's next pass, which sends the deletion; none outlive it", async () => {
    const t = await setup();
    const beta = taskId(t.a.note(), "Beta");
    t.refuseNext();
    t.deleteBeta();
    await t.settle();
    expect(t.a.model()?.nodes[beta]?.lifecycle).toBe("active");
    // The next pass (the user types elsewhere) has Beta's deletion again, and sends it.
    t.type(t.view, "\nmore");
    await t.settle();
    expect(t.seen.at(-1)?.deletedIds).toContain(beta);
    expect(t.a.model()?.nodes[beta]?.lifecycle).toBe("deleted");
    // Sent: the pass after has no hint of it.
    t.type(t.view, " text");
    await t.settle();
    expect(t.seen.at(-1)?.deletedIds).toEqual([]);
  });

  it("follow the note's rename, never to another note at the old path", async () => {
    const t = await setup();
    const beta = taskId(t.a.note(), "Beta");
    t.refuseNext();
    t.deleteBeta();
    await t.settle();
    // Renamed: the host renames the projections and the editor's records; the view follows.
    await t.a.bases.rename(PATH, "Renamed.md");
    t.editor.renamed(PATH, "Renamed.md");
    t.info.file.path = "Renamed.md";
    t.view.dispatch({ selection: { anchor: 0 } });
    // A new note at the old path, edited: its pass has none of the hints.
    const other = t.open("# A new note\n", { file: { path: PATH } });
    t.type(other, "\ntext");
    await t.settle();
    const atOld = t.seen.filter((s) => s.path === PATH).at(-1);
    expect(atOld?.deletedIds ?? []).toEqual([]);
    // The renamed note's next pass has them, and sends the deletion.
    t.type(t.view, "\nmore");
    await t.settle();
    const atNew = t.seen.filter((s) => s.path === "Renamed.md").at(-1);
    expect(atNew?.deletedIds).toContain(beta);
    expect(t.a.model()?.nodes[beta]?.lifecycle).toBe("deleted");
  });
});
