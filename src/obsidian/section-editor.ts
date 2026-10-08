// Shared sections in the open editor (LFCP-02-041..043, ADR 0001): the
// CodeMirror side of the section engine. Not registered by the plugin yet;
// the SDK binding comes first (the native harness runs it on a fake).
//
// - Every user transaction is seen (ADR 0001 S1). Our own writes carry the
//   `sectionWrite` annotation and are never taken for the user's edits (§2).
// - No parsing or SDK call in `update`: it only notes which bindings the
//   user's transaction removed, the undo/redo origin, and tells the
//   scheduler (input.ts), which runs a pass after idle, at composition end
//   or at blur, never during a composition.
// - Passes go through the coordinator (one per note at a time, the editor
//   newer than the file). A pass's changes are dispatched only onto the
//   document revision they were computed for; if the user typed meanwhile,
//   the pass is abandoned and runs again on the new document (§3).
// - Our writes stay out of the user's undo history (addToHistory false).

import { Annotation, type Extension, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { contentHash } from "../core/projection/guard";
import { type PassRequest, SourceCoordinator } from "../core/sections/coordinator";
import type { NotePass, PassContext, SectionEngine } from "../core/sections/engine";
import { ReconcileScheduler, type Timer } from "../core/sections/input";
import { type ChangeOrigin, originOf } from "../core/sections/undo";

/** The plugin's own writes into a note, by pass (ADR 0001 §2). */
export const sectionWrite = Annotation.define<string>();

/** IDs in the binding comments of a removed text: node markers and Task refs. */
const BINDING_ID =
  /<!--[ \t]+(?:lfcp-node:[ \t]*(?:paragraph|item|raw):|lfcp-ref:[^>]*#task:)[ \t]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

export type EditorSyncStatus = "edited" | "reconciling" | "idle" | "error";

export interface SectionEditorOptions {
  readonly engine: SectionEngine;
  readonly timer?: Timer;
  /** The note's sync status changed (SI02: "edited" at the first keystroke). */
  readonly onStatus?: (path: string, status: EditorSyncStatus) => void;
  /** A pass finished and was written (diagnostics, tests). */
  readonly onPass?: (path: string, pass: NotePass) => void;
  readonly onError?: (path: string, error: unknown) => void;
}

interface ViewState {
  path: string | null;
  readonly id: string;
  readonly scheduler: ReconcileScheduler;
  deletedIds: Set<string>;
  origin: ChangeOrigin;
}

const defaultTimer: Timer = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (h) => window.clearTimeout(h as number),
};

export function sectionEditorExtension(o: SectionEditorOptions): {
  readonly extension: Extension;
  /** The shared state of a note's sections changed: project it into its open editor. */
  remoteChanged(path: string): void;
  readonly views: ReadonlyMap<EditorView, { readonly path: string | null }>;
} {
  const views = new Map<EditorView, ViewState>();
  let nextId = 0;
  const status = (path: string, s: EditorSyncStatus) => o.onStatus?.(path, s);

  const viewOf = (path: string): [EditorView, ViewState] | undefined => {
    let found: [EditorView, ViewState] | undefined;
    for (const [view, st] of views)
      if (st.path === path && (found === undefined || view.hasFocus)) found = [view, st];
    return found;
  };

  const reconcile = async (req: PassRequest): Promise<void> => {
    // Closed notes go through the vault path of the plugin, not this extension.
    const open = req.route === "editor" ? viewOf(req.path) : undefined;
    if (open === undefined) return;
    const [view, st] = open;
    status(req.path, "reconciling");
    const deletedIds = st.deletedIds;
    st.deletedIds = new Set();
    const caret = view.hasFocus
      ? view.state.doc.lineAt(view.state.selection.main.head).number - 1
      : null;
    const ctx: PassContext = { caretLine: caret, deletedIds, origin: st.origin };
    st.origin = "other";
    const pass = await o.engine.pass(req.path, req.source, ctx);
    const current = view.state.doc.toString();
    if (contentHash(current) !== pass.sourceRevision) {
      // The user typed meanwhile: nothing is written; the pass runs again on the new document.
      o.engine.abandoned(pass);
      for (const id of deletedIds) st.deletedIds.add(id);
      coordinator.editorChanged(req.path, current);
      return;
    }
    if (pass.changes.length > 0)
      view.dispatch({
        changes: pass.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
        annotations: [sectionWrite.of(pass.sourceRevision), Transaction.addToHistory.of(false)],
      });
    await o.engine.written(pass, view.state.doc.toString());
    o.onPass?.(req.path, pass);
    status(req.path, st.scheduler.dirty ? "edited" : "idle");
  };

  const coordinator = new SourceCoordinator(reconcile, (path, error) => {
    status(path, "error");
    o.onError?.(path, error);
  });

  const pathOf = (view: EditorView) => view.state.field(editorInfoField, false)?.file?.path ?? null;

  class SectionSync {
    readonly st: ViewState;

    constructor(readonly view: EditorView) {
      const id = `view-${nextId++}`;
      this.st = {
        path: null,
        id,
        scheduler: new ReconcileScheduler(
          () => {
            if (this.st.path !== null)
              coordinator.editorChanged(this.st.path, this.view.state.doc.toString());
          },
          o.timer ?? defaultTimer,
          () => {
            if (this.st.path !== null) status(this.st.path, "edited");
          },
        ),
        deletedIds: new Set(),
        origin: "other",
      };
      views.set(view, this.st);
      this.#follow();
    }

    /** The view shows a note (or another one now): the coordinator knows it as open. */
    #follow(): void {
      const path = pathOf(this.view);
      if (path === this.st.path) return;
      if (this.st.path !== null) coordinator.closed(this.st.path, this.st.id);
      this.st.path = path;
      if (path !== null) coordinator.opened(path, this.st.id, this.view.state.doc.toString());
    }

    update(u: ViewUpdate): void {
      this.#follow();
      if (!u.docChanged) return;
      let edited = false;
      for (const tr of u.transactions) {
        if (!tr.docChanged || tr.annotation(sectionWrite) !== undefined) continue;
        edited = true;
        const origin = originOf(tr.annotation(Transaction.userEvent));
        if (origin !== "other") this.st.origin = origin;
        tr.changes.iterChanges((fromA, toA) => {
          if (toA <= fromA) return;
          for (const m of tr.startState.doc.sliceString(fromA, toA).matchAll(BINDING_ID))
            if (m[1] !== undefined) this.st.deletedIds.add(m[1]);
        });
      }
      if (edited) this.st.scheduler.edit(this.view.composing);
    }

    destroy(): void {
      this.st.scheduler.dispose();
      if (this.st.path !== null) coordinator.closed(this.st.path, this.st.id);
      views.delete(this.view);
    }
  }

  const plugin = ViewPlugin.fromClass(SectionSync);
  const events = EditorView.domEventHandlers({
    compositionstart: (_e, view) => {
      view.plugin(plugin)?.st.scheduler.compositionStart();
    },
    compositionend: (_e, view) => {
      view.plugin(plugin)?.st.scheduler.compositionEnd();
    },
    blur: (_e, view) => {
      view.plugin(plugin)?.st.scheduler.blur();
    },
  });

  return {
    extension: [plugin, events],
    remoteChanged: (path) => coordinator.remoteChanged(path),
    views,
  };
}
