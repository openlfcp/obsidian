// What the user is told about projection outcomes (LFCP-061), once per
// note, object and kind, so saving a note again does not repeat it. The
// adapter shows these as notices; the full diagnostics stay available.

import type { FileOutcome, ProjectionDiagnostic } from "./engine";
import type { MoveRefRepair } from "./reassociation";
import type { RenderedProjection } from "./render";

const ANNOUNCED: Partial<
  Record<ProjectionDiagnostic["code"], (d: ProjectionDiagnostic) => string>
> = {
  TITLE_WIKILINK: () =>
    "Shared Tasks: a shared task's title links to notes. Collaborators see those note names.",
  RECURRENCE_NOT_SYNCED: () =>
    "Shared Tasks: recurrence (🔁) is not shared. Collaborators see the task without it.",
  REF_REASSOCIATION_SUSPECTED: () =>
    'Shared Tasks: a shared task\'s ref now sits under another task, so nothing was sent. Run "Repair moved shared task ref" to move it back.',
  FIELD_CONFLICTED: (d) =>
    `Shared Tasks: a shared task's ${d.field ?? "field"} has concurrent values; your edit was not sent.`,
  PROJECTIONS_DISAGREE: () =>
    "Shared Tasks: copies of one shared task in this note were edited differently; nothing was sent.",
  RESOURCE_UNSUPPORTED: () =>
    "Shared Tasks: a task in this note belongs to a collaboration that needs a newer version of Shared Tasks. It does not sync here until you update the plugin.",
  WRITE_FAILED: (d) => `Shared Tasks: a change could not be saved for sharing (${d.message}).`,
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

  /** Messages for a render (LFCP-062): regressions and new conflicts, once each. */
  renderMessages(path: string, rendered: readonly RenderedProjection[]): string[] {
    const out: string[] = [];
    for (const p of rendered) {
      for (const i of p.issues)
        if (i.code === "STATE_REGRESSED" && this.#once(`${path}\u0000${p.key}\u0000${i.code}`))
          out.push(`Shared Tasks: ${i.message}`);
      if (
        p.conflicts.length > 0 &&
        this.#once(`${p.key}\u0000conflict\u0000${p.conflicts.join(",")}`)
      )
        out.push(
          `Shared Tasks: a shared task has concurrent values in ${p.conflicts.join(", ")}. The note shows one of them.`,
        );
    }
    return out;
  }

  #once(key: string): boolean {
    if (this.#announced.has(key)) return false;
    this.#announced.add(key);
    return true;
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
