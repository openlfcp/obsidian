// Conflict indicators (LFCP-062, item 5): which bound Tasks show a field
// with concurrent values. The note shows the visible value as ordinary
// Markdown; the conflict is surfaced outside the text (a status bar count,
// an editor line decoration, notices), never as markers in the file.

import type { ScalarField } from "@openlfcp/shared-objects";
import type { RenderedProjection } from "./render";

/** The fields whose conflicts are surfaced (lifecycle and title too: they are mandatory, §44). */
export const SURFACED: readonly ScalarField[] = [
  "lifecycle",
  "title",
  "status",
  "due",
  "scheduled",
  "completion_date",
  "priority",
];

export interface ConflictMark {
  /** 0-based Task line at the last render. */
  readonly line: number;
  readonly key: string;
  readonly fields: readonly ScalarField[];
}

export class ConflictRegistry {
  readonly #byPath = new Map<string, ConflictMark[]>();
  readonly #listeners = new Set<() => void>();

  /** Replaces a note's marks with those of its latest render. */
  update(path: string, rendered: readonly RenderedProjection[]): void {
    const marks = rendered
      .map((p) => ({
        line: p.line,
        key: p.key,
        fields: p.conflicts.filter((f) => SURFACED.includes(f)),
      }))
      .filter((m) => m.fields.length > 0);
    const before = JSON.stringify(this.#byPath.get(path) ?? []);
    if (marks.length === 0) this.#byPath.delete(path);
    else this.#byPath.set(path, marks);
    if (before !== JSON.stringify(marks)) for (const l of this.#listeners) l();
  }

  forget(path: string): void {
    if (this.#byPath.delete(path)) for (const l of this.#listeners) l();
  }

  rename(oldPath: string, newPath: string): void {
    const marks = this.#byPath.get(oldPath);
    if (marks === undefined) return;
    this.#byPath.delete(oldPath);
    this.#byPath.set(newPath, marks);
    for (const l of this.#listeners) l();
  }

  marks(path: string): readonly ConflictMark[] {
    return this.#byPath.get(path) ?? [];
  }

  /** Distinct conflicted objects across notes. */
  get count(): number {
    return new Set([...this.#byPath.values()].flat().map((m) => m.key)).size;
  }

  /** The status bar text (empty when nothing is conflicted). */
  summary(): string {
    const n = this.count;
    return n === 0
      ? ""
      : `Shared Tasks: ${n} shared ${n === 1 ? "task has" : "tasks have"} a conflict`;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** The tooltip of a conflict mark. */
export const conflictTitle = (m: ConflictMark): string =>
  `Concurrent values in ${m.fields.join(", ")}: the note shows one of them. Resolve the conflict to choose.`;
