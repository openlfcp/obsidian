// Shared sections in the editor (LFCP-02-048, decision M5): a quiet line
// along each section's lines, and its binding lines (boundary markers, node
// markers, child-line refs) hidden in Live Preview unless the selection
// touches them or the user shows sharing metadata. Source mode always shows
// them; Reading view never renders HTML comments (host fact H7). Spike and
// measurements: docs/devel/reports/marker-hiding-spike.md.
//
// Boundary cues (LFCP-03-020, UX §8): a soft line under a section's last
// visible line; with an idle cursor on that line "Inside the shared
// section", on the line after the section "Outside the shared section"; at
// a damaged copy's start "Section boundary not determined", and no line
// after it is marked as shared. Cues are widgets: never the note's text.
//
// Block decorations that remove whole lines must come from a state field
// (CodeMirror), hence StateField, not ViewPlugin, for the decorations.

import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import {
  BOUNDARY_CUE_TEXT,
  type BoundaryCue,
  boundaryCues,
  type SectionPresentation,
  sectionPresentation,
} from "../core/sections/presentation";

/** Show (true) or hide (false) sharing metadata in this editor. */
export const setShowMetadata = StateEffect.define<boolean>();

interface Value {
  readonly model: SectionPresentation;
  readonly show: boolean;
  /** The cursor is idle: the last change was a move, not an edit (cues show only then). */
  readonly idle: boolean;
  readonly deco: DecorationSet;
}

const sectionLine = Decoration.line({ class: "openlfcp-section-line" });
const sectionEnd = Decoration.line({ class: "openlfcp-section-line openlfcp-section-end" });
const hiddenLine = Decoration.replace({ block: true });

/**
 * A boundary cue after a line's text (LFCP-03-020). Its words are drawn by
 * CSS from an attribute, so they are not in the line's text content, the
 * clipboard or the note; the screen reader name is the same words.
 */
class CueWidget extends WidgetType {
  constructor(readonly kind: BoundaryCue["kind"]) {
    super();
  }
  override eq(other: CueWidget): boolean {
    return other.kind === this.kind;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = view.dom.ownerDocument.createElement("span");
    el.className = "openlfcp-boundary-cue";
    el.dataset.lfcpUi = "boundary-cue";
    el.dataset.cue = this.kind;
    el.dataset.label = BOUNDARY_CUE_TEXT[this.kind];
    el.setAttribute("role", "note");
    el.setAttribute("aria-label", BOUNDARY_CUE_TEXT[this.kind]);
    el.setAttribute("contenteditable", "false");
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** The line of an idle cursor: one empty selection, and the last change was not an edit. */
function idleCursor(state: EditorState, idle: boolean): number | null {
  const ranges = state.selection.ranges;
  const only = ranges[0];
  if (!idle || ranges.length !== 1 || only === undefined || !only.empty) return null;
  return state.doc.lineAt(only.head).number - 1;
}

function build(
  state: EditorState,
  model: SectionPresentation,
  show: boolean,
  idle: boolean,
): DecorationSet {
  if (model.sections.length === 0 && model.damaged.length === 0) return Decoration.none;
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
  const { ends, cues } = boundaryCues(model, hide, idleCursor(state, idle), doc.lines);
  const end = new Set(ends);
  const ranges = [];
  for (const s of model.sections)
    for (let l = s.from; l <= s.to && l < doc.lines; l++) {
      const line = doc.line(l + 1);
      ranges.push(
        hide.has(l)
          ? hiddenLine.range(line.from, line.to)
          : (end.has(l) ? sectionEnd : sectionLine).range(line.from),
      );
    }
  for (const c of cues) {
    if (c.line >= doc.lines || hide.has(c.line)) continue;
    const at = doc.line(c.line + 1).to;
    ranges.push(Decoration.widget({ widget: new CueWidget(c.kind), side: 1 }).range(at));
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
      return { model, show: show(), idle: false, deco: build(state, model, show(), false) };
    },
    update(value, tr) {
      let next = value.show;
      for (const e of tr.effects) if (e.is(setShowMetadata)) next = e.value;
      const model = tr.docChanged ? sectionPresentation(tr.state.doc.toString()) : value.model;
      const modeChanged =
        tr.startState.field(editorLivePreviewField, false) !==
        tr.state.field(editorLivePreviewField, false);
      if (!tr.docChanged && !tr.selection && next === value.show && !modeChanged) return value;
      // Typing hides the cues; moving the cursor shows them again.
      const idle = tr.docChanged ? false : tr.selection !== undefined ? true : value.idle;
      return { model, show: next, idle, deco: build(tr.state, model, next, idle) };
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
