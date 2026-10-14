// The placement index (LFCP-03-011): which notes of this vault hold a copy of
// each section Resource, read from the notes' markers. It lives in memory and
// is rebuilt at each start; it is local bookkeeping, never sent, and not a
// registry of its own (the Resources come from the runtime's registry).
//
// Completeness is tracked: until the start has read every note with a
// section, "no copy found" is not evidence that a section is not inserted
// anywhere (OBSIDIAN-UX-ARCHITECTURE-03 §2, U03-02). Pure: no Obsidian.

import type { SectionScan } from "./parser";

/**
 * The index's completeness: `unknown` before a build (or after one that
 * failed), `building` while the start reads the notes, `complete` once every
 * note with a section was read.
 */
export type PlacementIndexState = "unknown" | "building" | "complete";

/** One note's copies of one section Resource. */
export interface NotePlacement {
  /** The note's current vault path (local; follows renames). */
  readonly path: string;
  /** Copies with a valid boundary. */
  readonly copies: number;
  /** Copies whose boundary is damaged (C17): still copies, with a problem. */
  readonly damaged: number;
}

/** What one note holds, by section Resource (hex of its ID). */
export interface NoteSections {
  readonly copies: readonly string[];
  readonly damaged: readonly string[];
}

/** The Resources (hex) of a parsed note's copies, valid and damaged. */
export function noteSections(scan: SectionScan): NoteSections {
  return {
    copies: scan.sections.map((s) => hex(s.ref.resourceId)),
    damaged: scan.damaged.map((d) => hex(d.ref.resourceId)),
  };
}

interface Counts {
  copies: number;
  damaged: number;
}

export class PlacementIndex {
  /** Note path → Resource (hex) → its copies there. */
  readonly #notes = new Map<string, Map<string, Counts>>();
  #state: PlacementIndexState = "unknown";
  /** Why the last build did not complete, or null. */
  #failure: string | null = null;
  readonly #listeners = new Set<() => void>();

  get state(): PlacementIndexState {
    return this.#state;
  }

  get failure(): string | null {
    return this.#failure;
  }

  /** Called on every change of the index or of its state. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * A (re)build begins: what was indexed is dropped, and nothing is known
   * complete until `end`. Notes indexed meanwhile (vault changes) count.
   */
  begin(): void {
    this.#notes.clear();
    this.#state = "building";
    this.#failure = null;
    this.#changed();
  }

  /** The build read every note with a section; or it stopped (`failure`): completeness unknown. */
  end(failure?: string): void {
    if (this.#state !== "building") return;
    this.#state = failure === undefined ? "complete" : "unknown";
    this.#failure = failure ?? null;
    this.#changed();
  }

  /** Note `path` holds these copies now (replacing what it held). */
  index(path: string, held: NoteSections): void {
    const next = new Map<string, Counts>();
    for (const r of held.copies) count(next, r).copies++;
    for (const r of held.damaged) count(next, r).damaged++;
    const old = this.#notes.get(path);
    if (next.size === 0) {
      if (old === undefined) return;
      this.#notes.delete(path);
    } else {
      if (old !== undefined && same(old, next)) return;
      this.#notes.set(path, next);
    }
    this.#changed();
  }

  /** Note `path` is gone (deleted): it holds nothing. */
  unindex(path: string): void {
    if (this.#notes.delete(path)) this.#changed();
  }

  /** Note `oldPath` is now `newPath`: its copies go with it. */
  rename(oldPath: string, newPath: string): void {
    const held = this.#notes.get(oldPath);
    if (held === undefined || oldPath === newPath) return;
    this.#notes.delete(oldPath);
    this.#notes.set(newPath, held);
    this.#changed();
  }

  /** Whether note `path` holds any copy, valid or damaged. */
  has(path: string): boolean {
    return this.#notes.has(path);
  }

  /** The notes with a valid copy of Resource `resource` (hex): the ones a model change passes. */
  notesWith(resource: string): string[] {
    const out: string[] = [];
    for (const [path, held] of this.#notes)
      if ((held.get(resource)?.copies ?? 0) > 0) out.push(path);
    return out;
  }

  /** Every note with a copy of Resource `resource` (hex), valid or damaged, by path. */
  placements(resource: string): NotePlacement[] {
    const out: NotePlacement[] = [];
    for (const [path, held] of this.#notes) {
      const c = held.get(resource);
      if (c !== undefined) out.push({ path, copies: c.copies, damaged: c.damaged });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Every Resource (hex) with a copy in some note. */
  resources(): Set<string> {
    const out = new Set<string>();
    for (const held of this.#notes.values()) for (const r of held.keys()) out.add(r);
    return out;
  }

  #changed(): void {
    for (const l of [...this.#listeners]) l();
  }
}

function count(m: Map<string, Counts>, r: string): Counts {
  let c = m.get(r);
  if (c === undefined) {
    c = { copies: 0, damaged: 0 };
    m.set(r, c);
  }
  return c;
}

function same(a: ReadonlyMap<string, Counts>, b: ReadonlyMap<string, Counts>): boolean {
  if (a.size !== b.size) return false;
  for (const [r, c] of a) {
    const d = b.get(r);
    if (d === undefined || d.copies !== c.copies || d.damaged !== c.damaged) return false;
  }
  return true;
}

function hex(r: Uint8Array): string {
  return [...r].map((b) => b.toString(16).padStart(2, "0")).join("");
}
