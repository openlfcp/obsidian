// What the badge knows of a section's projections in notes (LFCP-02-058,
// OBSIDIAN-SYNC-INDICATORS-01 §3, SI12, SI16): each engine pass result as
// projection facts, and a local commit that failed as a failed operation
// (LOCAL_SAVE_FAILED). One broken projection is that projection's problem;
// a healthy one in another note stays healthy (SI12). Pure.

import type { SectionResult } from "../sections/engine";
import type { ProjectionFacts } from "./reducer";

/** A pass result as its projection's facts, and the operation it failed to save, if any. */
export function projectionFact(r: SectionResult): {
  readonly facts: ProjectionFacts;
  readonly failed: string | null;
} {
  const fact = (
    source: ProjectionFacts["source"],
    application: ProjectionFacts["application"],
  ): ProjectionFacts => ({ id: r.projectionId, source, application });
  // SI17: nothing of the commit was saved for sync, because the local save
  // failed or the profile refused it; access refusals are access conditions.
  const failed =
    r.local?.kind === "save-failed"
      ? r.local.entry.operationId
      : r.local?.kind === "kept" && r.local.candidate.reason === "rejected"
        ? r.local.candidate.candidateId
        : null;
  if (r.skipped === "base-unknown") return { facts: fact("base-unknown", "blocked"), failed };
  if (r.skipped === "blocked") return { facts: fact("unsupported", "blocked"), failed };
  if (r.skipped === "importing" || r.skipped === "no-snapshot")
    return { facts: fact("clean", "unavailable"), failed };
  // NODE_BINDING_LOST: publication of this projection is suspended until repaired.
  if (r.lost.length > 0) return { facts: fact("binding-error", "blocked"), failed };
  // Text kept locally (refused, read-only, revoked): the note differs from the model.
  if (r.local?.kind === "kept") return { facts: fact("diverged", "blocked"), failed };
  if (r.held.length > 0) return { facts: fact("clean", "patch-pending"), failed };
  return { facts: fact("clean", "current"), failed };
}

/** Projection facts and failed operations per section key, kept from the latest passes. */
export class ProjectionFactsStore {
  readonly #facts = new Map<string, Map<string, ProjectionFacts>>();
  readonly #failed = new Map<string, Map<string, string>>();
  /** The model revision each projection was last passed at, by section key. */
  readonly #revisions = new Map<string, Map<string, string>>();

  /** One pass result of the section `key`. True when something the badge shows changed. */
  note(key: string, r: SectionResult): boolean {
    const { facts, failed } = projectionFact(r);
    const projections = this.#facts.get(key) ?? new Map<string, ProjectionFacts>();
    const before = JSON.stringify(projections.get(r.projectionId));
    projections.set(r.projectionId, facts);
    this.#facts.set(key, projections);
    const revisions = this.#revisions.get(key) ?? new Map<string, string>();
    if (r.modelRevision !== undefined) revisions.set(r.projectionId, r.modelRevision);
    this.#revisions.set(key, revisions);
    const ops = this.#failed.get(key) ?? new Map<string, string>();
    const hadFailed = ops.get(r.projectionId);
    // A later pass that saved (or had nothing to save) clears the projection's failure.
    if (failed !== null) ops.set(r.projectionId, failed);
    else if (r.local?.kind === "committed" || r.local?.kind === "nothing" || r.local === undefined)
      ops.delete(r.projectionId);
    this.#failed.set(key, ops);
    return before !== JSON.stringify(facts) || hadFailed !== ops.get(r.projectionId);
  }

  /** A failure outside a pass (a coalesced flush the store refused or could not save). */
  fail(key: string, projectionId: string, operationId: string): void {
    const ops = this.#failed.get(key) ?? new Map<string, string>();
    ops.set(projectionId, operationId);
    this.#failed.set(key, ops);
  }

  /**
   * The copies with a damaged boundary in note `path` now, by section key
   * (C17): each is a broken projection of its section until repaired; a key
   * no longer damaged there drops it. True when something changed.
   */
  damaged(path: string, keys: ReadonlySet<string>): boolean {
    const id = `damaged:${path}`;
    let changed = false;
    for (const [key, projections] of this.#facts)
      if (!keys.has(key) && projections.delete(id)) changed = true;
    for (const key of keys) {
      const projections = this.#facts.get(key) ?? new Map<string, ProjectionFacts>();
      if (!projections.has(id)) changed = true;
      projections.set(id, { id, source: "binding-error", application: "blocked" });
      this.#facts.set(key, projections);
    }
    return changed;
  }

  /** A projection that is gone from its note (detached, deleted): it no longer counts. */
  forget(key: string, projectionId: string): void {
    this.#facts.get(key)?.delete(projectionId);
    this.#failed.get(key)?.delete(projectionId);
    this.#revisions.get(key)?.delete(projectionId);
  }

  /**
   * The projections of `key`. With the model's `revision` now, a projection
   * shown as current but last passed at another revision is patch-pending:
   * the model has changes its note does not show yet (C14), so the section
   * is not CURRENT until a pass catches up.
   */
  projections(key: string, revision?: string): ProjectionFacts[] {
    const passed = this.#revisions.get(key);
    return [...(this.#facts.get(key)?.values() ?? [])].map((p) => {
      const at = passed?.get(p.id);
      return revision !== undefined &&
        at !== undefined &&
        at !== revision &&
        p.application === "current"
        ? { ...p, application: "patch-pending" }
        : p;
    });
  }

  /** Whether some projection of `key` was last passed at another revision than `revision`. */
  behind(key: string, revision: string): boolean {
    return [...(this.#revisions.get(key)?.values() ?? [])].some((at) => at !== revision);
  }

  failedOperations(key: string): string[] {
    return [...(this.#failed.get(key)?.values() ?? [])];
  }
}

/**
 * When to pass a section's notes for a model change no event announced
 * (C14): a lag seen on two status refreshes in a row at the same revision,
 * once per revision. A pass an event started catches up before the second
 * refresh, so events never get a duplicate pass.
 */
export class LagNudges {
  readonly #seen = new Map<string, string>();
  readonly #nudged = new Map<string, string>();

  /** Whether to pass `key`'s notes now, given its model `revision` and whether a note lags it. */
  decide(key: string, revision: string, behind: boolean): boolean {
    if (!behind) {
      this.#seen.delete(key);
      return false;
    }
    if (this.#nudged.get(key) === revision) return false;
    if (this.#seen.get(key) !== revision) {
      this.#seen.set(key, revision);
      return false;
    }
    this.#nudged.set(key, revision);
    return true;
  }
}
