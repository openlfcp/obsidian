// Keeping a note and the Shared Objects in step (LFCP-061 + LFCP-062).
// Obsidian-free: the adapter supplies note I/O.
//
// For one note: first the Markdown → intents pass on its current content
// (so an edit the user made but that was not sent yet is never overwritten),
// then the render of every bound Task from the current Shared Objects state.
// A note is written only when the render changes it, through
// guard.expect(path, content) and an atomic read-modify-write (Obsidian's
// vault.process), so the resulting vault event is skipped as an echo.
//
// Editor safety (item 6): a note open in an editor with unsaved changes is
// never written; it is deferred, and the save that follows (a vault change)
// runs the same pass. If the note changed between the read and the write,
// the write is abandoned the same way.

import { resourceId as asResourceId, fromBase64url, toBase64url } from "@openlfcp/core";
import type { SharedObjectsDataProfile, TaskView } from "@openlfcp/shared-objects";
import type { VaultChange } from "../vault/changes";
import {
  type FileOutcome,
  objectKey,
  type ProjectionEngine,
  type ProjectionHost,
  type SharedSnapshot,
} from "./engine";
import type { MutationGuard } from "./guard";
import { scanLegacy } from "./legacy-scan";
import { type RenderedProjection, type RenderTarget, renderNote } from "./render";

export interface NoteIO {
  read(path: string): Promise<string | null>;
  /** Atomically rewrites a note: `fn` gets the current content and returns the new one. */
  rewrite(path: string, fn: (data: string) => string): Promise<void>;
  /** The note is open in an editor whose content differs from `onDisk` (changes not saved yet). */
  isBeingEdited(path: string, onDisk: string): boolean;
}

export interface NoteOutcome {
  readonly path: string;
  /** The Markdown → intents pass (LFCP-061). */
  readonly projection?: FileOutcome;
  /** The render (LFCP-062), per bound Task. */
  readonly rendered: readonly RenderedProjection[];
  readonly wrote: boolean;
  /** Why the note was not written now (it will be on its next change). */
  readonly deferred?: "editing" | "changed";
}

/**
 * The note's text and the shared state of its objects at the same moment.
 * Shared changes (remote merges) do not touch the note's text until a later
 * render, which runs after this pass, so a snapshot taken synchronously
 * right after the read is the state the text was read against. Profiles are
 * looked up first (asynchronously); a read that names a Resource not looked
 * up yet looks it up and reads again.
 */
async function snapshotRead(
  read: () => Promise<string | null>,
  host: ProjectionHost,
): Promise<{ text: string; snapshot: SharedSnapshot } | null> {
  const profiles = new Map<string, SharedObjectsDataProfile | null>();
  for (;;) {
    const text = await read();
    if (text === null) return null;
    const projections = scanLegacy(text).projections;
    const missing = [...new Set(projections.map((p) => toBase64url(p.resourceId)))].filter(
      (r) => !profiles.has(r),
    );
    if (missing.length === 0) {
      // Synchronous from the read on: no shared change can land in between.
      const snapshot = new Map<string, TaskView | undefined>();
      for (const p of projections) {
        const profile = profiles.get(toBase64url(p.resourceId));
        if (profile) snapshot.set(objectKey(p), profile.replica.task(p.objectId));
      }
      return { text, snapshot };
    }
    for (const r of missing) {
      const R = asResourceId(fromBase64url(r));
      const usable = (await host.hasResource(R)) && (await host.supportsResource(R));
      profiles.set(r, usable ? await host.profileOf(R) : null);
    }
  }
}

export class ProjectionWriter {
  readonly #engine: ProjectionEngine;
  readonly #guard: MutationGuard;
  readonly #io: NoteIO;
  readonly #host: () => ProjectionHost | null;
  /** Notes to render on their next change. */
  readonly deferred = new Set<string>();

  constructor(
    engine: ProjectionEngine,
    guard: MutationGuard,
    io: NoteIO,
    host: () => ProjectionHost | null,
  ) {
    this.#engine = engine;
    this.#guard = guard;
    this.#io = io;
    this.#host = host;
  }

  /** Vault changes, whatever made them. */
  async handleChanges(changes: readonly VaultChange[]): Promise<NoteOutcome[]> {
    const out: NoteOutcome[] = [];
    for (const c of changes) {
      if (c.kind === "delete") {
        this.#engine.forgetPath(c.path);
        this.deferred.delete(c.path);
        continue;
      }
      if (c.kind === "rename") {
        this.#engine.renamePath(c.oldPath, c.path);
        if (this.deferred.delete(c.oldPath)) this.deferred.add(c.path);
      }
      out.push(await this.syncNote(c.path));
    }
    return out;
  }

  /**
   * Shared Objects changed (local writes, remote merges, rebuilds): renders
   * every note known to project them. `regressed` keys came from a G-EP7
   * rebuild.
   */
  async objectsChanged(
    keys: ReadonlySet<string>,
    regressed: ReadonlySet<string> = new Set(),
  ): Promise<NoteOutcome[]> {
    const paths = new Set<string>();
    for (const k of keys) for (const p of this.#engine.pathsOf(k)) paths.add(p);
    const out: NoteOutcome[] = [];
    for (const p of [...paths].sort()) out.push(await this.syncNote(p, regressed));
    return out;
  }

  /**
   * G-EP5: own changes a Key Epoch cut off are re-applied from the notes
   * that show them: their bases are forgotten, so the next pass sends each
   * projection's Markdown as a new intent in the current epoch.
   */
  async reapply(keys: ReadonlySet<string>): Promise<void> {
    for (const k of keys) await this.#engine.forgetBase(k);
  }

  /** One note: the intents pass, then the render. */
  async syncNote(path: string, regressed: ReadonlySet<string> = new Set()): Promise<NoteOutcome> {
    const host = this.#host();
    if (host === null) return { path, rendered: [], wrote: false };
    const read = await snapshotRead(() => this.#io.read(path), host);
    if (read === null) {
      this.#engine.forgetPath(path);
      return { path, rendered: [], wrote: false };
    }
    const { text, snapshot } = read;
    if (this.#io.isBeingEdited(path, text)) {
      this.deferred.add(path);
      return { path, rendered: [], wrote: false, deferred: "editing" };
    }
    this.deferred.delete(path);
    const projection = await this.#engine.processFile(path, text, snapshot);

    // A projection whose edit could not be sent keeps the user's text: it is
    // not rendered over until the edit is sent.
    const unsent = new Set(
      projection.diagnostics
        .filter((d) => d.code === "WRITE_FAILED")
        .map((d) => `${d.resource}#${d.objectId}`),
    );
    const targets = new Map<string, RenderTarget>();
    for (const key of this.#engine.indexed(path)) {
      if (unsent.has(key)) continue;
      const [r, id] = key.split("#") as [string, string];
      const R = asResourceId(fromBase64url(r));
      // Reported by the intents pass; never rewritten.
      if (!(await host.hasResource(R)) || !(await host.supportsResource(R))) continue;
      const profile = await host.profileOf(R);
      targets.set(key, { view: profile.replica.task(id), regressed: regressed.has(key) });
    }
    const result = renderNote(text, (key) => targets.get(key));
    if (!result.changed) return { path, projection, rendered: result.projections, wrote: false };

    let raced = false;
    await this.#io.rewrite(path, (data) => {
      if (data !== text) {
        raced = true;
        return data;
      }
      this.#guard.expect(path, result.text);
      return result.text;
    });
    if (raced) {
      this.deferred.add(path);
      return { path, projection, rendered: result.projections, wrote: false, deferred: "changed" };
    }
    return { path, projection, rendered: result.projections, wrote: true };
  }
}
