// The editor's line moves as CodeMirror and Obsidian dispatch them (shapes
// from the native trace on Obsidian 1.14.4): the section editor's filters
// turn them into moves of whole nodes in the same transaction, and name the
// node the user moved (the owner's checks of 0.4.0-beta.10 on macOS).

import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { movedNodes, sectionEditorExtension } from "../../src/obsidian/section-editor";
import { block, lines, taskId, twoVaults } from "../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "- [ ] Delta"];
const titles = (md: string) =>
  lines(md).flatMap((l) => {
    const m = /^\s*- \[.\] (.*)$/.exec(l);
    return m === null ? [] : [m[1] as string];
  });
const offset = (md: string, n: number) =>
  lines(md)
    .slice(0, n)
    .reduce((x, l) => x + l.length + 1, 0);

async function editor() {
  const { a } = await twoVaults(BODY);
  const md = a.note();
  const state = EditorState.create({
    doc: md,
    extensions: sectionEditorExtension({ engine: () => null }).extension,
  });
  return { md, state };
}

describe("Move line up as CodeMirror dispatches it", () => {
  it("Gamma's line alone, the caret on it: Gamma moves with its ref past Beta, and is the one named", async () => {
    const { md, state } = await editor();
    const g = block(md, "Gamma")[0];
    const at = offset(md, g) + 3;
    const s = state.update({ selection: EditorSelection.cursor(at) }).state;
    // CodeMirror's moveLineUp: the line above (Beta's ref line) removed and put back below Gamma.
    const above = offset(md, g - 1);
    const refAbove = lines(md)[g - 1] as string;
    const gammaLine = lines(md)[g] as string;
    const tr = s.update({
      changes: {
        from: above,
        to: above + refAbove.length + 1 + gammaLine.length,
        insert: `${gammaLine}\n${refAbove}`,
      },
      selection: EditorSelection.cursor(at - refAbove.length - 1),
      userEvent: "move.line",
    });
    const after = tr.state.doc.toString();
    expect(titles(after)).toEqual(["Alpha", "Gamma", "Beta", "Delta"]);
    expect(tr.annotation(movedNodes)).toEqual([taskId(md, "Gamma")]);
    const L = lines(after);
    const ng = block(after, "Gamma")[0];
    expect(L[ng + 1]).toContain(taskId(md, "Gamma"));
    expect(L[ng + 3]).toContain(taskId(md, "Beta"));
    // The caret stays on Gamma's line, at the same column.
    expect(tr.state.doc.lineAt(tr.state.selection.main.head).number - 1).toBe(ng);
    expect(tr.state.selection.main.head - tr.state.doc.line(ng + 1).from).toBe(3);
    expect(tr.isUserEvent("move.line")).toBe(true);
  });

  it("the first Task of the section: nothing moves (it would leave the section)", async () => {
    const { md, state } = await editor();
    const a = block(md, "Alpha")[0];
    const at = offset(md, a);
    const s = state.update({ selection: EditorSelection.cursor(at) }).state;
    const markerLine = lines(md)[a - 1] as string;
    const alphaLine = lines(md)[a] as string;
    const above = offset(md, a - 1);
    const tr = s.update({
      changes: {
        from: above,
        to: above + markerLine.length + 1 + alphaLine.length,
        insert: `${alphaLine}\n${markerLine}`,
      },
      selection: EditorSelection.cursor(above),
      userEvent: "move.line",
    });
    expect(tr.state.doc.toString()).toBe(md);
  });
});

describe("Tab and a paste as Obsidian dispatches them", () => {
  it("Tab on Gamma's line indents its ref line too", async () => {
    const { md, state } = await editor();
    const [from, to] = block(md, "Gamma");
    const at = offset(md, from);
    const s = state.update({ selection: EditorSelection.cursor(at + 3) }).state;
    const tr = s.update({ changes: { from: at, insert: "\t" }, userEvent: "input.indent" });
    const L = lines(tr.state.doc.toString());
    expect(L.slice(from, to)).toEqual(
      lines(md)
        .slice(from, to)
        .map((l) => `\t${l}`),
    );
    expect(tr.state.selection.main.head).toBe(at + 4);
  });

  it("Gamma pasted without its trailing newline at the start of Beta's line: on lines of its own", async () => {
    const { md, state } = await editor();
    const [from, to] = block(md, "Gamma");
    const text = lines(md).slice(from, to).join("\n");
    const cut = md.slice(0, offset(md, from)) + md.slice(offset(md, to) - 1);
    const s = state.update({
      changes: { from: 0, to: state.doc.length, insert: cut },
      annotations: Transaction.addToHistory.of(false),
    }).state;
    const at = offset(cut, block(cut, "Beta")[0]);
    const tr = s.update({
      changes: { from: at, insert: text },
      selection: EditorSelection.cursor(at + text.length),
      userEvent: "input.paste",
    });
    const after = tr.state.doc.toString();
    expect(titles(after)).toEqual(["Alpha", "Gamma", "Beta", "Delta"]);
    expect(after).toContain(`${text}\n- [ ] Beta`);
    expect(tr.state.selection.main.head).toBe(at + text.length + 1);
  });
});

describe("a selection never ends inside a binding line", () => {
  it("Shift+Down over a wrapped ref line: the selection ends at the ref's end, or its start going back", async () => {
    const { md, state } = await editor();
    const g = block(md, "Gamma")[0];
    const at = offset(md, g);
    const ref = lines(md)[g + 1] as string;
    const forward = state.update({
      selection: EditorSelection.range(at, offset(md, g + 1) + 17),
      userEvent: "select",
    });
    expect(forward.state.selection.main.head).toBe(offset(md, g + 1) + ref.length);
    expect(forward.state.selection.main.anchor).toBe(at);
    const back = state.update({
      selection: EditorSelection.range(offset(md, g + 2), offset(md, g + 1) + 17),
      userEvent: "select",
    });
    expect(back.state.selection.main.head).toBe(offset(md, g + 1));
    // A caret, a selection ending on a Task's line, or one the plugin sets: left as they are.
    const caret = state.update({
      selection: EditorSelection.cursor(offset(md, g + 1) + 17),
      userEvent: "select",
    });
    expect(caret.state.selection.main.head).toBe(offset(md, g + 1) + 17);
    const plain = state.update({
      selection: EditorSelection.range(at, at + 5),
      userEvent: "select",
    });
    expect(plain.state.selection.main.head).toBe(at + 5);
  });
});
