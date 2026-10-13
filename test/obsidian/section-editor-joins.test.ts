// A one-character delete next to a binding line, as CodeMirror dispatches it
// (deleteCharBackward / deleteCharForward: one line break removed, nothing
// inserted): the section editor's filter never joins a line to a section
// marker, a node marker or a ref line. Backspace at column 0 leaves the
// document and takes the caret to the end of the nearest visible line above
// (in Live Preview the hidden binding lines are skipped); Delete at a line's
// end leaves both. A blank line next to a marker, and lines without
// bindings, still join (the native trace of 0.4.0-beta.13, Live Preview).

import { EditorSelection, EditorState } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import { describe, expect, it } from "vitest";
import { sectionEditorExtension } from "../../src/obsidian/section-editor";
import { lines, twoVaults } from "../support/section-vaults";

const BODY = ["- [ ] Alpha", "- [ ] Beta", "", "A paragraph.", "", "- [ ] Gamma"];

async function note() {
  const { a } = await twoVaults(BODY);
  return a.note();
}

function editor(doc: string, livePreview: boolean) {
  return EditorState.create({
    doc,
    extensions: [
      sectionEditorExtension({ engine: () => null }).extension,
      editorLivePreviewField.init(() => livePreview),
    ],
  });
}

const lineIndex = (md: string, test: (l: string) => boolean) => {
  const at = lines(md).findIndex(test);
  if (at < 0) throw new Error("no such line");
  return at;
};

/** Backspace at column 0 of line `n` (0-based), as deleteCharBackward dispatches it. */
function backspace(state: EditorState, n: number) {
  const line = state.doc.line(n + 1);
  const s = state.update({ selection: EditorSelection.cursor(line.from) }).state;
  return s.update({
    changes: { from: line.from - 1, to: line.from },
    selection: EditorSelection.cursor(line.from - 1),
    userEvent: "delete.backward",
  }).state;
}

/** Delete at the end of line `n` (0-based), as deleteCharForward dispatches it. */
function del(state: EditorState, n: number) {
  const line = state.doc.line(n + 1);
  const s = state.update({ selection: EditorSelection.cursor(line.to) }).state;
  return s.update({ changes: { from: line.to, to: line.to + 1 }, userEvent: "delete.forward" })
    .state;
}

const caret = (s: EditorState) => {
  const head = s.selection.main.head;
  const line = s.doc.lineAt(head);
  return { line: line.number - 1, ch: head - line.from };
};

const START = (l: string) => l.startsWith("<!-- lfcp-section:");
const END = (l: string) => l.startsWith("<!-- /lfcp-section:");
const REF = (l: string) => l.includes("<!-- lfcp-ref:");
const NODE = (l: string) => l.startsWith("<!-- lfcp-node:");

describe("Backspace at column 0 under a binding line", () => {
  it("the first Task under the start marker: no change; Live Preview takes the caret to the heading's end", async () => {
    const md = await note();
    const alpha = lineIndex(md, (l) => l === "- [ ] Alpha");
    expect(START(lines(md)[alpha - 1] as string)).toBe(true);
    const lp = backspace(editor(md, true), alpha);
    expect(lp.doc.toString()).toBe(md);
    expect(caret(lp)).toEqual({ line: alpha - 2, ch: "## Plan".length });
    // Source mode shows the marker: the caret goes to its end.
    const source = backspace(editor(md, false), alpha);
    expect(source.doc.toString()).toBe(md);
    expect(caret(source)).toEqual({ line: alpha - 1, ch: (lines(md)[alpha - 1] as string).length });
  });

  it("a middle Task under the previous Task's ref: no change, never Alpha's line glued to Beta's", async () => {
    const md = await note();
    const beta = lineIndex(md, (l) => l === "- [ ] Beta");
    expect(REF(lines(md)[beta - 1] as string)).toBe(true);
    const lp = backspace(editor(md, true), beta);
    expect(lp.doc.toString()).toBe(md);
    expect(lp.doc.toString()).not.toContain("Alpha- [ ] Beta");
    expect(caret(lp)).toEqual({ line: beta - 2, ch: "- [ ] Alpha".length });
  });

  it("a paragraph's text under its node marker: no change", async () => {
    const md = await note();
    const p = lineIndex(md, (l) => l === "A paragraph.");
    expect(NODE(lines(md)[p - 1] as string)).toBe(true);
    const lp = backspace(editor(md, true), p);
    expect(lp.doc.toString()).toBe(md);
    // Hidden lines above are skipped: the blank line before the marker is the nearest visible one.
    expect(lines(md)[p - 2]).toBe("");
    expect(caret(lp)).toEqual({ line: p - 2, ch: 0 });
  });

  it("a binding line itself (Source mode, the caret at a ref's start, at the end marker's start): no change", async () => {
    const md = await note();
    const ref = lineIndex(md, REF);
    expect(backspace(editor(md, false), ref).doc.toString()).toBe(md);
    const end = lineIndex(md, END);
    expect(backspace(editor(md, false), end).doc.toString()).toBe(md);
  });

  it("no visible line above: no change, the caret stays", () => {
    const md = ["<!-- lfcp-section: lfcp1:abc#section:x -->", "- [ ] Alpha", ""].join("\n");
    const s = backspace(editor(md, true), 1);
    expect(s.doc.toString()).toBe(md);
    expect(caret(s)).toEqual({ line: 1, ch: 0 });
  });
});

describe("Delete at the end of the line above a binding line", () => {
  it("the heading above the start marker: no change, the caret stays", async () => {
    const md = await note();
    const h = lineIndex(md, (l) => l === "## Plan");
    for (const live of [true, false]) {
      const s = del(editor(md, live), h);
      expect(s.doc.toString()).toBe(md);
      expect(caret(s)).toEqual({ line: h, ch: "## Plan".length });
    }
  });

  it("the last Task's ref above the end marker, and a Task above its own ref: no change", async () => {
    const md = await note();
    const end = lineIndex(md, END);
    expect(REF(lines(md)[end - 1] as string)).toBe(true);
    const s = del(editor(md, true), end - 1);
    expect(s.doc.toString()).toBe(md);
    expect(caret(s)).toEqual({ line: end - 1, ch: (lines(md)[end - 1] as string).length });
    const gamma = lineIndex(md, (l) => l === "- [ ] Gamma");
    expect(del(editor(md, true), gamma).doc.toString()).toBe(md);
  });

  it("the end marker above the line after the section: no change", async () => {
    const md = `${await note()}After\n`;
    const end = lineIndex(md, END);
    expect(del(editor(md, false), end).doc.toString()).toBe(md);
  });
});

describe("joins the filter lets through", () => {
  it("two plain lines: Backspace and Delete join them", () => {
    const md = "Intro\nmore text\n";
    expect(backspace(editor(md, true), 1).doc.toString()).toBe("Intromore text\n");
    expect(del(editor(md, false), 0).doc.toString()).toBe("Intromore text\n");
  });

  it("a blank line under a node marker (an empty paragraph's line): Backspace deletes it", async () => {
    const md = await note();
    const p = lineIndex(md, (l) => l === "A paragraph.");
    // A blank line between the marker and its text, as an empty paragraph shows.
    const L = lines(md);
    L.splice(p, 0, "");
    const doc = L.join("\n");
    expect(backspace(editor(doc, true), p).doc.toString()).toBe(md);
  });

  it("a blank line above the start marker: Delete at the end of the blank line removes it", async () => {
    const md = await note();
    const start = lineIndex(md, START);
    const L = lines(md);
    L.splice(start, 0, "");
    const doc = L.join("\n");
    expect(del(editor(doc, true), start).doc.toString()).toBe(md);
  });

  it("a selection over whole lines goes its own way (not a one-character delete)", async () => {
    const md = await note();
    const beta = lineIndex(md, (l) => l === "- [ ] Beta");
    const s = editor(md, true);
    const from = s.doc.line(beta + 1).from;
    const to = s.doc.line(beta + 3).from;
    const after = s.update({ changes: { from, to }, userEvent: "delete.selection" }).state;
    expect(after.doc.toString()).not.toContain("- [ ] Beta");
  });
});
