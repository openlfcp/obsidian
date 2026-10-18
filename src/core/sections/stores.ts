// The section engine's local records in the install database (LFCP-02-038):
// projection bases and the journal with its candidates, over the plugin's
// device-only key-value state (LfcpRuntime.localState). Never synced, never
// secrets. The store has no key listing, so each keeps its own indexes:
// projections by note path, unfinished operations, candidates by
// projection. Values are stored as they are (the install database keeps
// structured clones, so Uint8Array values survive); a section's Resource
// ID is kept as base64url so that a locator reads the same anywhere.

import { fromBase64url, toBase64url } from "@openlfcp/core";
import { type SectionBaseStore, type StoredBase, sectionBaseKey } from "./base";
import { sectionKey } from "./context";
import {
  checkForward,
  type JournalEntry,
  type PendingCandidate,
  type SectionJournalStore,
} from "./journal";
import { parseSections } from "./parser";

/** The plugin's local key-value state (LfcpRuntime.localState). */
export interface KeyValue {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  /** Read-modify-write of one key, serialized per key. */
  update(key: string, change: (value: unknown) => unknown): Promise<void>;
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const added = (id: string) => (v: unknown) => [...new Set([...list(v), id])].sort();
const removed = (id: string) => (v: unknown) => list(v).filter((x) => x !== id);
/** `id` appended once, keeping the order of addition (oldest first). */
const appended = (id: string) => (v: unknown) =>
  list(v).includes(id) ? list(v) : [...list(v), id];

interface StoredForm extends Omit<StoredBase, "locator"> {
  readonly locator: {
    readonly path: string;
    readonly resource: string;
    readonly sectionId: string;
  };
}

const toStored = (b: StoredBase): StoredForm => ({
  ...b,
  locator: {
    path: b.locator.path,
    resource: toBase64url(b.locator.section.resourceId),
    sectionId: b.locator.section.sectionId,
  },
});

const fromStored = (s: StoredForm): StoredBase => ({
  ...s,
  locator: {
    path: s.locator.path,
    section: { resourceId: fromBase64url(s.locator.resource), sectionId: s.locator.sectionId },
  },
});

const pathIndex = (path: string) => `section-projections:${path}`;

export class KeyValueSectionBaseStore implements SectionBaseStore {
  constructor(private readonly kv: KeyValue) {}

  async load(projectionId: string): Promise<StoredBase | undefined> {
    const v = (await this.kv.get(sectionBaseKey(projectionId))) as StoredForm | undefined;
    return v === undefined || v === null ? undefined : fromStored(v);
  }

  async save(projectionId: string, base: StoredBase | null): Promise<void> {
    const old = await this.load(projectionId);
    if (base === null) {
      await this.kv.put(sectionBaseKey(projectionId), null);
      if (old !== undefined)
        await this.kv.update(pathIndex(old.locator.path), removed(projectionId));
      return;
    }
    await this.kv.put(sectionBaseKey(projectionId), toStored(base));
    if (old !== undefined && old.locator.path !== base.locator.path)
      await this.kv.update(pathIndex(old.locator.path), removed(projectionId));
    await this.kv.update(pathIndex(base.locator.path), added(projectionId));
  }

  async projectionsOf(path: string): Promise<string[]> {
    return list(await this.kv.get(pathIndex(path)));
  }

  /** A note was renamed: its projections keep their IDs and bases, with the new path. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    for (const id of await this.projectionsOf(oldPath)) {
      const b = await this.load(id);
      if (b !== undefined) await this.save(id, { ...b, locator: { ...b.locator, path: newPath } });
    }
  }
}

const OPEN = "section-ops-open";
const opKey = (operationId: string) => `section-op:${operationId}`;
const candidateKey = (candidateId: string) => `section-candidate:${candidateId}`;
const candidateIndex = (projectionId: string) => `section-candidates:${projectionId}`;
/** Candidates by section key (LFCP-03-048): found whatever became of their projection or base. */
const sectionIndex = (key: string) => `section-candidates-of:${key}`;
/** Every candidate's ID, for the diagnostics counts (LFCP-02-065). */
const ALL_CANDIDATES = "section-candidates";

export class KeyValueSectionJournalStore implements SectionJournalStore {
  constructor(private readonly kv: KeyValue) {}

  async put(entry: JournalEntry): Promise<void> {
    checkForward(await this.get(entry.operationId), entry);
    await this.kv.put(opKey(entry.operationId), entry);
    const open = entry.phase !== "done" && entry.phase !== "abandoned";
    // Oldest first, as unfinished() promises: a restart replays them in that
    // order (sorted IDs were random UUIDs, 0.4.0-beta.8).
    await this.kv.update(OPEN, open ? appended(entry.operationId) : removed(entry.operationId));
  }

  async get(operationId: string): Promise<JournalEntry | undefined> {
    const v = await this.kv.get(opKey(operationId));
    return v === undefined || v === null ? undefined : (v as JournalEntry);
  }

  async unfinished(): Promise<JournalEntry[]> {
    const out: JournalEntry[] = [];
    for (const id of list(await this.kv.get(OPEN))) {
      const e = await this.get(id);
      if (e !== undefined && e.phase !== "done" && e.phase !== "abandoned") out.push(e);
    }
    return out;
  }

  async putCandidate(candidate: PendingCandidate): Promise<void> {
    await this.kv.put(candidateKey(candidate.candidateId), candidate);
    await this.kv.update(candidateIndex(candidate.projectionId), added(candidate.candidateId));
    if (candidate.sectionKey !== undefined)
      await this.kv.update(sectionIndex(candidate.sectionKey), added(candidate.candidateId));
    await this.kv.update(ALL_CANDIDATES, added(candidate.candidateId));
  }

  async candidatesOfSection(key: string): Promise<PendingCandidate[]> {
    const out: PendingCandidate[] = [];
    for (const id of list(await this.kv.get(sectionIndex(key)))) {
      const c = await this.kv.get(candidateKey(id));
      if (c !== undefined && c !== null) out.push(c as PendingCandidate);
    }
    return out;
  }

  /**
   * Gives each candidate without a section key one, from what it holds
   * (LFCP-03-048): the base of its projection, a provisional projection ID
   * (`pending:<path>#<resource>#<section>#<n>`), else the boundary markers in
   * its text. Idempotent, deletes nothing; a candidate whose section cannot
   * be told is left as it is and counted.
   */
  async backfillSectionKeys(): Promise<{ readonly filled: number; readonly unresolved: number }> {
    let filled = 0;
    let unresolved = 0;
    for (const c of await this.allCandidates()) {
      if (c.sectionKey !== undefined) continue;
      const key = await this.#keyOf(c);
      if (key === undefined) {
        unresolved++;
        continue;
      }
      // Atomic on the record: a candidate resolved meanwhile (the backfill may run beside
      // the first passes) stays resolved, never written back.
      let keyed = false;
      await this.kv.update(candidateKey(c.candidateId), (v) => {
        const now = v as PendingCandidate | null | undefined;
        if (now === undefined || now === null || now.sectionKey !== undefined) return v;
        keyed = true;
        return { ...now, sectionKey: key };
      });
      if (!keyed) continue;
      await this.kv.update(sectionIndex(key), added(c.candidateId));
      filled++;
    }
    return { filled, unresolved };
  }

  async #keyOf(c: PendingCandidate): Promise<string | undefined> {
    const base = (await this.kv.get(sectionBaseKey(c.projectionId))) as
      | StoredForm
      | null
      | undefined;
    if (base !== undefined && base !== null)
      return `${base.locator.resource}#${base.locator.sectionId}`;
    if (c.projectionId.startsWith("pending:")) {
      const parts = c.projectionId.split("#");
      const [resource, sectionId] = parts.slice(-3, -1);
      if (resource !== undefined && sectionId !== undefined) return `${resource}#${sectionId}`;
    }
    // Only a text of one section says which it is: with more (or none) nothing is guessed.
    const found = parseSections(c.sourceText).sections;
    const only = found.length === 1 ? found[0] : undefined;
    return only === undefined ? undefined : sectionKey(only.ref);
  }

  /**
   * A note was renamed: the candidates of its provisional projections
   * (`pending:<old path>#…`) take the new path, so the pass that seeds the
   * projection resolves them (F9). The copy is put first and the old one
   * resolved after, so a stop between leaves a duplicate, never a loss.
   */
  async renamePending(oldPath: string, newPath: string): Promise<void> {
    const prefix = `pending:${oldPath}#`;
    for (const c of await this.allCandidates()) {
      if (!c.projectionId.startsWith(prefix)) continue;
      const projectionId = `pending:${newPath}#${c.projectionId.slice(prefix.length)}`;
      const candidateId = c.candidateId.split(c.projectionId).join(projectionId);
      await this.putCandidate({ ...c, candidateId, projectionId });
      if (candidateId !== c.candidateId) await this.resolveCandidate(c.candidateId);
      else await this.kv.update(candidateIndex(c.projectionId), removed(c.candidateId));
    }
  }

  /** Every candidate kept on this device (diagnostics show their reasons and sizes only). */
  async allCandidates(): Promise<PendingCandidate[]> {
    const out: PendingCandidate[] = [];
    for (const id of list(await this.kv.get(ALL_CANDIDATES))) {
      const c = await this.kv.get(candidateKey(id));
      if (c !== undefined && c !== null) out.push(c as PendingCandidate);
    }
    return out;
  }

  async candidates(projectionId: string): Promise<PendingCandidate[]> {
    const out: PendingCandidate[] = [];
    for (const id of list(await this.kv.get(candidateIndex(projectionId)))) {
      const c = await this.kv.get(candidateKey(id));
      if (c !== undefined && c !== null) out.push(c as PendingCandidate);
    }
    return out;
  }

  async resolveCandidate(candidateId: string): Promise<void> {
    const c = (await this.kv.get(candidateKey(candidateId))) as PendingCandidate | undefined | null;
    await this.kv.put(candidateKey(candidateId), null);
    if (c !== undefined && c !== null) {
      await this.kv.update(candidateIndex(c.projectionId), removed(candidateId));
      if (c.sectionKey !== undefined)
        await this.kv.update(sectionIndex(c.sectionKey), removed(candidateId));
    }
    await this.kv.update(ALL_CANDIDATES, removed(candidateId));
  }
}
