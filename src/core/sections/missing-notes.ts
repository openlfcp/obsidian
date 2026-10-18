// The bases of notes that are gone (LFCP-03-048, ADR 0002 design 2). A note
// deleted, renamed while Obsidian was closed or replaced by a sync leaves its
// projection bases in the local state. They are kept, because a note that
// comes back merges through them; they are swept only when the note has been
// missing for a long time, and only then.
//
// Never swept: the base of a note that exists; any candidate (a kept copy is
// the only copy of its text: the user discards it); anything in a sweep that
// cannot tell the vault is loaded. Idempotent and safe to stop anywhere: a
// base is removed last, after its unfinished operations are closed, and a
// mark with no base left is cleaned by the next sweep.

import { toBase64url } from "@openlfcp/core";
import { type StoredBase, sectionBaseKey } from "./base";
import { abandonOnce, type JournalEntry } from "./journal";
import type { KeyValue, KeyValueSectionBaseStore, KeyValueSectionJournalStore } from "./stores";

const DAY = 24 * 60 * 60 * 1000;
/** How long a note must have been missing before its bases may go. */
export const MISSING_TTL_MS = 30 * DAY;
/**
 * And on how many different days a sweep saw it missing. A clock that jumped
 * forward makes the age long at once; it cannot make the plugin run on
 * different days.
 */
export const MIN_OBSERVED_DAYS = 7;
/** The reason an operation of a swept projection is closed with. */
export const NOTE_DELETED = "note-deleted";

const MARK = "section-missing:";
const markKey = (path: string) => `${MARK}${path}`;
const BASE = "section-base:";

/** When a note was first seen missing, and the days a sweep saw it so. */
export interface MissingMark {
  readonly since: number;
  readonly lastDay: number;
  readonly days: number;
}

const dayOf = (ms: number) => Math.floor(ms / DAY);

/** The mark after a sweep that sees the note missing at `now`. */
export function observed(mark: MissingMark | undefined, now: number): MissingMark {
  // A clock set back: the age cannot be trusted, count again from now.
  if (mark === undefined || mark.since > now) return { since: now, lastDay: dayOf(now), days: 1 };
  if (dayOf(now) > mark.lastDay)
    return { since: mark.since, lastDay: dayOf(now), days: mark.days + 1 };
  return mark;
}

export const expired = (mark: MissingMark, now: number): boolean =>
  now - mark.since >= MISSING_TTL_MS && mark.days >= MIN_OBSERVED_DAYS;

const isMark = (v: unknown): v is MissingMark =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as MissingMark).since === "number" &&
  typeof (v as MissingMark).lastDay === "number" &&
  typeof (v as MissingMark).days === "number";

export interface SweepEnv {
  readonly kv: KeyValue;
  readonly bases: KeyValueSectionBaseStore;
  readonly journal: KeyValueSectionJournalStore;
  /** Whether note `path` is in the vault now; asked again right before a base goes. */
  readonly exists: (path: string) => boolean;
  /** How many Markdown notes the vault has: none means it is not loaded (or unmounted). */
  readonly noteCount: () => number;
  /** The Resources on this device (base64url); null when they could not be read. */
  readonly resources: ReadonlySet<string> | null;
  readonly now: () => number;
}

export interface SweepReport {
  readonly skipped?: "no-listing" | "vault-empty";
  /** Notes with bases that are missing now. */
  readonly missing: number;
  /** Bases removed. */
  readonly swept: number;
  /** Of those, removed at once because their Resource left this device. */
  readonly resourceGone: number;
  /** Unfinished operations closed with the reason `note-deleted`. */
  readonly abandoned: number;
}

const SKIPPED = { missing: 0, swept: 0, resourceGone: 0, abandoned: 0 } as const;

/** Every stored base with its projection ID, by note path. */
async function basesByPath(kv: KeyValue): Promise<Map<string, { id: string; base: StoredBase }[]>> {
  const out = new Map<string, { id: string; base: StoredBase }[]>();
  for (const key of (await kv.keys?.(BASE)) ?? []) {
    const id = key.slice(BASE.length);
    const raw = (await kv.get(sectionBaseKey(id))) as
      | { locator?: { path?: string; resource?: string; sectionId?: string } }
      | null
      | undefined;
    const path = raw?.locator?.path;
    if (typeof path !== "string") continue;
    // Only the locator is read here; the store's own load gives the base when one is removed.
    const list = out.get(path) ?? [];
    list.push({ id, base: raw as unknown as StoredBase });
    out.set(path, list);
  }
  return out;
}

const resourceOf = (raw: StoredBase): string =>
  (raw.locator as unknown as { resource?: string }).resource ??
  toBase64url(raw.locator.section.resourceId);

/**
 * One sweep. Marks the notes whose bases have no note, clears the marks of
 * those that came back, and removes the bases of a note missing for
 * MISSING_TTL_MS (on MIN_OBSERVED_DAYS days of sweeps), or whose Resource left
 * this device while the note is missing. A base whose note exists is never
 * removed, whatever its mark says.
 */
export async function sweepMissingNotes(env: SweepEnv): Promise<SweepReport> {
  const { kv } = env;
  if (kv.keys === undefined) return { ...SKIPPED, skipped: "no-listing" };
  // A vault that lists no note is not loaded yet or not mounted: every note would look gone.
  if (env.noteCount() === 0) return { ...SKIPPED, skipped: "vault-empty" };
  const now = env.now();
  const byPath = await basesByPath(kv);
  let missing = 0;
  let swept = 0;
  let resourceGone = 0;
  let abandoned = 0;
  let unfinished: JournalEntry[] | null = null;

  const remove = async (path: string, id: string): Promise<boolean> => {
    // A note made again meanwhile keeps its base and its operations: asked before anything is
    // closed, before each operation, and again right before the base goes.
    if (env.exists(path)) return false;
    unfinished ??= await env.journal.unfinished();
    for (const e of unfinished) {
      if (e.projectionId !== id) continue;
      if (env.exists(path)) return false;
      if (await abandonOnce(env.journal, e.operationId, NOTE_DELETED)) abandoned++;
    }
    if (env.exists(path)) return false;
    await env.bases.save(id, null);
    return true;
  };

  for (const [path, entries] of byPath) {
    if (env.exists(path)) {
      if (await kv.get(markKey(path))) await kv.update(markKey(path), () => null);
      continue;
    }
    missing++;
    let mark: MissingMark | undefined;
    await kv.update(markKey(path), (v) => {
      mark = observed(isMark(v) ? v : undefined, now);
      return mark;
    });
    const old = mark !== undefined && expired(mark, now);
    let left = entries.length;
    for (const { id, base } of entries) {
      const gone = env.resources !== null && !env.resources.has(resourceOf(base));
      if (!old && !gone) continue;
      if (!(await remove(path, id))) continue;
      swept++;
      left--;
      if (gone && !old) resourceGone++;
    }
    if (left === 0) await kv.update(markKey(path), () => null);
  }
  // A mark whose bases are gone (a stop between the last removal and the mark, a base detached).
  for (const key of (await kv.keys(MARK)) ?? []) {
    const path = key.slice(MARK.length);
    if (!byPath.has(path)) await kv.update(key, () => null);
  }
  await repairPathIndexes(kv);
  return { missing, swept, resourceGone, abandoned };
}

/**
 * A stop between a base's removal and its path index entry leaves the index
 * naming a base that is gone. Readers skip it; this takes it out.
 */
async function repairPathIndexes(kv: KeyValue): Promise<void> {
  for (const key of (await kv.keys?.("section-projections:")) ?? []) {
    const ids = ((await kv.get(key)) as unknown[] | null | undefined) ?? [];
    const gone = new Set<string>();
    for (const id of ids)
      if (typeof id === "string" && !(await kv.get(sectionBaseKey(id)))) gone.add(id);
    if (gone.size > 0)
      await kv.update(key, (v) =>
        Array.isArray(v) ? v.filter((x) => typeof x !== "string" || !gone.has(x)) : v,
      );
  }
}

/**
 * The Resources on this device as the sweep may rely on them: null when the
 * registry could not be read, or the install has no storage (the registry
 * then answers an empty list, which means unknown, not "none").
 */
export function knownResources(
  hasStorage: boolean,
  entries: readonly { readonly resourceId: Uint8Array }[] | null,
): ReadonlySet<string> | null {
  if (!hasStorage || entries === null) return null;
  return new Set(entries.map((e) => toBase64url(e.resourceId)));
}

/** Whether the daily sweep is due: `last` is when one was last tried, failed or not (0: none yet). */
export const sweepDue = (last: number, now: number): boolean => last > 0 && now - last > DAY;

/** What diagnostics say of the bases of missing notes: how many notes, how old the oldest is. */
export async function missingNoteStats(
  kv: KeyValue,
  now: number,
): Promise<{ readonly notes: number; readonly oldestDays: number }> {
  let notes = 0;
  let oldest = 0;
  for (const key of (await kv.keys?.(MARK)) ?? []) {
    const v = await kv.get(key);
    if (!isMark(v)) continue;
    notes++;
    oldest = Math.max(oldest, Math.max(0, now - v.since));
  }
  return { notes, oldestDays: Math.floor(oldest / DAY) };
}
