// Vault-level file changes (LFCP-059, OBSIDIAN-ARCHITECTURE-01 §45): files
// change through external editors, Git, other plugins and sync tools, not
// only through CodeMirror. The adapter forwards the vault's create, modify,
// delete and rename events here. Subscribers (projection scanning, from
// LFCP-060 onward) get Markdown changes, coalesced per path. Obsidian-free.

export type VaultChange =
  | { readonly kind: "create" | "modify" | "delete"; readonly path: string }
  | { readonly kind: "rename"; readonly path: string; readonly oldPath: string };

export interface ChangeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const isMarkdown = (path: string): boolean => path.toLowerCase().endsWith(".md");

/**
 * Collects vault changes and delivers Markdown ones in batches after
 * `delayMs` without further changes. Within a batch the last change of a
 * path wins; a rename keeps its old path.
 */
export class VaultChangeHub {
  readonly #timers: ChangeTimers;
  readonly #delayMs: number;
  readonly #listeners = new Set<(changes: readonly VaultChange[]) => void>();
  #pending = new Map<string, VaultChange>();
  #timer: unknown = null;
  #closed = false;

  constructor(timers: ChangeTimers, delayMs = 300) {
    this.#timers = timers;
    this.#delayMs = delayMs;
  }

  subscribe(listener: (changes: readonly VaultChange[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Records one vault event (from the adapter). */
  record(change: VaultChange): void {
    if (this.#closed) return;
    const relevant =
      isMarkdown(change.path) || (change.kind === "rename" && isMarkdown(change.oldPath));
    if (!relevant) return;
    this.#pending.delete(change.path);
    this.#pending.set(change.path, change);
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = this.#timers.setTimeout(() => this.flush(), this.#delayMs);
  }

  /** Delivers what is pending now. */
  flush(): void {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#pending.size === 0) return;
    const batch = Object.freeze([...this.#pending.values()]);
    this.#pending = new Map();
    for (const l of this.#listeners) l(batch);
  }

  /** Stops: drops pending changes and timers (the next start rescans). */
  close(): void {
    this.#closed = true;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending.clear();
    this.#listeners.clear();
  }
}
