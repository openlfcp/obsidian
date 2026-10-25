// LFCP-03-020 (UX §8, U03-19): the editor's boundary cues on a real
// CodeMirror state. The soft end sits on the section's last visible line;
// an idle cursor there says inside, on the line after it outside; typing
// hides them; a damaged copy says its boundary is not determined and marks
// no line after it. The note's text never changes.

import { EditorSelection, EditorState } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { formatBoundary, parseSectionRef, type SectionRef } from "../../src/core/sections/grammar";
import { sectionPresentationExtension } from "../../src/obsidian/section-presentation";
import { editorLivePreviewField } from "../mocks/obsidian";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
const S = parseSectionRef(`lfcp1:${R}#section:${id(1)}`) as SectionRef;
const ref = (n: number) => `<!-- lfcp-ref: lfcp1:${R}#task:${id(n)} -->`;

const NOTE = [
  "## Shared", // 1
  formatBoundary("start", S), // 2
  "- [ ] Task", // 3
  `  ${ref(2)}`, // 4
  formatBoundary("end", S), // 5
  "Private.", // 6
].join("\n");

function editor(doc: string) {
  const { extension } = sectionPresentationExtension(() => false);
  return EditorState.create({
    doc,
    extensions: [editorLivePreviewField.init(() => true), extension],
  });
}

/** Line classes and cues, by 1-based line. */
function shown(state: EditorState) {
  const lines: Record<number, string> = {};
  const cues: Record<number, string> = {};
  for (const d of state.facet(EditorView.decorations)) {
    const set = (typeof d === "function" ? null : d) as DecorationSet | null;
    set?.between(0, state.doc.length, (from, _to, deco) => {
      const n = state.doc.lineAt(from).number;
      const spec = deco.spec as { class?: string; widget?: { kind?: string }; block?: boolean };
      if (spec.class !== undefined) lines[n] = spec.class;
      else if (spec.widget?.kind !== undefined) cues[n] = spec.widget.kind;
      else if (spec.block === true) lines[n] = "hidden";
    });
  }
  return { lines, cues };
}

const at = (state: EditorState, line: number) =>
  state.update({ selection: EditorSelection.cursor(state.doc.line(line).from) }).state;

describe("boundary cues in the editor", () => {
  it("a soft end on the last visible line; cues only for an idle cursor near it", () => {
    let s = editor(NOTE);
    expect(shown(s)).toEqual({
      lines: {
        1: "openlfcp-section-line",
        2: "hidden",
        3: "openlfcp-section-line openlfcp-section-end",
        4: "hidden",
        5: "hidden",
      },
      cues: {},
    });
    s = at(s, 3);
    expect(shown(s).cues).toEqual({ 3: "inside" });
    s = at(s, 6);
    expect(shown(s).cues).toEqual({ 6: "outside" });
    s = at(s, 1);
    expect(shown(s).cues).toEqual({});
    // Typing hides the cue; the note holds only what was typed.
    s = at(s, 3);
    s = s.update({ changes: { from: s.doc.line(3).to, insert: "!" } }).state;
    expect(shown(s).cues).toEqual({});
    expect(s.doc.toString()).toBe(NOTE.replace("- [ ] Task", "- [ ] Task!"));
  });

  it("a damaged copy: its boundary is not determined, and no line after it is marked shared", () => {
    const broken = ["Intro", "## Shared", formatBoundary("start", S), "- [ ] A", "Private."].join(
      "\n",
    );
    const s = at(editor(broken), 5);
    expect(shown(s)).toEqual({ lines: {}, cues: { 2: "unknown" } });
    expect(s.doc.toString()).toBe(broken);
  });
});

describe("markers cannot be typed into while metadata is hidden (UX-05)", () => {
  const typeAt = (s: EditorState, pos: number, text: string, event = "input.type") =>
    s.update({ changes: { from: pos, insert: text }, userEvent: event }).state.doc.toString();
  const start = NOTE.indexOf("<!-- lfcp-section");

  it("a letter typed into, before or after a start marker changes nothing", () => {
    const s = editor(NOTE);
    expect(typeAt(s, start, "h")).toBe(NOTE);
    expect(typeAt(s, start + 6, "h")).toBe(NOTE);
    const lineEnd = s.doc.line(2).to;
    expect(typeAt(s, lineEnd, "h")).toBe(NOTE);
  });

  it("deleting a letter of a marker, and pasting into it, change nothing", () => {
    const s = editor(NOTE);
    const del = s.update({
      changes: { from: start + 6, to: start + 7 },
      userEvent: "delete.backward",
    });
    expect(del.state.doc.toString()).toBe(NOTE);
    expect(typeAt(s, start + 6, "xy", "input.paste")).toBe(NOTE);
  });

  it("a line break next to a marker, typing in a Task, and undo still go through", () => {
    const s = editor(NOTE);
    const task = s.doc.line(3).to;
    expect(typeAt(s, task, "!")).toBe(NOTE.replace("- [ ] Task", "- [ ] Task!"));
    expect(typeAt(s, s.doc.line(2).to, "\n")).toContain("-->\n\n");
    expect(typeAt(s, start + 6, "h", "undo")).not.toBe(NOTE);
  });

  it("Tab and Shift+Tab move a Task's ref line with it; a boundary stays at column 0", () => {
    const s = editor(NOTE);
    const ref = s.doc.line(4);
    const indented = s.update({
      changes: { from: ref.from, insert: "  " },
      userEvent: "input.indent",
    });
    expect(indented.state.doc.line(4).text).toBe(`  ${ref.text}`);
    const dedented = indented.state.update({
      changes: { from: ref.from, to: ref.from + 2 },
      userEvent: "delete.dedent",
    });
    expect(dedented.state.doc.line(4).text).toBe(ref.text);
    const boundary = s.doc.line(2);
    const bad = s.update({
      changes: { from: boundary.from, insert: "  " },
      userEvent: "input.indent",
    });
    expect(bad.state.doc.toString()).toBe(NOTE);
  });

  it("a whole line deleted (a cut Task with its ref) is not an edit of the marker", () => {
    const s = editor(NOTE);
    const from = s.doc.line(3).from;
    const to = s.doc.line(4).to + 1;
    const cut = s.update({ changes: { from, to }, userEvent: "delete.cut" }).state.doc.toString();
    expect(cut).not.toContain("Task");
  });

  it("Source mode and the show-metadata setting edit markers as before", () => {
    const shown = EditorState.create({
      doc: NOTE,
      extensions: [
        editorLivePreviewField.init(() => false),
        sectionPresentationExtension(() => false).extension,
      ],
    });
    expect(typeAt(shown, start + 6, "h")).not.toBe(NOTE);
    const metadata = EditorState.create({
      doc: NOTE,
      extensions: [
        editorLivePreviewField.init(() => true),
        sectionPresentationExtension(() => true).extension,
      ],
    });
    expect(typeAt(metadata, start + 6, "h")).not.toBe(NOTE);
  });

  it("typing over a whole marker line is refused, and the refusal is reported", () => {
    let refused = 0;
    const s = EditorState.create({
      doc: NOTE,
      extensions: [
        editorLivePreviewField.init(() => true),
        sectionPresentationExtension(
          () => false,
          () => refused++,
        ).extension,
      ],
    });
    const line = s.doc.line(2);
    const over = s.update({
      changes: { from: line.from, to: line.to, insert: "x" },
      userEvent: "input.type",
    });
    expect(over.state.doc.toString()).toBe(NOTE);
    expect(refused).toBe(1);
    // Deleting that whole line outright is not refused.
    const del = s.update({ changes: { from: line.from, to: line.to }, userEvent: "delete.cut" });
    expect(del.state.doc.line(2).text).toBe("");
    expect(refused).toBe(1);
  });
});
