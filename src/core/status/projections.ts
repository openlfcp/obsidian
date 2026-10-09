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

  /** One pass result of the section `key`. True when something the badge shows changed. */
  note(key: string, r: SectionResult): boolean {
    const { facts, failed } = projectionFact(r);
    const projections = this.#facts.get(key) ?? new Map<string, ProjectionFacts>();
    const before = JSON.stringify(projections.get(r.projectionId));
    projections.set(r.projectionId, facts);
    this.#facts.set(key, projections);
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

  /** A projection that is gone from its note (detached, deleted): it no longer counts. */
  forget(key: string, projectionId: string): void {
    this.#facts.get(key)?.delete(projectionId);
    this.#failed.get(key)?.delete(projectionId);
  }

  projections(key: string): ProjectionFacts[] {
    return [...(this.#facts.get(key)?.values() ?? [])];
  }

  failedOperations(key: string): string[] {
    return [...(this.#failed.get(key)?.values() ?? [])];
  }
}
