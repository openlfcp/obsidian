// Native undo/redo as compensating intents (LFCP-02-044). Pure; not wired in.
//
// Undo in the editor changes the note; it never rewinds shared history
// (OBSIDIAN-SECTIONS-ARCHITECTURE-02 §7). Text and field edits need nothing
// special: the three-way planner (base.ts) sees the note back at an older
// value and sends that value as a new edit. What needs a decision is a node
// that disappears or reappears:
//
// - undo of the user's own creation: the node and its marker vanish
//   together (one undo step, ADR 0001 S2): a compensating node.delete;
// - undo of the user's own deletion: the node comes back with its ID while
//   the shared state has it deleted: node.restore, a fresh lifecycle
//   operation (SHARED-SECTIONS-PROFILE-01 §9);
// - redo: the same, the other way round;
// - anything else (a marker lost by hand, an external edit, a paste of a
//   deleted node): not inferred. Missing nodes stay NODE_BINDING_LOST and
//   reappearing ones need review (MARKDOWN-SECTIONS-01 §7).

/** Who changed the note, from the editor transaction (ADR 0001 S1: undo/redo carry these userEvents). */
export type ChangeOrigin = "undo" | "redo" | "other";

export function originOf(userEvent: string | null | undefined): ChangeOrigin {
  if (userEvent === "undo") return "undo";
  if (userEvent === "redo") return "redo";
  return "other";
}

/** Nodes this projection created or deleted in this editing session (local, in memory). */
export class SessionLedger {
  readonly #created = new Set<string>();
  readonly #deleted = new Set<string>();

  created(id: string): void {
    this.#created.add(id);
    this.#deleted.delete(id);
  }

  deleted(id: string): void {
    this.#deleted.add(id);
  }

  restored(id: string): void {
    this.#deleted.delete(id);
  }

  wasCreated(id: string): boolean {
    return this.#created.has(id);
  }

  wasDeleted(id: string): boolean {
    return this.#deleted.has(id);
  }
}

export interface Compensation {
  /** node.delete: undo of a creation, or redo of a deletion. */
  readonly deletes: readonly string[];
  /** node.restore (a fresh lifecycle operation): undo of a deletion, or redo of a creation. */
  readonly restores: readonly string[];
  /** Missing, not explained by undo or redo: NODE_BINDING_LOST, text kept. */
  readonly lost: readonly string[];
  /** Back in the note while deleted in the shared state, not explained: needs review, nothing sent. */
  readonly unexplained: readonly string[];
}

/**
 * The lifecycle intents for nodes that disappeared from the note
 * (`missing`, from planSection) or reappeared in it while deleted in the
 * shared state (`reappeared`), given the transaction's origin.
 */
export function compensate(
  origin: ChangeOrigin,
  missing: readonly string[],
  reappeared: readonly string[],
  ledger: SessionLedger,
): Compensation {
  const deletes: string[] = [];
  const restores: string[] = [];
  const lost: string[] = [];
  const unexplained: string[] = [];
  for (const id of missing) {
    // Undo removes what this session created; redo removes again what it deleted.
    if (
      (origin === "undo" && ledger.wasCreated(id)) ||
      (origin === "redo" && ledger.wasDeleted(id))
    )
      deletes.push(id);
    else lost.push(id);
  }
  for (const id of reappeared) {
    // Undo brings back what this session deleted; redo brings back what it created.
    if (
      (origin === "undo" && ledger.wasDeleted(id)) ||
      (origin === "redo" && ledger.wasCreated(id))
    )
      restores.push(id);
    else unexplained.push(id);
  }
  return { deletes, restores, lost, unexplained };
}
