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
