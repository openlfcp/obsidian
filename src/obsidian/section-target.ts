// The target of a section action in Obsidian (LFCP-03-009): the editor an
// action starts from, read once into a TargetCapture (core/sections/
// target.ts). The executor keeps that snapshot and the note's held
// identity; it never reads this editor again, so a tab switched to another
// note, or focus moved to a pane, cannot redirect the flow.

import type { EditorView } from "@codemirror/view";
import { type Editor, editorLivePreviewField, type MarkdownView } from "obsidian";
import type { EditorMode, TargetCapture, TextSelection } from "../core/sections/target";

/** The CodeMirror view behind an Obsidian editor, when it has one. */
const cmOf = (editor: Editor): EditorView | undefined =>
  (editor as Editor & { cm?: EditorView }).cm;

/** The editor's selection ranges, empty ones included. */
function selectionsOf(editor: Editor, cm: EditorView | undefined): TextSelection[] {
  if (cm !== undefined) {
    const pos = (offset: number) => {
      const line = cm.state.doc.lineAt(offset);
      return { line: line.number - 1, ch: offset - line.from };
    };
    return cm.state.selection.ranges.map((r) => ({ anchor: pos(r.anchor), head: pos(r.head) }));
  }
  const e = editor as Partial<Editor>;
  if (typeof e.listSelections === "function")
    return e.listSelections().map((s) => ({ anchor: s.anchor, head: s.head }));
  if (e.somethingSelected?.() === true)
    return [{ anchor: editor.getCursor("from"), head: editor.getCursor("to") }];
  return [];
}

/** Whether an input method is composing in the editor (IME): its text is not final yet. */
function composing(cm: EditorView | undefined): boolean {
  return cm !== undefined && (cm.composing || cm.compositionStarted);
}

/** The view's mode: Reading view, else Live Preview or Source (from the editor's state). */
export function editorMode(view: MarkdownView | null, editor: Editor): EditorMode {
  if (view?.getMode() === "preview") return "reading";
  const cm = cmOf(editor);
  const live = cm?.state.field(editorLivePreviewField, false);
  return live === true ? "live-preview" : "source";
}

/** The note in `editor` as the action found it: text, cursor, selections, mode, composition. */
export function captureEditor(editor: Editor, path: string, mode: EditorMode): TargetCapture {
  const cm = cmOf(editor);
  return {
    path,
    text: editor.getValue(),
    mode,
    cursorLine: editor.getCursor().line,
    selections: selectionsOf(editor, cm),
    composing: composing(cm),
  };
}
