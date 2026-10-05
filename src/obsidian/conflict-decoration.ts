// Conflict markers in the editor (LFCP-062, item 5): a line decoration on
// bound Tasks whose shared fields have concurrent values. It lives in the
// editor only (a CSS class and a tooltip), never in the note's text.

import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { type ConflictRegistry, conflictTitle } from "../core/projection/conflicts";

const refresh = StateEffect.define<null>();

function build(view: EditorView, registry: ConflictRegistry): DecorationSet {
  const path = view.state.field(editorInfoField, false)?.file?.path;
  const builder = new RangeSetBuilder<Decoration>();
  if (path === undefined) return builder.finish();
  const doc = view.state.doc;
  for (const mark of [...registry.marks(path)].sort((a, b) => a.line - b.line)) {
    if (mark.line >= doc.lines) continue;
    const line = doc.line(mark.line + 1);
    builder.add(
      line.from,
      line.from,
      Decoration.line({ attributes: { class: "openlfcp-conflict", title: conflictTitle(mark) } }),
    );
  }
  return builder.finish();
}

export function conflictDecorations(registry: ConflictRegistry) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      readonly #unsubscribe: () => void;
      constructor(view: EditorView) {
        this.decorations = build(view, registry);
        this.#unsubscribe = registry.onChange(() =>
          queueMicrotask(() => view.dispatch({ effects: refresh.of(null) })),
        );
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refresh))))
          this.decorations = build(u.view, registry);
      }
      destroy(): void {
        this.#unsubscribe();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
