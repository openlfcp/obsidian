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

import {
  Annotation,
  EditorSelection,
  EditorState,
  type Extension,
  type Text,
  Transaction,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { contentHash } from "../core/projection/guard";
import { type PassRequest, SourceCoordinator } from "../core/sections/coordinator";
import {
  applyChanges,
  type NotePass,
  type PassContext,
  type SectionEngine,
} from "../core/sections/engine";
import type { SectionRef } from "../core/sections/grammar";
import { ReconcileScheduler, type Timer } from "../core/sections/input";
import {
  cutKeepsIndent,
  indentWithNode,
  moveNodeLines,
  pasteOnOwnLines,
  withBindingLines,
} from "../core/sections/line-moves";
import { parseSections, type SectionNode } from "../core/sections/parser";
import {
  classifyRemoval,
  keepMarkerWithParagraph,
  keepRefWithTask,
  type PastedBinding,
  pasteBindings,
} from "../core/sections/rules";
import { SessionCut } from "../core/sections/session-cut";
import { type ChangeOrigin, originOf } from "../core/sections/undo";

/**
 * The plugin's own edits of an open note outside a pass (Review conflicts,
 * Keep it deleted, Use shared version, repair, detach, a share or an
 * insert): reconciled like any edit, but never what the user moved, deleted
 * or cut, and not another plugin's (the owner's trace of 0.4.0-beta.10).
 */
export const pluginEdit = Annotation.define<true>();

/** The plugin's own writes into a note, by pass (ADR 0001 §2). */
export const sectionWrite = Annotation.define<string>();

/**
 * Bound nodes a user transaction removed with every one of their lines (a
 * deletion, rules.ts, §7); a node only partly removed (its marker, its ref)
 * is not one: it is NODE_BINDING_LOST. Parsed only when the removed text
 * holds a binding comment.
 */
function removedWithEveryLine(tr: Transaction): string[] {
  const removed: { from: number; to: number }[] = [];
  let bindings = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (toA <= fromA) return;
    removed.push({ from: fromA, to: toA });
    if (BINDING_ID.test(tr.startState.doc.sliceString(fromA, toA))) bindings = true;
    BINDING_ID.lastIndex = 0;
  });
  if (!bindings) return [];
  const doc = tr.startState.doc;
  // A line is removed when the removed text covers all of it (its content, not only its ending).
  const lines: { from: number; to: number }[] = [];
  for (const r of removed) {
    const a = doc.lineAt(r.from);
    const b = doc.lineAt(Math.max(r.from, r.to - 1));
    for (let n = a.number; n <= b.number; n++) {
      const line = doc.line(n);
      if (r.from <= line.from && r.to >= line.to) lines.push({ from: n - 1, to: n - 1 });
    }
  }
  const out: string[] = [];
  const walk = (ns: readonly SectionNode[]) => {
    for (const n of ns) {
      if (n.id !== null && classifyRemoval(n, lines) === "delete") out.push(n.id);
      walk(n.children);
    }
  };
  for (const s of parseSections(doc.toString()).sections) walk(s.nodes);
  return out;
}

/**
 * The nodes a Move line moved (line-moves.ts): the nodes under the selection,
 * not the neighbour the editor's change happens to re-insert.
 */
export const movedNodes = Annotation.define<readonly string[]>();

/** The bound nodes whose binding comments a transaction inserted (a paste, a drop). */
function insertedBindings(tr: Transaction): string[] {
  const out: string[] = [];
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    const text = inserted.toString();
    if (!text.includes("lfcp-")) return;
    for (const m of text.matchAll(BINDING_ID)) if (m[1] !== undefined) out.push(m[1]);
  });
  return out;
}

/** A line that only carries a binding: a section marker, a node marker, a child-line ref. */
const BINDING_LINE = /^[ \t]*<!--[ \t]+\/?lfcp-(?:section|node|ref):[^>]*-->[ \t]*$/;
const BINDING = /<!--[ \t]+\/?lfcp-(?:section|node|ref):[^>]*-->/g;

/** How many lines of `doc` are `binding` alone. */
function aloneCount(doc: Text, binding: string): number {
  const text = doc.toString();
  let n = 0;
  for (let at = text.indexOf(binding); at >= 0; at = text.indexOf(binding, at + binding.length))
    if (BINDING_LINE.test(doc.lineAt(at).text)) n++;
  return n;
}

/**
 * Whether `tr` leaves a binding (a section or node marker, a ref) that stood
 * alone on its line sharing a line with other text: a line it changed holds
 * a binding and more, and fewer lines are that binding alone than before.
 */
export function gluesBinding(tr: Transaction): boolean {
  const doc = tr.newDoc;
  const seen = new Set<string>();
  let glued = false;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (glued) return;
    for (let n = doc.lineAt(fromB).number; n <= doc.lineAt(toB).number; n++) {
      const text = doc.line(n).text;
      if (BINDING_LINE.test(text)) continue;
      for (const m of text.matchAll(BINDING)) {
        const binding = m[0];
        if (seen.has(binding)) continue;
        seen.add(binding);
        if (aloneCount(doc, binding) < aloneCount(tr.startState.doc, binding)) glued = true;
      }
    }
  });
  return glued;
}

/**
 * What a user transaction tells the next pass (PassContext): the bound
 * nodes it removed with their bindings, and those it put where they are
 * now. A Move line moves the nodes under the selection, whatever its change
 * re-inserted (CodeMirror moves the neighbour the other way), and deletes
 * nothing, though its change rewrites both nodes' lines.
 */
export function editHints(tr: Transaction): {
  readonly removed: string[];
  readonly inserted: readonly string[];
} {
  // Only the user's own edits say what the user moved or deleted: not
  // another plugin's, Obsidian's commands or API (no userEvent), the
  // plugin's own edits, nor a note reloaded from disk ("set").
  if (
    tr.annotation(pluginEdit) !== undefined ||
    tr.annotation(Transaction.userEvent) === undefined ||
    tr.isUserEvent("set")
  )
    return { removed: [], inserted: [] };
  const moveLine = tr.isUserEvent("move.line");
  const moved = tr.annotation(movedNodes);
  return {
    removed: moveLine ? [] : removedWithEveryLine(tr),
    inserted: moved ?? (moveLine ? [] : insertedBindings(tr)),
  };
}

/** Hints kept per note for its next pass, when the view that noted them is gone. */
export class PendingHints {
  readonly #byPath = new Map<string, { deletedIds: Set<string>; inserted: Set<string> }>();

  add(
    path: string,
    hints: { readonly deletedIds: ReadonlySet<string>; readonly inserted: ReadonlySet<string> },
  ): void {
    if (hints.deletedIds.size === 0 && hints.inserted.size === 0) return;
    const h = this.#byPath.get(path) ?? {
      deletedIds: new Set<string>(),
      inserted: new Set<string>(),
    };
    for (const id of hints.deletedIds) h.deletedIds.add(id);
    for (const id of hints.inserted) h.inserted.add(id);
    this.#byPath.set(path, h);
  }

  /** The hints kept for `path`, taken (none afterwards). */
  take(path: string): { deletedIds: Set<string>; inserted: Set<string> } {
    const h = this.#byPath.get(path) ?? {
      deletedIds: new Set<string>(),
      inserted: new Set<string>(),
    };
    this.#byPath.delete(path);
    return h;
  }

  rename(oldPath: string, newPath: string): void {
    const h = this.#byPath.get(oldPath);
    if (h === undefined) return;
    this.#byPath.delete(oldPath);
    this.add(newPath, h);
  }
}

/**
 * The hints a pass of `source` gets: a node noted as removed that the note
 * still binds, and that was not pasted, was put back (undone, typed back):
 * it is no longer removed. A node noted as inserted (pasted, moved by Move
 * line) that the note no longer binds was removed since: it is no longer
 * inserted (both hints for one node came to a pass of the peer-structure
 * property test, seed 3365).
 */
export function freshHints<T extends { deletedIds: Set<string>; inserted: Set<string> }>(
  hints: T,
  source: string,
): T {
  const bound = boundIds(source);
  for (const id of hints.deletedIds)
    if (bound.has(id) && !hints.inserted.has(id)) hints.deletedIds.delete(id);
  for (const id of hints.inserted) if (!bound.has(id)) hints.inserted.delete(id);
  return hints;
}

/** The bound IDs of a note's binding comments (node markers and Task refs). */
function boundIds(markdown: string): Set<string> {
  const out = new Set<string>();
  if (!markdown.includes("lfcp-")) return out;
  for (const m of markdown.matchAll(BINDING_ID)) if (m[1] !== undefined) out.add(m[1]);
  return out;
}

/** IDs in the binding comments of a removed text: node markers and Task refs. */
const BINDING_ID =
  /<!--[ \t]+(?:lfcp-node:[ \t]*(?:paragraph|item|raw):|lfcp-ref:[^>]*#task:)[ \t]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

export type EditorSyncStatus = "edited" | "reconciling" | "idle" | "error";

/** Closed notes: read and atomic read-modify-write (Obsidian's vault.process). */
export interface SectionFiles {
  rewrite(path: string, fn: (current: string) => string): Promise<string | null>;
  /** The note's file as it is now (null: gone); asked before a closed note's pass commits. */
  read?(path: string): Promise<string | null>;
}

export interface SectionEditorOptions {
  /** The engine, once the runtime is ready (null before: nothing is reconciled). */
  readonly engine: () => SectionEngine | null;
  /** The route of closed notes; without it, only open editors are reconciled. */
  readonly files?: SectionFiles;
  readonly timer?: Timer;
  /** The note's sync status changed (SI02: "edited" at the first keystroke). */
  readonly onStatus?: (path: string, status: EditorSyncStatus) => void;
  /** A pass finished and was written (diagnostics, tests). */
  readonly onPass?: (path: string, pass: NotePass) => void;
  readonly onError?: (path: string, error: unknown) => void;
  /** Nodes the user chose to restore where a note shows them (PassContext.restore). */
  readonly restore?: () => ReadonlySet<string>;
  /**
   * Whether a binding in pasted or dropped text binds its own node where it
   * lands (`into`: the section, or null outside every section). Without it,
   * pasted text is left as it is.
   */
  readonly keepPasted?: (binding: PastedBinding, into: SectionRef | null) => boolean;
}

interface ViewState {
  path: string | null;
  readonly id: string;
  readonly scheduler: ReconcileScheduler;
  deletedIds: Set<string>;
  /** Bound nodes whose bindings the user's transactions inserted since the last pass. */
  inserted: Set<string>;
  origin: ChangeOrigin;
  /** A transaction without a userEvent (another plugin's edit) since the last pass. */
  external: boolean;
  /**
   * The note this view stopped following when it went into Reading view: on
   * its way back to editing, it is opened only once its editor holds the
   * file as written (reopen()).
   */
  hidden: string | null;
}

const defaultTimer: Timer = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (h) => window.clearTimeout(h as number),
};

export function sectionEditorExtension(o: SectionEditorOptions): {
  readonly extension: Extension;
  /** The shared state of a note's sections changed (`content`: a closed note's file as just read). */
  remoteChanged(path: string, content?: string): void;
  /** A view's mode or note may have changed (Obsidian's layout-change): each view follows again. */
  refresh(): void;
  /** A share bound `path` as `text`: its next pass seeds the section's first base from that text. */
  seed(path: string, text: string): void;
  /** A note's file changed on disk (reconciled when the note is closed). */
  fileChanged(path: string, content: string): void;
  renamed(oldPath: string, newPath: string): void;
  deleted(path: string): void;
  readonly views: ReadonlyMap<EditorView, { readonly path: string | null }>;
} {
  const views = new Map<EditorView, ViewState>();
  let nextId = 0;
  /**
   * The session's last cut (session-cut.ts): only to recognise its paste in
   * the note it was cut from, never a move hint on its own, and gone once
   * its paste is restored or another cut supersedes it.
   */
  const sessionCut = new SessionCut();
  /** A written pass restored these nodes (node.restore): their paste is done. */
  const restoredBy = (pass: NotePass): string[] =>
    pass.sections.flatMap((r) =>
      r.local?.kind === "committed"
        ? (r.local.entry.intents ?? []).flatMap((i) =>
            i.intent === "node.restore" ? [(i as { readonly id: string }).id] : [],
          )
        : [],
    );
  const status = (path: string, s: EditorSyncStatus) => o.onStatus?.(path, s);

  /** The hints every view of `path` collected for the next pass; they are taken (the views start afresh). */
  /**
   * Hints of views that closed, or turned to another note, before their pass
   * ran: the note's next pass takes them, a closed note's (the file route)
   * too. Else a Task line deleted just before the tab closed was a lost
   * binding, held, not a deletion (the peer-structure property test, seed 78).
   */
  const pending = new PendingHints();
  const leave = (st: ViewState) => {
    if (st.path === null) return;
    pending.add(st.path, st);
    st.deletedIds = new Set();
    st.inserted = new Set();
  };
  /**
   * Hints of written passes whose batch was not taken (SectionResult.unsent):
   * they describe edits in the source last reconciled that were never sent,
   * so a change back to that source does not drop them, unlike the views'
   * hints; the next pass of the note takes them.
   */
  const unsent = new PendingHints();
  const takeHints = (path: string): { deletedIds: Set<string>; inserted: Set<string> } => {
    const viewHints = takeViewHints(path);
    const kept = unsent.take(path);
    for (const id of kept.deletedIds) viewHints.deletedIds.add(id);
    for (const id of kept.inserted) viewHints.inserted.add(id);
    return viewHints;
  };
  /** What the views of `path` noted since the last pass, taken. */
  const takeViewHints = (path: string): { deletedIds: Set<string>; inserted: Set<string> } => {
    const { deletedIds, inserted } = pending.take(path);
    for (const st of views.values()) {
      if (st.path !== path) continue;
      for (const id of st.deletedIds) deletedIds.add(id);
      for (const id of st.inserted) inserted.add(id);
      st.deletedIds = new Set();
      st.inserted = new Set();
    }
    return { deletedIds, inserted };
  };

  const viewOf = (path: string): [EditorView, ViewState] | undefined => {
    let found: [EditorView, ViewState] | undefined;
    for (const [view, st] of views)
      if (st.path === path && (found === undefined || view.hasFocus)) found = [view, st];
    return found;
  };

  /**
   * The hints of a written pass whose section's batch was not taken (refused
   * and kept, stale, importing; SectionResult.unsent): the next pass of the
   * note gets them again, as an abandoned pass's. A pass that sends them
   * takes them for good: none outlive the pass that sends them.
   */
  const keepUnsent = (path: string, pass: NotePass) => {
    for (const s of pass.sections)
      if (s.unsent !== undefined)
        unsent.add(path, {
          deletedIds: new Set(s.unsent.deletedIds),
          inserted: new Set(s.unsent.inserted),
        });
  };

  /** A closed note: the pass is written by read-modify-write, only onto the source it read. */
  /**
   * A pass that changed nothing and committed nothing, whose note changed
   * before it was written (a keystroke, an IME composition opening, a closed
   * note's file rewritten): its bases still describe the source it was
   * planned from, so they are stored, with nothing written into the note and
   * the coordinator left as it is. A section's first base (seeded only while
   * the note equals the model, MS11) was otherwise lost to typing that began
   * right after sharing: every later pass found no base and a note unlike
   * the model, nothing was sent, and the badge said ATTENTION (native
   * section-ime, about one run in seven). The user's newer text is an edit
   * against that base on the next pass.
   */
  const keepBases = async (engine: SectionEngine, pass: NotePass, planned: string) => {
    const quiet =
      pass.changes.length === 0 &&
      pass.sections.every((r) => r.entries.length === 0 && r.local?.kind !== "committed");
    if (quiet && pass.sections.some((r) => r.base !== undefined))
      await engine.written(pass, planned);
    else engine.abandoned(pass);
  };
  const reconcileFile = async (req: PassRequest, engine: SectionEngine): Promise<void> => {
    if (o.files === undefined) return;
    status(req.path, "reconciling");
    const hints = freshHints(takeHints(req.path), req.source);
    const files = o.files;
    const ctx: PassContext = {
      caretLine: null,
      deletedIds: hints.deletedIds,
      inserted: hints.inserted,
      origin: "other",
      cut: sessionCut.pasted(req.path, hints.inserted),
      ...(o.restore === undefined ? {} : { restore: o.restore() }),
      ...(files.read === undefined
        ? {}
        : {
            isCurrent: async (revision: string) => {
              const now = await files.read?.(req.path);
              return now !== null && now !== undefined && contentHash(now) === revision;
            },
          }),
    };
    const pass = await engine.pass(req.path, req.source, ctx);
    if (pass.stale === true) {
      // The file changed since it was read: nothing was committed; pass again on it.
      await keepBases(engine, pass, req.source);
      pending.add(req.path, hints);
      const now = await files.read?.(req.path);
      if (now !== null && now !== undefined) coordinator.fileChanged(req.path, now);
      return;
    }
    let current = req.source;
    const written = await o.files.rewrite(req.path, (text) => {
      current = text;
      return contentHash(text) === pass.sourceRevision ? applyChanges(text, pass.changes) : text;
    });
    if (written === null || contentHash(current) !== pass.sourceRevision) {
      await keepBases(engine, pass, req.source);
      pending.add(req.path, hints);
      if (written !== null) coordinator.fileChanged(req.path, current);
      return;
    }
    await engine.written(pass, written);
    keepUnsent(req.path, pass);
    sessionCut.restored(restoredBy(pass));
    coordinator.written(req.path, written);
    o.onPass?.(req.path, pass);
    again(req.path, pass);
    status(req.path, "idle");
  };

  /**
   * A written pass whose note is not the model's tree (a placement it
   * deferred, SectionResult.diverged) runs once more: the next pass usually
   * places it. The same divergence after that is left for the badge to show
   * ("differs from the shared version"), never a loop.
   */
  const retried = new Map<string, string>();
  /**
   * Notes whose next pass is the safety net's (below): that pass never asks
   * for another.
   */
  const checking = new Set<string>();
  const again = (path: string, pass: NotePass) => {
    const checked = checking.delete(path);
    const ids = pass.sections
      .flatMap((s) => s.diverged ?? [])
      .sort()
      .join(",");
    if (ids === "") retried.delete(path);
    else if (retried.get(path) !== ids) {
      retried.set(path, ids);
      coordinator.remoteChanged(path);
      return;
    }
    // A pass that wrote a collaborator's change and reported the note as
    // not the model's (shown again, diverged, held) may have judged the text
    // it read, not the text it wrote (soak #5). One more pass on the written
    // note: its result replaces this one's. Once per write, never a loop.
    if (
      !checked &&
      pass.sections.some(
        (s) =>
          s.remote?.kind === "patch" &&
          s.remote.changes.length > 0 &&
          ((s.reappeared?.length ?? 0) > 0 || (s.diverged?.length ?? 0) > 0 || s.held.length > 0),
      )
    ) {
      checking.add(path);
      coordinator.remoteChanged(path);
    }
  };
  /** The text a share bound, per note: the next pass seeds the first base from it (seed()). */
  const seeds = new Map<string, string>();
  const reconcile = async (req: PassRequest): Promise<void> => {
    const engine = o.engine();
    if (engine === null) return;
    // A share just bound this note: its first base comes from the text as
    // bound, whatever the user typed or composed since (a pass on that is
    // deferred while composing, and planned on a note unlike the model).
    const bound = seeds.get(req.path);
    if (bound !== undefined) {
      seeds.delete(req.path);
      const seeding = await engine.pass(req.path, bound, {
        caretLine: null,
        deletedIds: new Set(),
        origin: "other",
        seedOnly: true,
      });
      await keepBases(engine, seeding, bound);
    }
    if (req.route === "file") return reconcileFile(req, engine);
    const open = viewOf(req.path);
    if (open === undefined) return;
    const [view, st] = open;
    // Never during an IME composition (IME-1): the half-composed word is not
    // interpreted, and nothing is written into the composing editor.
    if (view.composing || view.compositionStarted || st.scheduler.composing) {
      st.scheduler.defer();
      return;
    }
    status(req.path, "reconciling");
    // The editor's document is the source, as it is now: the coordinator's
    // copy is for scheduling, and may predate the plugin's own last write.
    const source = view.state.doc.toString();
    // What every view of the note noted since the last pass (the pass goes
    // through one of them), and only what still describes the source: a node
    // noted as removed that the note still binds, not pasted, was put back.
    const { deletedIds, inserted } = freshHints(takeHints(req.path), source);
    const caret = view.hasFocus
      ? view.state.doc.lineAt(view.state.selection.main.head).number - 1
      : null;
    const ctx: PassContext = {
      caretLine: caret,
      deletedIds,
      origin: st.origin,
      external: st.external,
      cut: sessionCut.pasted(req.path, inserted),
      inserted,
      ...(o.restore === undefined ? {} : { restore: o.restore() }),
      isCurrent: (revision: string) => contentHash(view.state.doc.toString()) === revision,
    };
    st.origin = "other";
    st.external = false;
    const pass = await engine.pass(req.path, source, ctx);
    if (!editing(view) || st.path !== req.path) {
      // The view went into Reading view (or to another note) during the
      // pass: nothing is written into an editor nobody sees; the note goes
      // by its file now (follow), and passes again there.
      engine.abandoned(pass);
      for (const id of deletedIds) st.deletedIds.add(id);
      for (const id of inserted) st.inserted.add(id);
      return;
    }
    const current = view.state.doc.toString();
    if (view.composing || view.compositionStarted || st.scheduler.composing) {
      // A composition opened during the pass: its result waits (the pass runs again after it).
      await keepBases(engine, pass, source);
      for (const id of deletedIds) st.deletedIds.add(id);
      for (const id of inserted) st.inserted.add(id);
      st.scheduler.defer();
      return;
    }
    if (pass.stale === true || contentHash(current) !== pass.sourceRevision) {
      // The user typed meanwhile: nothing is written; the pass runs again on the new document.
      await keepBases(engine, pass, source);
      for (const id of deletedIds) st.deletedIds.add(id);
      for (const id of inserted) st.inserted.add(id);
      coordinator.editorChanged(req.path, current);
      return;
    }
    if (pass.changes.length > 0)
      view.dispatch({
        changes: pass.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
        annotations: [sectionWrite.of(pass.sourceRevision), Transaction.addToHistory.of(false)],
      });
    const written = view.state.doc.toString();
    await engine.written(pass, written);
    keepUnsent(req.path, pass);
    sessionCut.restored(restoredBy(pass));
    coordinator.written(req.path, written);
    o.onPass?.(req.path, pass);
    again(req.path, pass);
    status(req.path, st.scheduler.dirty ? "edited" : "idle");
  };

  const coordinator = new SourceCoordinator(
    reconcile,
    (path, error) => {
      status(path, "error");
      o.onError?.(path, error);
    },
    // Back to the source last reconciled: nothing the views noted applies
    // (a refused pass's unsent hints still do).
    (path) => takeViewHints(path),
  );

  const pathOf = (view: EditorView) => view.state.field(editorInfoField, false)?.file?.path ?? null;
  /**
   * Whether the view edits its note (Source or Live Preview). Obsidian keeps
   * a note's editor behind its Reading view: a pass written there was never
   * saved, and gone at the next switch to editing, the badge CURRENT
   * meanwhile (LFCP-02-069: a collaborator's edit lost). A note shown only
   * in Reading view is a closed note: its file is the source.
   */
  const editing = (view: EditorView): boolean => {
    const info = view.state.field(editorInfoField, false) as { getMode?: () => string } | undefined;
    return info?.getMode?.() !== "preview";
  };
  const syncs = new Set<SectionSync>();
  /** A note no view edits any more: its file is passed (what arrived meanwhile is projected there). */
  const toFile = (path: string) => {
    if ([...views.values()].some((st) => st.path === path)) return;
    void o.files?.read?.(path).then((text) => {
      if (text === null || text === undefined) return;
      if ([...views.values()].some((st) => st.path === path)) return;
      coordinator.remoteChanged(path, text);
    });
  };

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
        inserted: new Set(),
        origin: "other",
        external: false,
        hidden: null,
      };
      views.set(view, this.st);
      syncs.add(this);
      this.follow();
    }

    /**
     * The view shows a note (or another one now), and edits it: the
     * coordinator knows it as open. Into Reading view it stops following:
     * the note goes by its file. Back to editing, it follows again once its
     * editor holds the file (reopen).
     */
    follow(): void {
      const shown = pathOf(this.view);
      const path = editing(this.view) ? shown : null;
      if (path === this.st.path) {
        if (path === null && this.st.hidden !== null && shown !== this.st.hidden)
          this.st.hidden = null;
        if (path === null && this.st.hidden !== null && editing(this.view)) void this.#reopen();
        return;
      }
      const was = this.st.path;
      leave(this.st);
      this.st.path = null;
      if (was !== null) {
        coordinator.closed(was, this.st.id);
        if (shown === was && !editing(this.view)) this.st.hidden = was;
        toFile(was);
      }
      if (path === null) return;
      if (this.st.hidden === path) void this.#reopen();
      else {
        this.st.hidden = null;
        this.st.path = path;
        coordinator.opened(path, this.st.id, this.view.state.doc.toString());
      }
    }

    /**
     * Back from Reading view: the editor behind it may hold text the file
     * does not (a pass written there before 0.4.0-beta.17, or Obsidian's own
     * reload pending). It takes the file as written, without a hint or an
     * undo step, and only then is the note opened with that text: no pass
     * ever runs on the hidden editor's stale text.
     */
    async #reopen(): Promise<void> {
      const path = this.st.hidden;
      if (path === null) return;
      this.st.hidden = null;
      const text = o.files?.read === undefined ? undefined : await o.files.read(path);
      if (pathOf(this.view) !== path || !editing(this.view) || this.st.path !== null) {
        if (pathOf(this.view) === path && !editing(this.view)) this.st.hidden = path;
        return;
      }
      if (text !== null && text !== undefined && text !== this.view.state.doc.toString())
        this.view.dispatch({
          changes: { from: 0, to: this.view.state.doc.length, insert: text },
          annotations: [sectionWrite.of(contentHash(text)), Transaction.addToHistory.of(false)],
        });
      this.st.path = path;
      coordinator.opened(path, this.st.id, this.view.state.doc.toString());
    }

    update(u: ViewUpdate): void {
      this.follow();
      if (!u.docChanged) return;
      let edited = false;
      for (const tr of u.transactions) {
        if (!tr.docChanged || tr.annotation(sectionWrite) !== undefined) continue;
        edited = true;
        // The plugin's own edit (Review conflicts, repair, …): reconciled, never a hint.
        if (tr.annotation(pluginEdit) !== undefined) continue;
        const userEvent = tr.annotation(Transaction.userEvent);
        if (userEvent === undefined) this.st.external = true;
        const origin = originOf(userEvent);
        if (origin !== "other") this.st.origin = origin;
        const { removed, inserted } = editHints(tr);
        for (const id of removed) this.st.deletedIds.add(id);
        for (const id of inserted) this.st.inserted.add(id);
        if (tr.isUserEvent("delete.cut")) sessionCut.cut(this.st.path, removed);
      }
      if (edited) this.st.scheduler.edit(this.view.composing);
    }

    destroy(): void {
      this.st.scheduler.dispose();
      leave(this.st);
      if (this.st.path !== null) coordinator.closed(this.st.path, this.st.id);
      views.delete(this.view);
      syncs.delete(this);
    }
  }

  const plugin = ViewPlugin.fromClass(SectionSync);
  // MS27, MS28: Enter at the end of a Task line whose ref is on its child
  // line goes past the Task's subtree, in the same transaction (one undo step);
  // Enter at the start of a paragraph's text goes before its marker.
  const enter = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(sectionWrite) !== undefined || !tr.isUserEvent("input"))
      return tr;
    let only: { from: number; to: number; insert: string } | null = null;
    let count = 0;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      count++;
      only = { from: fromA, to: toA, insert: inserted.toString() };
    });
    const raw = only as { from: number; to: number; insert: string } | null;
    if (count !== 1 || raw === null) return tr;
    // Obsidian's list Enter replaces the line's last character ("t" with
    // "t\n- [ ] "): reduce the change to what it adds.
    const removed = tr.startState.doc.sliceString(raw.from, raw.to);
    let head = 0;
    while (head < removed.length && removed[head] === raw.insert[head]) head++;
    const change =
      head === removed.length
        ? { from: raw.from + head, to: raw.from + head, insert: raw.insert.slice(head) }
        : raw;
    if (change.to !== change.from || !/^\r?\n/.test(change.insert)) return tr;
    const before = tr.startState.doc.toString();
    if (!before.includes("lfcp-section:")) return tr;
    const kept = keepRefWithTask(before, change);
    if (kept === null) {
      // Enter at the start of a paragraph's text: the new line goes before its
      // marker, the text keeps its node; the caret stays at the text's start.
      const moved = keepMarkerWithParagraph(before, change);
      if (moved === null) return tr;
      return {
        changes: moved,
        selection: { anchor: tr.newSelection.main.head },
        userEvent: tr.annotation(Transaction.userEvent) ?? "input",
        scrollIntoView: true,
      };
    }
    // The caret where it would be on the new line, moved with it.
    const offset = tr.newSelection.main.head - (change.from + change.insert.length);
    return {
      changes: kept,
      selection: { anchor: kept.from + kept.insert.length + Math.max(0, offset) },
      userEvent: tr.annotation(Transaction.userEvent) ?? "input",
      scrollIntoView: true,
    };
  });
  // §10: a paste or a drop keeps only the bindings of its own nodes where it
  // lands; the others are removed, so the text is a copy with new
  // identities in another section, or plain text outside sections.
  // A paste that runs into the text around it goes on lines of its own
  // (line-moves.ts pasteOnOwnLines: a ref glued to the next Task's line).
  const keep = o.keepPasted;
  const pasted = EditorState.transactionFilter.of((tr) => {
    if (
      !tr.docChanged ||
      tr.annotation(sectionWrite) !== undefined ||
      !(tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop"))
    )
      return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: fromA, to: toA, insert: inserted.toString() });
    });
    const only = changes.length === 1 ? changes[0] : undefined;
    if (only === undefined) return tr;
    const before = tr.startState.doc.toString();
    const kept = keep === undefined ? null : pasteBindings(before, only, keep);
    const rewritten = pasteOnOwnLines(before, kept ?? only) ?? kept;
    if (rewritten === null) return tr;
    return {
      changes: rewritten,
      selection: { anchor: rewritten.from + rewritten.insert.length },
      userEvent: tr.annotation(Transaction.userEvent) ?? "input.paste",
      scrollIntoView: true,
    };
  });
  // A cut or a delete of a bound Task's whole line takes its binding lines
  // along (line-moves.ts withBindingLines): the cut's selection is widened
  // before the editor copies it, so the clipboard holds the whole Task and a
  // paste restores it; a delete removes the Task, not only its text.
  const wholeTaskCut = EditorView.domEventHandlers({
    cut: (_event, view) => {
      const sel = view.state.selection;
      if (sel.ranges.length !== 1 || sel.main.empty) return false;
      const r = sel.main;
      const wider = withBindingLines(view.state.doc.toString(), r.from, r.to);
      if (wider === null) return false;
      const forward = r.anchor <= r.head;
      view.dispatch({
        selection: forward
          ? EditorSelection.range(wider.from, wider.to)
          : EditorSelection.range(wider.to, wider.from),
      });
      return false;
    },
  });
  const wholeTaskDelete = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(sectionWrite) !== undefined || !tr.isUserEvent("delete"))
      return tr;
    const sel = tr.startState.selection;
    if (sel.ranges.length !== 1 || sel.main.empty) return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: fromA, to: toA, insert: inserted.toString() });
    });
    const only = changes.length === 1 ? changes[0] : undefined;
    if (
      only === undefined ||
      only.insert !== "" ||
      only.from !== sel.main.from ||
      only.to !== sel.main.to
    )
      return tr;
    const wider = withBindingLines(tr.startState.doc.toString(), only.from, only.to);
    if (wider === null) return tr;
    return {
      changes: { from: wider.from, to: wider.to, insert: "" },
      selection: { anchor: wider.from },
      userEvent: tr.annotation(Transaction.userEvent) ?? "delete.selection",
      scrollIntoView: true,
    };
  });
  // A cut that ends inside the next line's indentation leaves it to that
  // line (line-moves.ts cutKeepsIndent).
  const cutLines = EditorState.transactionFilter.of((tr) => {
    if (
      !tr.docChanged ||
      tr.annotation(sectionWrite) !== undefined ||
      !tr.isUserEvent("delete.cut")
    )
      return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: fromA, to: toA, insert: inserted.toString() });
    });
    const only = changes.length === 1 ? changes[0] : undefined;
    if (only === undefined) return tr;
    const kept = cutKeepsIndent(tr.startState.doc.toString(), only);
    if (kept === null) return tr;
    return {
      changes: kept,
      selection: { anchor: kept.from },
      userEvent: "delete.cut",
      scrollIntoView: true,
    };
  });
  // Move line up/down in a section moves whole nodes, each Task with its ref
  // line and subtree, past the sibling before or after them; Tab and
  // Shift+Tab take a node's other lines along (line-moves.ts).
  const lineMoves = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(sectionWrite) !== undefined) return tr;
    const start = tr.startState;
    if (tr.isUserEvent("move.line")) {
      if (start.selection.ranges.length !== 1) return tr;
      const range = start.selection.main;
      const a = start.doc.lineAt(range.from);
      let b = start.doc.lineAt(range.to);
      if (!range.empty && range.to === b.from && b.number > a.number)
        b = start.doc.line(b.number - 1);
      const dir = tr.newSelection.main.from < range.from ? "up" : "down";
      const move = moveNodeLines(start.doc.toString(), a.number - 1, b.number - 1, dir);
      if (move === null) return tr;
      const size = start.doc.length;
      const at = (pos: number) => Math.max(0, Math.min(size, pos + move.shift));
      return {
        changes: move.changes,
        selection: { anchor: at(range.anchor), head: at(range.head) },
        annotations: movedNodes.of(move.moved),
        userEvent: "move.line",
        scrollIntoView: true,
      };
    }
    if (tr.isUserEvent("input.indent") || tr.isUserEvent("delete.dedent")) {
      const changes: { from: number; to: number; insert: string }[] = [];
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes.push({ from: fromA, to: toA, insert: inserted.toString() });
      });
      const all = indentWithNode(start.doc.toString(), changes);
      if (all === null) return tr;
      const spec = start.changes(all);
      return {
        changes: spec,
        selection: tr.startState.selection.map(spec, 1),
        userEvent: tr.annotation(Transaction.userEvent) ?? "input.indent",
        scrollIntoView: true,
      };
    }
    return tr;
  });
  // A selection that ends inside a binding line (Shift+Down by visual rows
  // over a wrapped ref line, a drag of the mouse) ends at its end instead,
  // or its start going back: a cut or a copy takes whole binding lines, never
  // half a ref (the owner's keys for 0.4.0-beta.10 step 6, a narrow window).
  const wholeBindings = EditorState.transactionFilter.of((tr) => {
    if (tr.docChanged || tr.selection === undefined || !tr.isUserEvent("select")) return tr;
    const doc = tr.newDoc;
    let changed = false;
    const ranges = tr.selection.ranges.map((r) => {
      if (r.empty) return r;
      const line = doc.lineAt(r.head);
      if (r.head === line.from || r.head === line.to || !BINDING_LINE.test(line.text)) return r;
      changed = true;
      return EditorSelection.range(r.anchor, r.head > r.anchor ? line.to : line.from);
    });
    if (!changed) return tr;
    return [
      tr,
      { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true },
    ];
  });
  // No edit of the user leaves a binding line that stood alone sharing its
  // line with other text: Backspace at the start of a Task line under one,
  // Delete at the end of the line above one, in whatever shape the editor
  // dispatches it (one line break removed, or the list marker replaced with
  // it, or several at once) would glue text onto a marker the user cannot
  // see in Live Preview. The check is on the result, not the shape. The
  // document stays; Backspace takes the caret to the end of the nearest
  // visible line above, hidden binding lines being atomic. A blank line next
  // to a marker still goes: the joined line is the binding line alone. Only
  // the user's typing, deleting and moving are checked: undo and redo always
  // go through (the user can always undo out of anything), and so do the
  // plugin's own writes and other plugins' (no user event: a rewrite that
  // breaks a binding is healed or shown as ATTENTION, never silently refused).
  const bindingJoins = EditorState.transactionFilter.of((tr) => {
    if (
      !tr.docChanged ||
      tr.annotation(sectionWrite) !== undefined ||
      tr.annotation(pluginEdit) !== undefined ||
      !(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))
    )
      return tr;
    if (!gluesBinding(tr)) return tr;
    if (!tr.isUserEvent("delete.backward")) return [];
    const doc = tr.startState.doc;
    const hidden = (text: string) =>
      tr.startState.field(editorLivePreviewField, false) === true && BINDING_LINE.test(text);
    for (let n = doc.lineAt(tr.startState.selection.main.head).number - 1; n >= 1; n--) {
      const line = doc.line(n);
      if (!hidden(line.text)) return { selection: { anchor: line.to }, scrollIntoView: true };
    }
    return [];
  });
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
    extension: [
      plugin,
      events,
      enter,
      pasted,
      wholeTaskCut,
      wholeTaskDelete,
      cutLines,
      lineMoves,
      wholeBindings,
      bindingJoins,
    ],
    remoteChanged: (path, content) => coordinator.remoteChanged(path, content),
    refresh: () => {
      for (const s of syncs) s.follow();
    },
    seed: (path, text) => {
      seeds.set(path, text);
    },
    fileChanged: (path, content) => coordinator.fileChanged(path, content),
    renamed: (oldPath, newPath) => {
      pending.rename(oldPath, newPath);
      unsent.rename(oldPath, newPath);
      sessionCut.renamed(oldPath, newPath);
      const bound = seeds.get(oldPath);
      seeds.delete(oldPath);
      if (bound !== undefined) seeds.set(newPath, bound);
      coordinator.renamed(oldPath, newPath);
    },
    deleted: (path) => {
      pending.take(path);
      unsent.take(path);
      sessionCut.deleted(path);
      seeds.delete(path);
      coordinator.deleted(path);
    },
    views,
  };
}
