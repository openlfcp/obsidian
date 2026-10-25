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

import { EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
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
import { pluginEdit, sectionWrite } from "./section-editor";

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
const damagedLine = Decoration.line({ class: "openlfcp-marker-damaged" });

/**
 * A damaged marker while sharing metadata is hidden (UX-05): the line's text
 * is replaced by this warning, so it is found, not read as part of the note.
 * Putting the cursor on the line shows the text, to be edited.
 */
class DamagedMarkerWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = view.dom.ownerDocument.createElement("span");
    el.className = "openlfcp-marker-damaged-chip";
    el.dataset.lfcpUi = "damaged-marker";
    el.textContent = "Shared section line changed";
    el.setAttribute("role", "note");
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}
const damagedChip = Decoration.replace({ widget: new DamagedMarkerWidget() });

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

const BOUNDARY_TEXT = /^[ \t]*<!--\s*\/?\s*lfcp-section\b/;

/**
 * Whether a change edits the text of a binding line (not the lines around
 * it, and not the whole line at once): typing into a marker, deleting a
 * part of it, or gluing text onto it. A change that covers the whole line is
 * a deletion of the line (a cut, a deleted Task), which the editor's other
 * guards govern, as they do a deleted line break beside it.
 */
export function editsBindingText(
  doc: EditorState["doc"],
  binding: ReadonlySet<number>,
  from: number,
  to: number,
  insert: string,
): boolean {
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    if (!binding.has(n - 1)) continue;
    const line = doc.line(n);
    // The whole line, with its text, goes: not an edit of it.
    if (from <= line.from && to >= line.to && to > from) continue;
    // The indentation of a node marker or a Task's ref (Tab, Shift+Tab move it with its
    // Task): whitespace only, within the leading whitespace. A section boundary stays at column 0.
    if (!BOUNDARY_TEXT.test(line.text) && /^[ \t]*$/.test(insert)) {
      const indentEnd = line.from + (/^[ \t]*/.exec(line.text)?.[0].length ?? 0);
      if (from >= line.from && to <= indentEnd) continue;
    }
    if (from === to) {
      // A pure insertion: a line break at the line's start or end leaves it as it is.
      if (from === line.from && insert.endsWith("\n")) continue;
      if (from === line.to && insert.startsWith("\n")) continue;
      return true;
    }
    // A deletion into the line's text. A line break beside it is the editor's other
    // guards' (a result that glues text onto a marker is refused there).
    if (from < line.to && to > line.from) return true;
  }
  return false;
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
  if (model.sections.length === 0 && model.damaged.length === 0 && model.malformed.length === 0)
    return Decoration.none;
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
  const hideDamaged =
    !show && state.field(editorLivePreviewField, false) === true && model.malformed.length > 0;
  for (const l of model.malformed) {
    if (l >= doc.lines) continue;
    const line = doc.line(l + 1);
    ranges.push(damagedLine.range(line.from));
    // Not on a line the selection touches: its text is shown there to be edited.
    const touched = state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
    if (hideDamaged && !touched && line.to > line.from)
      ranges.push(damagedChip.range(line.from, line.to));
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
  // With sharing metadata hidden in Live Preview, the user's typing, pasting
  // and deleting cannot change a marker's text (UX-05): one typed letter made
  // a section unreadable and stopped its sync. Undo and redo, the plugin's own
  // writes and other plugins' (no user event) always go through; Source mode
  // and "Show sharing metadata" edit markers as before.
  const protectMarkers = EditorState.transactionFilter.of((tr) => {
    if (
      !tr.docChanged ||
      tr.annotation(sectionWrite) !== undefined ||
      tr.annotation(pluginEdit) !== undefined ||
      !(tr.isUserEvent("input") || tr.isUserEvent("delete")) ||
      tr.isUserEvent("undo") ||
      tr.isUserEvent("redo")
    )
      return tr;
    const value = tr.startState.field(field, false);
    if (value === undefined || value.show || value.model.bindingLines.length === 0) return tr;
    if (tr.startState.field(editorLivePreviewField, false) !== true) return tr;
    const binding = new Set(value.model.bindingLines);
    let blocked = false;
    tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      if (!blocked && editsBindingText(tr.startState.doc, binding, from, to, inserted.toString()))
        blocked = true;
    });
    return blocked ? [] : tr;
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
  return { extension: [field, protectMarkers, registry], views };
}
