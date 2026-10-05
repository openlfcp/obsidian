// What the user is told about projection outcomes (LFCP-061), once per
// note, object and kind, so saving a note again does not repeat it. The
// adapter shows these as notices; the full diagnostics stay available.

import type { FileOutcome, ProjectionDiagnostic } from "./engine";
import type { MoveRefRepair } from "./reassociation";

const ANNOUNCED: Partial<
  Record<ProjectionDiagnostic["code"], (d: ProjectionDiagnostic) => string>
> = {
  TITLE_WIKILINK: () =>
    "OpenLFCP: a shared task's title links to notes. Collaborators see those note names.",
  RECURRENCE_NOT_SYNCED: () =>
    "OpenLFCP: recurrence (🔁) is not shared. Collaborators see the task without it.",
  REF_REASSOCIATION_SUSPECTED: () =>
    'OpenLFCP: a shared task\'s ref now sits under another task, so nothing was sent. Run "Repair moved shared task ref" to move it back.',
  FIELD_CONFLICTED: (d) =>
    `OpenLFCP: a shared task's ${d.field ?? "field"} has concurrent values; your edit was not sent.`,
  PROJECTIONS_DISAGREE: () =>
    "OpenLFCP: copies of one shared task in this note were edited differently; nothing was sent.",
  WRITE_FAILED: (d) => `OpenLFCP: a change could not be saved for sharing (${d.message}).`,
};

export class ProjectionNotices {
  readonly #announced = new Set<string>();
  /** path → repairs offered by the last scan of that note. */
  readonly #repairs = new Map<string, MoveRefRepair[]>();

  /** The messages to show for an outcome (each only the first time). */
  messages(outcome: FileOutcome): string[] {
    if (outcome.skipped !== undefined) return [];
    const repairs = outcome.diagnostics.flatMap((d) => (d.repair === undefined ? [] : [d.repair]));
    if (repairs.length > 0) this.#repairs.set(outcome.path, repairs);
    else this.#repairs.delete(outcome.path);
    const out: string[] = [];
    for (const d of outcome.diagnostics) {
      const render = ANNOUNCED[d.code];
      if (render === undefined) continue;
      const key = `${outcome.path}\u0000${d.objectId ?? ""}\u0000${d.code}\u0000${d.field ?? ""}`;
      if (this.#announced.has(key)) continue;
      this.#announced.add(key);
      const text = render(d);
      if (!out.includes(text)) out.push(text);
    }
    return out;
  }

  /** Repairs offered for a note, last line first (so applying them in order keeps line numbers valid). */
  repairs(path: string): MoveRefRepair[] {
    return [...(this.#repairs.get(path) ?? [])].sort((a, b) => b.from - a.from);
  }

  rename(oldPath: string, newPath: string): void {
    const r = this.#repairs.get(oldPath);
    this.#repairs.delete(oldPath);
    if (r !== undefined) this.#repairs.set(newPath, r);
  }
}
