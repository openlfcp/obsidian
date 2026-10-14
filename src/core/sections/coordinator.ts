// One coherent source per note across editor and file events (LFCP-02-041).
// Pure scheduling; the Obsidian adapter feeds it events and does the I/O.
//
// - An open editor is newer than the file's bytes: while a note is open,
//   only editor states are sources. A file event for an open note is not
//   reconciled on its own (an external write reaches the editor, which
//   reloads it as a transaction, and that is reconciled); it may still be
//   the plugin's own write, which writes.ts recognizes by content.
// - Several views of one note share one source: a pass reads the current
//   document once and writes through one view (Obsidian syncs the others).
// - A closed note's source is its file, written by read-modify-write.
// - Passes are coalesced per note: one runs at a time; events during a
//   pass mark the note dirty, and one more pass follows with the latest
//   source. Nothing is held across an await other than this flag: a slow
//   pass delays only its own note.
// - A source already reconciled (the same SHA-256) is not reconciled again:
//   repeated notifications plan nothing.

import { contentHash } from "../projection/guard";

/** Where a pass reads and writes a note. */
export type Route = "editor" | "file";

/** Why a pass runs: a local change, or a remote one to project. */
export type Trigger = "local" | "remote";

export interface PassRequest {
  readonly path: string;
  readonly route: Route;
  /** The note's current source for this pass. */
  readonly source: string;
  readonly triggers: ReadonlySet<Trigger>;
}

/** Runs one reconciliation pass of a note; resolves when it is done (written or deferred). */
export type Reconcile = (request: PassRequest) => Promise<void>;

interface NoteState {
  /** Open editor views of the note. */
  readonly views: Set<string>;
  /** The latest editor document, while open. */
  editorSource?: string;
  /** The latest file content seen. */
  fileSource?: string;
  /** The hash of the source last reconciled (a pass completed on it). */
  reconciled?: string;
  /** How many times a pass wrote the note (written()). */
  writes?: number;
  /** How many times the editor's document changed (editorChanged). */
  editorChanges?: number;
  /** How many times the file changed (fileChanged). */
  fileChanges?: number;
  /** The change count of the running pass's route when it started. */
  passFrom?: number;
  running: boolean;
  dirty: Set<Trigger>;
}

export class SourceCoordinator {
  readonly #notes = new Map<string, NoteState>();
  readonly #idle = new Map<string, (() => void)[]>();

  constructor(
    private readonly reconcile: Reconcile,
    /** A pass that threw: reported, and the note stays schedulable (its source is not marked reconciled). */
    private readonly onError: (path: string, error: unknown) => void = () => {},
    /**
     * A change brought the note back to the source last reconciled, so no
     * pass runs: what the editor noted for the next pass describes nothing.
     */
    private readonly onSettled: (path: string) => void = () => {},
  ) {}

  #note(path: string): NoteState {
    let n = this.#notes.get(path);
    if (n === undefined) {
      n = { views: new Set(), running: false, dirty: new Set() };
      this.#notes.set(path, n);
    }
    return n;
  }

  route(path: string): Route {
    return (this.#notes.get(path)?.views.size ?? 0) > 0 ? "editor" : "file";
  }

  opened(path: string, viewId: string, doc: string): void {
    const n = this.#note(path);
    n.views.add(viewId);
    n.editorSource = doc;
  }

  /** A view closed. The last one hands the note back to its file, which the next file event reconciles. */
  closed(path: string, viewId: string): void {
    const n = this.#notes.get(path);
    if (n === undefined) return;
    n.views.delete(viewId);
    if (n.views.size === 0) delete n.editorSource;
  }

  /** An editor transaction changed the note (any view: they share the document). */
  editorChanged(path: string, doc: string): void {
    const n = this.#note(path);
    n.editorSource = doc;
    n.editorChanges = (n.editorChanges ?? 0) + 1;
    this.#request(path, "local");
  }

  /**
   * A pass wrote `doc` into the note (the editor's document after its
   * write, or the file as rewritten): it is the note's source now, and
   * reconciled. No pass is requested. Without this, the next pass would
   * read the text from before the write and take the difference for the
   * user's edit (the idle editor that reverted a collaborator's edit,
   * 0.4.0-beta.13).
   */
  written(path: string, doc: string): void {
    const n = this.#notes.get(path);
    if (n === undefined) return;
    // A change that came while the pass was writing (the user pasted during
    // its last await) is newer than `doc`: it stays the source, and the next
    // pass takes it with what the editor noted. Taking `doc` as the source
    // made the loop find it reconciled and drop those hints: a paste of a
    // Task cut a moment before was never restored, and the cut's deletion
    // stood for collaborators (soak finding #9 on 0.4.0-beta.17).
    const newer = n.running && this.#changes(n) !== (n.passFrom ?? 0);
    if (!newer) {
      if (n.views.size > 0) n.editorSource = doc;
      else n.fileSource = doc;
    }
    n.reconciled = contentHash(doc);
    n.writes = (n.writes ?? 0) + 1;
  }

  /**
   * The file changed on disk. Reconciled only while the note is closed: an
   * open editor's document is newer, and an external write reaches it.
   */
  fileChanged(path: string, content: string): void {
    const n = this.#note(path);
    n.fileSource = content;
    n.fileChanges = (n.fileChanges ?? 0) + 1;
    if (n.views.size === 0) this.#request(path, "local");
  }

  /**
   * The shared state of a note's projection changed: project it from the
   * current source. `content` is a closed note's file as just read.
   */
  remoteChanged(path: string, content?: string): void {
    if (content !== undefined) this.#note(path).fileSource = content;
    this.#request(path, "remote");
  }

  renamed(oldPath: string, newPath: string): void {
    const n = this.#notes.get(oldPath);
    if (n === undefined) return;
    this.#notes.delete(oldPath);
    this.#notes.set(newPath, n);
    const waiting = this.#idle.get(oldPath);
    if (waiting !== undefined) {
      this.#idle.delete(oldPath);
      this.#idle.set(newPath, [...(this.#idle.get(newPath) ?? []), ...waiting]);
    }
  }

  deleted(path: string): void {
    this.#notes.delete(path);
  }

  /** Resolves when the note has no pass running or pending (for tests and shutdown). */
  whenIdle(path: string): Promise<void> {
    const n = this.#notes.get(path);
    if (n === undefined || (!n.running && n.dirty.size === 0)) return Promise.resolve();
    return new Promise((resolve) =>
      this.#idle.set(path, [...(this.#idle.get(path) ?? []), resolve]),
    );
  }

  #source(n: NoteState): { route: Route; source: string } | null {
    if (n.views.size > 0)
      return n.editorSource === undefined ? null : { route: "editor", source: n.editorSource };
    return n.fileSource === undefined ? null : { route: "file", source: n.fileSource };
  }

  #request(path: string, trigger: Trigger): void {
    const n = this.#note(path);
    n.dirty.add(trigger);
    if (!n.running) void this.#run(path, n);
  }

  async #run(path: string, n: NoteState): Promise<void> {
    n.running = true;
    try {
      while (n.dirty.size > 0) {
        const triggers = new Set(n.dirty);
        n.dirty.clear();
        const current = this.#source(n);
        if (current === null) continue;
        const hash = contentHash(current.source);
        // A repeated notification of a reconciled source: nothing to do,
        // unless the shared state changed and must be projected.
        if (hash === n.reconciled && !triggers.has("remote")) {
          this.onSettled(this.#pathOf(n) ?? path);
          continue;
        }
        // The note may have been renamed while queued: use its current path.
        const at = this.#pathOf(n) ?? path;
        try {
          const writes = n.writes;
          n.passFrom = this.#changes(n);
          await this.reconcile({ path: at, ...current, triggers });
          // A pass that wrote said what it reconciled (written()).
          if (n.writes === writes) n.reconciled = hash;
        } catch (error) {
          this.onError(at, error);
        }
      }
    } finally {
      n.running = false;
      const at = this.#pathOf(n) ?? path;
      const waiting = this.#idle.get(at) ?? [];
      this.#idle.delete(at);
      for (const resolve of waiting) resolve();
    }
  }

  /** The change count of the note's current route: its editor's while open, else its file's. */
  #changes(n: NoteState): number {
    return n.views.size > 0 ? (n.editorChanges ?? 0) : (n.fileChanges ?? 0);
  }

  #pathOf(n: NoteState): string | undefined {
    for (const [p, s] of this.#notes) if (s === n) return p;
    return undefined;
  }
}
