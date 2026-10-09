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
import {
  checkForward,
  type JournalEntry,
  type PendingCandidate,
  type SectionJournalStore,
} from "./journal";

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
/** Every candidate's ID, for the diagnostics counts (LFCP-02-065). */
const ALL_CANDIDATES = "section-candidates";

export class KeyValueSectionJournalStore implements SectionJournalStore {
  constructor(private readonly kv: KeyValue) {}

  async put(entry: JournalEntry): Promise<void> {
    checkForward(await this.get(entry.operationId), entry);
    await this.kv.put(opKey(entry.operationId), entry);
    const open = entry.phase !== "done" && entry.phase !== "abandoned";
    await this.kv.update(OPEN, open ? added(entry.operationId) : removed(entry.operationId));
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
    await this.kv.update(ALL_CANDIDATES, added(candidate.candidateId));
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
    if (c !== undefined && c !== null)
      await this.kv.update(candidateIndex(c.projectionId), removed(candidateId));
    await this.kv.update(ALL_CANDIDATES, removed(candidateId));
  }
}
