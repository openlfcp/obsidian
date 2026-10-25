// The section registry view (LFCP-03-011, F-02, F-10): a read-only facade
// over what this device already knows, for the pane (012/013). It joins:
//
//   - the runtime's registry: every section Resource on this device, with
//     its local alias (never sent) and registry state;
//   - the section model, where it is already open here: section ID and
//     shared title;
//   - the one status path (SectionsHost's StatusView), for watched Resources;
//   - the placement index: the notes that hold a copy, and whether every
//     note was read.
//
// It stores nothing and opens nothing: no second registry, no network
// session. A Resource with no status (not watched, or none yet) is unknown,
// never healthy. "Not inserted yet" needs a complete placement index; a
// copy found before that is still a placement. Rows are one per Resource
// and never merged by name. Pure: no Obsidian.

import { type ResourceId, toBase64url } from "@openlfcp/core";
import { PROFILE_ID } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import type { RegistryEntry, RegistryState } from "../lfcp/runtime";
import type { StatusState, StatusView } from "../status/reducer";
import type { NotePlacement, PlacementIndex, PlacementIndexState } from "./placement-index";

/** What the view reads; each read is local and opens no session. */
export interface RegistryViewSources {
  /** Every Resource on this device (LfcpRuntime.registry()). */
  registry(): Promise<readonly RegistryEntry[]>;
  /**
   * A section model already open on this device: its section ID and shared
   * title. null when it is not open here; the view never opens one.
   */
  model(resource: ResourceId): { readonly sectionId: string; readonly title: string } | null;
  /** Whether the Resource (hex) is watched, so that it has a status. */
  watched(resource: string): boolean;
  /** The status view of a section (key: Resource base64url # section ID). */
  status(key: string): StatusView | undefined;
  readonly placements: PlacementIndex;
}

/** Where a section's copies are: some note holds one, none does, or not known yet. */
export type Placed = "placed" | "unplaced" | "unknown";

export interface RegistryRow {
  /** The section Resource, base64url: the row's identity. */
  readonly resource: string;
  /** Its section ID, once the model is open here; else null. */
  readonly sectionId: string | null;
  /** The status key (Resource base64url # section ID), once the section ID is known. */
  readonly key: string | null;
  /** The heading text of the shared model; null until the model is open here. */
  readonly sharedTitle: string | null;
  /** The name given on this device (never sent; not a verified name); null if none. */
  readonly localAlias: string | null;
  readonly registryState: RegistryState;
  /** The code of the server's refusal of this Resource in this session, or null. */
  readonly refusal: string | null;
  /**
   * The section's status from the one status path. `state` is null when it
   * is unknown: the Resource is not watched, or it has no status yet. A
   * missing status is never healthy. `label` is the view's own words for
   * it (StatusView.label: the card's and the badge's), null when unknown.
   */
  readonly status: {
    readonly watched: boolean;
    readonly state: StatusState | null;
    readonly label: string | null;
  };
  /** The notes with a copy found so far, by path (local). */
  readonly placements: readonly NotePlacement[];
  /** The number of notes with a copy; null until the placement index is complete. */
  readonly placementCount: number | null;
  /** "unplaced" only once the placement index is complete. */
  readonly placed: Placed;
}

export interface RegistrySnapshot {
  /** Grows with each change a listener was told of. */
  readonly version: number;
  /** `loading` before the registry was first read; `error` when the last read failed. */
  readonly status: "loading" | "ready" | "error";
  /** Why the last read failed, or null. */
  readonly error: string | null;
  readonly placementIndex: PlacementIndexState;
  /** One per section Resource. On `error`, the rows of the last good read. */
  readonly rows: readonly RegistryRow[];
  /** The number of sections; null unless `ready` (an error is not an empty list). */
  readonly sections: number | null;
  /** Sections not inserted in any note; null unless `ready` and the index complete. */
  readonly unplaced: number | null;
  /** The 0.1 task collaborations on this device (not sections); null unless `ready`. */
  readonly legacy?: number | null;
}

/** A row's label (UX contract §7, N1–N3). */
export interface RowLabel {
  /** The shared title; before it loaded, the local alias; null when neither is known. */
  readonly primary: string | null;
  /** The primary label is the alias, to be qualified "(name on this device)". */
  readonly aliasOnly: boolean;
  /** The alias as a second line ("On this device: …"), only when it differs from the title. */
  readonly onThisDevice: string | null;
}

export function rowLabel(row: Pick<RegistryRow, "sharedTitle" | "localAlias">): RowLabel {
  const title = row.sharedTitle?.trim() ?? "";
  const alias = row.localAlias?.trim() ?? "";
  if (title !== "")
    return {
      primary: title,
      aliasOnly: false,
      onThisDevice: alias !== "" && alias !== title ? alias : null,
    };
  if (alias !== "") return { primary: alias, aliasOnly: true, onThisDevice: null };
  return { primary: null, aliasOnly: false, onThisDevice: null };
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export class SectionRegistryView {
  readonly #sources: RegistryViewSources;
  /** The section Resources of the last good registry read; null before one. */
  #entries: readonly RegistryEntry[] | null = null;
  /** How many of the last read's Resources are 0.1 task collaborations. */
  #legacy = 0;
  #error: string | null = null;
  #snapshot: RegistrySnapshot;
  #shape: string;
  readonly #listeners = new Set<(s: RegistrySnapshot) => void>();
  /** The registry read in flight, and whether another was asked meanwhile. */
  #reading: Promise<void> | null = null;
  #again = false;
  readonly #stop: () => void;

  constructor(sources: RegistryViewSources) {
    this.#sources = sources;
    this.#snapshot = this.#compose(0);
    this.#shape = shape(this.#snapshot);
    this.#stop = sources.placements.onChange(() => this.update());
  }

  /** The current snapshot (immutable). */
  snapshot(): RegistrySnapshot {
    return this.#snapshot;
  }

  /** Called with each new snapshot, when something a pane shows changed. */
  onChange(listener: (s: RegistrySnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The row of a section Resource (base64url), or undefined. */
  row(resource: string): RegistryRow | undefined {
    return this.#snapshot.rows.find((r) => r.resource === resource);
  }

  /** The rows with a copy in note `path`. */
  inNote(path: string): RegistryRow[] {
    return this.#snapshot.rows.filter((r) => r.placements.some((p) => p.path === path));
  }

  /**
   * Reads the registry again (a Resource joined, created, discarded, or its
   * state changed). Reads never overlap: one asked during a read runs once
   * after it.
   */
  refresh(): Promise<void> {
    if (this.#reading !== null) {
      this.#again = true;
      return this.#reading;
    }
    const run = async (): Promise<void> => {
      // The body runs only after #reading is set, even if a read throws at once.
      await undefined;
      try {
        do {
          this.#again = false;
          try {
            const all = await this.#sources.registry();
            this.#entries = all.filter((e) => e.profile === SECTIONS_PROFILE_ID);
            this.#legacy = all.filter((e) => e.profile === PROFILE_ID).length;
            this.#error = null;
          } catch (e) {
            this.#error = e instanceof Error ? e.message : String(e);
          }
          this.update();
        } while (this.#again);
      } finally {
        // In the same step as the last check of #again: a refresh asked
        // after it starts a new read instead of joining this finished one.
        this.#reading = null;
      }
    };
    this.#reading = run();
    return this.#reading;
  }

  /**
   * Recomposes the snapshot from what is read already (a status, a model
   * or the placement index changed); listeners hear of it only if it differs.
   */
  update(): void {
    const next = this.#compose(this.#snapshot.version + 1);
    const s = shape(next);
    if (s === this.#shape) return;
    this.#shape = s;
    this.#snapshot = next;
    for (const l of [...this.#listeners]) l(next);
  }

  dispose(): void {
    this.#stop();
    this.#listeners.clear();
  }

  #compose(version: number): RegistrySnapshot {
    const src = this.#sources;
    const index = src.placements.state;
    const complete = index === "complete";
    const rows: RegistryRow[] = [];
    for (const e of this.#entries ?? []) {
      const resource = toBase64url(e.resourceId);
      const hex = toHex(e.resourceId);
      const model = src.model(e.resourceId);
      const key = model === null ? null : `${resource}#${model.sectionId}`;
      const watched = src.watched(hex);
      const view = watched && key !== null ? src.status(key) : undefined;
      const placements = src.placements.placements(hex);
      rows.push(
        Object.freeze({
          resource,
          sectionId: model?.sectionId ?? null,
          key,
          sharedTitle: model?.title ?? null,
          localAlias: e.localName,
          registryState: e.state,
          refusal: e.refusal?.code ?? null,
          status: Object.freeze({
            watched,
            state: view?.state ?? null,
            label: view?.label ?? null,
          }),
          placements: Object.freeze(placements),
          placementCount: complete ? placements.length : null,
          placed: placements.length > 0 ? "placed" : complete ? "unplaced" : "unknown",
        } satisfies RegistryRow),
      );
    }
    rows.sort((a, b) => {
      const c = collator.compare(rowLabel(a).primary ?? "", rowLabel(b).primary ?? "");
      return c !== 0 ? c : a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0;
    });
    const status = this.#error !== null ? "error" : this.#entries === null ? "loading" : "ready";
    return Object.freeze({
      version,
      status,
      error: this.#error,
      placementIndex: index,
      rows: Object.freeze(rows),
      sections: status === "ready" ? rows.length : null,
      unplaced:
        status === "ready" && complete ? rows.filter((r) => r.placed === "unplaced").length : null,
      legacy: status === "ready" ? this.#legacy : null,
    });
  }
}

/** A snapshot without its version: what a listener is told changed. */
function shape(s: RegistrySnapshot): string {
  const { version: _, ...rest } = s;
  return JSON.stringify(rest);
}

function toHex(r: Uint8Array): string {
  return [...r].map((b) => b.toString(16).padStart(2, "0")).join("");
}
