// Shared sections in the editor (LFCP-02-048, decision M5): a quiet line
// along each section's lines, and its binding lines (boundary markers, node
// markers, child-line refs) hidden in Live Preview unless the selection
// touches them or the user shows sharing metadata. Source mode always shows
// them; Reading view never renders HTML comments (host fact H7). Spike and
// measurements: docs/devel/reports/marker-hiding-spike.md.
//
// Block decorations that remove whole lines must come from a state field
// (CodeMirror), hence StateField, not ViewPlugin, for the decorations.

import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { type SectionPresentation, sectionPresentation } from "../core/sections/presentation";

/** Show (true) or hide (false) sharing metadata in this editor. */
export const setShowMetadata = StateEffect.define<boolean>();

interface Value {
  readonly model: SectionPresentation;
  readonly show: boolean;
  readonly deco: DecorationSet;
}

const sectionLine = Decoration.line({ class: "openlfcp-section-line" });
const hiddenLine = Decoration.replace({ block: true });

function build(state: EditorState, model: SectionPresentation, show: boolean): DecorationSet {
  if (model.sections.length === 0) return Decoration.none;
  const doc = state.doc;
  const hide =
    !show && state.field(editorLivePreviewField, false) === true
      ? new Set(model.bindingLines)
      : new Set<number>();
  // Lines the selection touches stay visible, so a marker can be inspected and edited.
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number - 1;
    const b = doc.lineAt(r.to).number - 1;
    for (let l = a; l <= b; l++) hide.delete(l);
  }
  const ranges = [];
  for (const s of model.sections)
    for (let l = s.from; l <= s.to && l < doc.lines; l++) {
      const line = doc.line(l + 1);
      ranges.push(
        hide.has(l) ? hiddenLine.range(line.from, line.to) : sectionLine.range(line.from),
      );
    }
  return Decoration.set(ranges, true);
}

/**
 * The editor extension and the live editors it is in (to switch them all
 * when the setting changes). `show` is the setting's value at creation.
 */
export function sectionPresentationExtension(show: () => boolean): {
  readonly extension: Extension;
  readonly views: ReadonlySet<EditorView>;
} {
  const views = new Set<EditorView>();
  const field = StateField.define<Value>({
    create: (state) => {
      const model = sectionPresentation(state.doc.toString());
      return { model, show: show(), deco: build(state, model, show()) };
    },
    update(value, tr) {
      let next = value.show;
      for (const e of tr.effects) if (e.is(setShowMetadata)) next = e.value;
      const model = tr.docChanged ? sectionPresentation(tr.state.doc.toString()) : value.model;
      const modeChanged =
        tr.startState.field(editorLivePreviewField, false) !==
        tr.state.field(editorLivePreviewField, false);
      if (!tr.docChanged && !tr.selection && next === value.show && !modeChanged) return value;
      return { model, show: next, deco: build(tr.state, model, next) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
  const registry = ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        views.add(view);
      }
      destroy(): void {
        views.delete(this.view);
      }
    },
  );
  return { extension: [field, registry], views };
}
