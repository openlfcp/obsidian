// Keyboard and screen reader support for shared sections (LFCP-02-064,
// OBSIDIAN-SYNC-INDICATORS-01 §8, OBSIDIAN-SHARED-SECTIONS-UX-01 §10). Pure.
//
// - A new blocking condition is announced once: not on every retry, every
//   received unit or every keystroke, and again only after it cleared or
//   became a different condition.
// - Problems are reached by a command, one at a time, never as a Tab stop
//   per row; a problem hidden in a fold is still in the list.

import type { StatusView } from "./reducer";

/** What a section is blocked by, as one comparable string; null when nothing blocks it. */
export function blockingSignature(view: StatusView): string | null {
  if (view.state !== "ATTENTION" && view.state !== "LOCAL_SAVE_FAILED") return null;
  // Kinds only: a retry carries new batch IDs, the same condition does not change.
  const kinds = view.conditions
    .filter(
      (c) =>
        c.kind === "save-failed" ||
        c.kind === "access" ||
        c.kind === "invalid-profile" ||
        c.kind === "rejected" ||
        c.kind === "source" ||
        c.kind === "structural-conflict" ||
        c.kind === "scalar-conflict",
    )
    .map((c) => (c.kind === "rejected" ? `rejected:${c.code}` : c.kind));
  return [view.state, ...new Set(kinds)].join("|");
}

/** Remembers what was announced per section; `next` gives what to say now. */
export class Announcer {
  readonly #said = new Map<string, string>();

  next(
    statuses: ReadonlyMap<string, StatusView>,
    title: (key: string) => string,
  ): readonly string[] {
    const out: string[] = [];
    for (const [key, view] of statuses) {
      const sig = blockingSignature(view);
      if (sig === null) {
        this.#said.delete(key);
        continue;
      }
      if (this.#said.get(key) === sig) continue;
      this.#said.set(key, sig);
      out.push(`Shared section ${title(key)} needs attention: ${view.label}`);
    }
    for (const key of [...this.#said.keys()]) if (!statuses.has(key)) this.#said.delete(key);
    return out;
  }
}

export interface ProblemAt {
  /** 0-based line. */
  readonly line: number;
  /** The section's title as the note shows it. */
  readonly title: string;
}

/**
 * The first problem after the cursor's line (wrapping to the first), its
 * position and how many there are; null when there is none.
 */
export function nextProblem(
  problems: readonly ProblemAt[],
  cursorLine: number,
): { readonly at: ProblemAt; readonly index: number; readonly total: number } | null {
  if (problems.length === 0) return null;
  const sorted = [...problems].sort((a, b) => a.line - b.line);
  const i = sorted.findIndex((p) => p.line > cursorLine);
  const index = i < 0 ? 0 : i;
  return { at: sorted[index] as ProblemAt, index: index + 1, total: sorted.length };
}
