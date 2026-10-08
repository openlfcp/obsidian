// When typing becomes a reconciliation, and what typing is not ready yet
// (LFCP-02-043, ADR 0001 §2). Pure; the CodeMirror extension feeds it.
//
// Reconciliation runs outside the editor's update: after a short idle, at
// the end of an IME composition, or when the editor loses focus, and at
// the latest after a cap while the user keeps typing. Never during a
// composition: a half-composed word is a real local edit (the buffer keeps
// it), but not one to interpret. The debounce is never the only copy of an
// edit: the buffer is, until the journal and the receipt (commit.ts). The
// status turns "edited" at the first keystroke (SI02), not at the pass.

import type { UnboundNode } from "./base";

export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const IDLE_MS = 400;
/** A pass at the latest this long after the first unreconciled edit, while typing goes on. */
export const MAX_WAIT_MS = 2000;

export class ReconcileScheduler {
  #dirty = false;
  #composing = false;
  #idle: unknown = null;
  #cap: unknown = null;

  constructor(
    private readonly run: () => void,
    private readonly timer: Timer,
    /** The note became edited and not reconciled: show it now (SI02). */
    private readonly onDirty: () => void = () => {},
    private readonly idleMs = IDLE_MS,
    private readonly maxWaitMs = MAX_WAIT_MS,
  ) {}

  get dirty(): boolean {
    return this.#dirty;
  }

  /** A user transaction changed the note; `composing` is the editor's IME state. */
  edit(composing: boolean): void {
    this.#composing = composing;
    if (!this.#dirty) {
      this.#dirty = true;
      this.onDirty();
      this.#cap = this.timer.set(() => this.#capReached(), this.maxWaitMs);
    }
    this.#clearIdle();
    if (!composing) this.#idle = this.timer.set(() => this.#fire(), this.idleMs);
  }

  compositionStart(): void {
    this.#composing = true;
    this.#clearIdle();
  }

  compositionEnd(): void {
    this.#composing = false;
    if (this.#dirty) this.#fire();
  }

  /** Focus left the editor: whatever was typed is reconciled now. */
  blur(): void {
    this.#composing = false;
    if (this.#dirty) this.#fire();
  }

  /** Stop (the view closed): pending timers go; the buffer still holds the edit. */
  dispose(): void {
    this.#clearIdle();
    if (this.#cap !== null) this.timer.clear(this.#cap);
    this.#cap = null;
  }

  #capReached(): void {
    this.#cap = null;
    // Mid-composition the cap waits for its end.
    if (this.#dirty && !this.#composing) this.#fire();
  }

  #clearIdle(): void {
    if (this.#idle !== null) this.timer.clear(this.#idle);
    this.#idle = null;
  }

  #fire(): void {
    this.dispose();
    this.#dirty = false;
    this.run();
  }
}

const EMPTY_TASK = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[.\][ \t]*$/;

/**
 * New content not ready to be shared yet, so it gets no identity in this
 * pass (MS17-transient): on the caret's line, an item without text, or a
 * Task without a title (`- [ ] `, the line Enter leaves behind). It stays
 * in the note and is reconciled once the caret leaves or it has content.
 */
export function transientCandidates(
  unbound: readonly UnboundNode[],
  lineText: (line: number) => string,
  caretLine: number | null,
): Set<number> {
  const out = new Set<number>();
  for (const c of unbound) {
    if (c.line !== caretLine) continue;
    if (c.kind === "item" && (c.text ?? "").trim() === "") out.add(c.line);
    if (c.kind === "task" && EMPTY_TASK.test(lineText(c.line))) out.add(c.line);
  }
  return out;
}
