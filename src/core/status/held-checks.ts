// Which notes with shared sections were checked for held edits since the
// start (LFCP-03-003). Held edits are found by passes and kept in memory,
// so after a start a note's sections are not known to hold nothing until a
// pass of that note compares them. A pass that fails leaves the note's held
// edits unknown (not "being checked": nothing says it will be) until a later
// pass succeeds. Pure bookkeeping, keyed by note path and section Resource.

/** A section's check: every note passed, some note waiting for its pass, or a pass failed. */
export type HeldCheck = "checked" | "pending" | "failed";

export class HeldChecks {
  /** Notes not checked yet, with the Resources (hex) of their sections still to compare. */
  readonly #pending = new Map<string, Set<string>>();
  /** Pending notes whose last pass failed. */
  readonly #failed = new Set<string>();
  /** The start is still finding the notes with sections: none is known checked. */
  #indexing = false;

  /** The start begins finding notes with sections. */
  begin(): void {
    this.#indexing = true;
  }

  /** The start found every note with sections (or stopped). */
  end(): void {
    this.#indexing = false;
  }

  /** Note `path` holds sections of these Resources and is to be checked. */
  found(path: string, resources: Iterable<string>): void {
    const set = new Set(resources);
    if (set.size === 0) return;
    this.#pending.set(path, set);
  }

  /**
   * A pass of `path` compared its sections, but those of the `waiting`
   * Resources (their model still loading). True when something changed.
   */
  passed(path: string, waiting: ReadonlySet<string>): boolean {
    const pending = this.#pending.get(path);
    if (pending === undefined) return false;
    let changed = this.#failed.delete(path);
    for (const r of pending)
      if (!waiting.has(r)) {
        pending.delete(r);
        changed = true;
      }
    if (pending.size === 0) this.#pending.delete(path);
    return changed;
  }

  /** A pass of `path` failed: its held edits are unknown. True when that is new. */
  failed(path: string): boolean {
    if (!this.#pending.has(path) || this.#failed.has(path)) return false;
    this.#failed.add(path);
    return true;
  }

  renamed(oldPath: string, newPath: string): void {
    const pending = this.#pending.get(oldPath);
    if (pending === undefined) return;
    this.#pending.delete(oldPath);
    this.#pending.set(newPath, pending);
    if (this.#failed.delete(oldPath)) this.#failed.add(newPath);
  }

  /**
   * A note gone: nothing in it to check. True when it was not checked yet,
   * so its sections' checks may have changed (the last unchecked note gone).
   */
  deleted(path: string): boolean {
    const changed = this.#pending.delete(path);
    this.#failed.delete(path);
    return changed;
  }

  /** The check of the sections of Resource `resource` (hex). */
  state(resource: string): HeldCheck {
    if (this.#indexing) return "pending";
    let state: HeldCheck = "checked";
    for (const [path, rs] of this.#pending)
      if (rs.has(resource)) {
        if (this.#failed.has(path)) return "failed";
        state = "pending";
      }
    return state;
  }
}
