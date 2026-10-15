// The access list's facts the pane reads (LFCP-03-013): per section, whether
// this vault may invite and whether the section is on its server, from the
// same reading as the card's access list (AccessView), never assumed. A
// section's facts are read on demand (only the section the pane is about,
// never every row), kept until what they rest on changes, then forgotten at
// once: unknown until read again, never the old answer (P3). A read that
// was started before a change ends late and is dropped, by its epoch.
// Pure: no Obsidian.

import type { PaneAccess } from "./host-facts";

export interface PaneAccessSource {
  /** Reads a section's facts (the access list and hosting); may throw. */
  readonly load: (key: string) => Promise<PaneAccess>;
  /** Whether a section may be read now (it is watched): an unwatched one stays unknown. */
  readonly readable: (key: string) => boolean;
  /** Called when a read is done, kept or dropped (the pane redraws). */
  readonly changed: () => void;
}

/** Unknown: what a read that failed leaves until the next change. */
const UNKNOWN: PaneAccess = { canInvite: null, hosting: "unknown" };

export class PaneAccessFacts {
  readonly #known = new Map<string, PaneAccess>();
  readonly #epoch = new Map<string, number>();
  readonly #reading = new Set<string>();

  constructor(private readonly src: PaneAccessSource) {}

  /** The facts of section `key`, or undefined while not known; starts a read when there is none. */
  get(key: string): PaneAccess | undefined {
    const known = this.#known.get(key);
    if (known === undefined && !this.#reading.has(key) && this.src.readable(key))
      void this.#read(key);
    return known;
  }

  /** What section `key`'s facts rest on changed (its access, connection or refusal): forgotten now. */
  forget(key: string): void {
    this.#known.delete(key);
    this.#epoch.set(key, (this.#epoch.get(key) ?? 0) + 1);
  }

  async #read(key: string): Promise<void> {
    this.#reading.add(key);
    const epoch = this.#epoch.get(key) ?? 0;
    let facts: PaneAccess;
    try {
      facts = await this.src.load(key);
    } catch {
      // Not readable now: unknown, until the section's facts change and it is read again.
      facts = UNKNOWN;
    } finally {
      this.#reading.delete(key);
    }
    // Forgotten meanwhile: the answer is late; the next get reads the new one.
    if ((this.#epoch.get(key) ?? 0) === epoch) this.#known.set(key, facts);
    this.src.changed();
  }
}
