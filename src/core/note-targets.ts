// The note a share, import or insert flow acts on, followed across renames
// (LFCP-03-002, OBSIDIAN-UX-ARCHITECTURE-03 §3/§4). A flow holds its note
// from its start to its end: the note keeps one identity meanwhile, so the
// flow's reservation (InFlight key `note:<id>`) stays the same when the note
// is renamed. A share or import writes at the note's path at the moment of
// each write (SectionCreation.run asks it before checking and before
// binding, and journals a new path); an insert reads it once, when its
// preview is approved. A deleted note's target has no path: the flow's
// effect is refused, never written elsewhere. Identities live only while held; they
// are not persisted (a restart resumes from the creation journal, which
// records the path). Pure: the host feeds the vault's rename and delete
// events in as they happen.

/** A held note: its identity, and its path now (null once deleted). */
export interface NoteTarget {
  readonly id: number;
  readonly path: string | null;
}

interface Held {
  readonly id: number;
  path: string | null;
  holders: number;
}

export class NoteTargets {
  #next = 1;
  readonly #byPath = new Map<string, Held>();

  /** The note at `path`, held until `release`: the same identity for every holder meanwhile. */
  hold(path: string): { readonly target: NoteTarget; release(): void } {
    let held = this.#byPath.get(path);
    if (held === undefined) {
      held = { id: this.#next++, path, holders: 0 };
      this.#byPath.set(path, held);
    }
    held.holders++;
    const h = held;
    let released = false;
    return {
      target: h,
      release: () => {
        if (released) return;
        released = true;
        h.holders--;
        if (h.holders === 0 && h.path !== null && this.#byPath.get(h.path) === h)
          this.#byPath.delete(h.path);
      },
    };
  }

  /** How many notes are held now (diagnostics and tests: a hold not given back shows here). */
  get size(): number {
    return this.#byPath.size;
  }

  /** The vault renamed a note: its held identity moves with it. */
  renamed(oldPath: string, path: string): void {
    const held = this.#byPath.get(oldPath);
    if (held === undefined) return;
    this.#byPath.delete(oldPath);
    held.path = path;
    this.#byPath.set(path, held);
  }

  /** The vault deleted a note: its held identity has no path any more. */
  deleted(path: string): void {
    const held = this.#byPath.get(path);
    if (held === undefined) return;
    this.#byPath.delete(path);
    held.path = null;
  }
}
