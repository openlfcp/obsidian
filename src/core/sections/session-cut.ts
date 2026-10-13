// The editing session's last cut (rules.ts pasteDecision, §10), as the
// editor keeps it between passes. Pure.
//
// A cut only serves to recognise its own paste: a cut node counts as
// pasted, and so as moved, only when a user's paste in the note it was cut
// from re-inserted its binding (the pass's `inserted` hint). It is never a
// move hint on its own, and it does not outlive its paste. Up to
// 0.4.0-beta.14 the last cut went to every later pass of every note: a
// Move line next to a Task cut and pasted earlier named that Task as
// moved, and another copy of the section, still binding the cut Task, was
// taken for its paste and undid the cut.

export class SessionCut {
  #path: string | null = null;
  #ids = new Set<string>();

  /** A cut in `path` removed these bound nodes; it supersedes the last one (none: no cut is kept). */
  cut(path: string | null, ids: Iterable<string>): void {
    this.#ids = new Set(ids);
    this.#path = this.#ids.size === 0 ? null : path;
    if (this.#path === null) this.#ids = new Set();
  }

  /** The cut nodes a pass of `path` takes as pasted: those a user's paste there re-inserted. */
  pasted(path: string, inserted: ReadonlySet<string>): Set<string> {
    if (this.#path !== path) return new Set();
    return new Set([...this.#ids].filter((id) => inserted.has(id)));
  }

  /** A pass restored these nodes (node.restore): their paste is done. */
  restored(ids: Iterable<string>): void {
    for (const id of ids) this.#ids.delete(id);
    if (this.#ids.size === 0) this.#path = null;
  }

  renamed(oldPath: string, newPath: string): void {
    if (this.#path === oldPath) this.#path = newPath;
  }

  /** The note was deleted: its cut can no longer be pasted there. */
  deleted(path: string): void {
    if (this.#path !== path) return;
    this.#path = null;
    this.#ids = new Set();
  }

  /** The note and nodes of the cut kept, for diagnostics and tests. */
  get current(): { readonly path: string; readonly ids: readonly string[] } | null {
    return this.#path === null ? null : { path: this.#path, ids: [...this.#ids] };
  }
}
