// What the badge knows of a section's projections in notes (LFCP-02-058,
// OBSIDIAN-SYNC-INDICATORS-01 §3, SI12, SI16): each engine pass result as
// projection facts, and a local commit that failed as a failed operation
// (LOCAL_SAVE_FAILED). One broken projection is that projection's problem;
// a healthy one in another note stays healthy (SI12). Pure.

import type { SectionBaseStore } from "../sections/base";
import { sectionKey } from "../sections/context";
import type { SectionResult } from "../sections/engine";
import { damagedHeld, type HeldEdits, type HeldPersistence } from "./held";
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
  // Own work cut off by a Key Epoch waits: the stale-work condition speaks.
  if (r.skipped === "stale-work") return { facts: fact("clean", "blocked"), failed };
  if (r.skipped === "importing" || r.skipped === "no-snapshot")
    return { facts: fact("clean", "unavailable"), failed };
  // NODE_BINDING_LOST: publication of this projection is suspended until repaired.
  if (r.lost.length > 0) return { facts: fact("binding-error", "blocked"), failed };
  // Text kept locally (refused, read-only, revoked): the note differs from the model.
  if (r.local?.kind === "kept") return { facts: fact("diverged", "blocked"), failed };
  // A node deleted in the model shows in the note: restore it or remove it (Review conflicts).
  if ((r.reappeared?.length ?? 0) > 0) return { facts: fact("diverged", "current"), failed };
  // The note's tree is not the model's: never current (a silent divergence).
  if ((r.diverged?.length ?? 0) > 0) return { facts: fact("diverged", "current"), failed };
  if (r.held.length > 0) return { facts: fact("clean", "patch-pending"), failed };
  return { facts: fact("clean", "current"), failed };
}

/** Projection facts and failed operations per section key, kept from the latest passes. */
export class ProjectionFactsStore {
  readonly #facts = new Map<string, Map<string, ProjectionFacts>>();
  readonly #failed = new Map<string, Map<string, string>>();
  /** The model revision each projection was last passed at, by section key. */
  readonly #revisions = new Map<string, Map<string, string>>();
  /** What each projection holds back, by section key (F-04). */
  readonly #held = new Map<string, Map<string, HeldEdits>>();

  /** What projection `projectionId` of `key` holds back now (null: nothing). True when it changed. */
  held(key: string, projectionId: string, h: HeldEdits | null): boolean {
    const held = this.#held.get(key) ?? new Map<string, HeldEdits>();
    const before = JSON.stringify(held.get(projectionId));
    if (h === null) held.delete(projectionId);
    else held.set(projectionId, h);
    this.#held.set(key, held);
    return before !== JSON.stringify(h ?? undefined);
  }

  /**
   * After a pass of note `path`: what its projections other than `passed`
   * held is gone (a provisional ID that got its base, a copy removed). A
   * damaged copy's entry is damaged()'s to clear.
   */
  heldPassed(path: string, passed: ReadonlySet<string>): boolean {
    let changed = false;
    for (const held of this.#held.values())
      for (const [id, h] of held)
        if (h.path === path && !passed.has(id) && !id.startsWith("damaged:")) {
          held.delete(id);
          changed = true;
        }
    return changed;
  }

  /**
   * Whether note `path`, where edits are held, is saved to disk now
   * (LFCP-03-003): each of its held entries says so. True when it changed.
   */
  persisted(path: string, persistence: HeldPersistence): boolean {
    let changed = false;
    for (const held of this.#held.values())
      for (const [id, h] of held)
        if (h.path === path && h.persistence !== persistence) {
          held.set(id, { ...h, persistence });
          changed = true;
        }
    return changed;
  }

  /** Whether some edits are held in note `path`. */
  holds(path: string): boolean {
    for (const held of this.#held.values())
      for (const h of held.values()) if (h.path === path) return true;
    return false;
  }

  /** Every held projection, by section key. */
  allHeld(): ReadonlyMap<string, readonly HeldEdits[]> {
    return new Map([...this.#held].map(([k, m]) => [k, [...m.values()]]));
  }

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
  damaged(path: string, keys: ReadonlySet<string>, lines?: ReadonlyMap<string, number>): boolean {
    const id = `damaged:${path}`;
    let changed = false;
    for (const [key, projections] of this.#facts)
      if (!keys.has(key) && projections.delete(id)) {
        this.#held.get(key)?.delete(id);
        changed = true;
      }
    for (const key of keys) {
      const projections = this.#facts.get(key) ?? new Map<string, ProjectionFacts>();
      if (!projections.has(id)) changed = true;
      projections.set(id, { id, source: "binding-error", application: "blocked" });
      this.#facts.set(key, projections);
      // What is known of the note's saving stays until the next check says otherwise.
      const persistence = this.#held.get(key)?.get(id)?.persistence;
      const h = damagedHeld(path, id, lines?.get(key) ?? 0);
      if (this.held(key, id, persistence === undefined ? h : { ...h, persistence })) changed = true;
    }
    return changed;
  }

  /**
   * The provisional projections of note `path` (no base yet, their ID names
   * the path) are gone with it. True when there were any.
   */
  forgetProvisional(path: string): boolean {
    const prefix = `pending:${path}#`;
    let changed = false;
    for (const maps of [this.#facts, this.#failed, this.#revisions, this.#held] as const)
      for (const byId of maps.values())
        for (const id of [...byId.keys()])
          if (id.startsWith(prefix)) {
            byId.delete(id);
            changed = true;
          }
    return changed;
  }

  /** A projection that is gone from its note (detached, deleted): it no longer counts. */
  forget(key: string, projectionId: string): void {
    this.#facts.get(key)?.delete(projectionId);
    this.#failed.get(key)?.delete(projectionId);
    this.#revisions.get(key)?.delete(projectionId);
    this.#held.get(key)?.delete(projectionId);
  }

  /**
   * The projections of `key`. With the model's `revision` now, a projection
   * shown as current but last passed at another revision is patch-pending:
   * the model has changes its note does not show yet (C14), so the section
   * is not CURRENT until a pass catches up.
   */
  projections(key: string, revision?: string): ProjectionFacts[] {
    const passed = this.#revisions.get(key);
    const held = this.#held.get(key);
    return [...(this.#facts.get(key)?.values() ?? [])].map((p) => {
      const at = passed?.get(p.id);
      const h = held?.get(p.id);
      const q = h === undefined ? p : { ...p, held: h };
      return revision !== undefined &&
        at !== undefined &&
        at !== revision &&
        p.application === "current"
        ? { ...q, application: "patch-pending" }
        : q;
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

/**
 * Note `path` was deleted: its projections no longer count (LFCP-03-048), so
 * a section does not keep showing a problem, or held edits, in a note that is
 * gone. Their bases stay (a restore merges through them). `exists` is asked
 * after the bases were read: a note made again at the path (a sync's delete,
 * then create) may have been passed meanwhile, and its facts are the new
 * ones, so nothing is forgotten then. True when something changed.
 */
export async function forgetDeletedNote(
  facts: ProjectionFactsStore,
  bases: Pick<SectionBaseStore, "load" | "projectionsOf"> | null,
  path: string,
  exists: () => boolean,
): Promise<boolean> {
  const found: { key: string; id: string }[] = [];
  if (bases !== null)
    for (const id of await bases.projectionsOf(path)) {
      const b = await bases.load(id);
      if (b !== undefined) found.push({ key: sectionKey(b.locator.section), id });
    }
  if (exists()) return false;
  let changed = facts.heldPassed(path, new Set());
  if (facts.forgetProvisional(path)) changed = true;
  for (const f of found) {
    facts.forget(f.key, f.id);
    changed = true;
  }
  return changed;
}
