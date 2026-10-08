// Markdown → Shared Object projection (LFCP-061). Obsidian-free: the
// plugin feeds it file contents; it scans refs (MARKDOWN-REFS-01), reads
// what each bound Task represents, diffs it with the current Shared Object
// and writes only the needed intents through the SDK (runtime.writeIntent:
// intent → Automerge change → queued Data Unit). Local Tasks (no ref) never
// produce anything; blocked refs neither. Raw lines are never synchronized.

import { type ResourceId, resourceId, toBase64url } from "@openlfcp/core";
import type { ReplicaIntent, SharedObjectsDataProfile } from "@openlfcp/shared-objects";
import { scanRefs } from "../refs";
import type { MarkdownProjectionRef } from "../refs/scanner";
import type { VaultChange } from "../vault/changes";
import type { MutationGuard } from "./guard";
import {
  type FieldIssue,
  type Plan,
  type ProjectionDiagnosticCode,
  planIntents,
  type Represented,
} from "./intents";
import { type MoveRefRepair, suspectReassociation } from "./reassociation";
import { parseTaskText, statusOfGlyph } from "./task-text";

/** What the engine needs from the LFCP runtime. */
export interface ProjectionHost {
  hasResource(resource: ResourceId): Promise<boolean>;
  /** Whether the stored Resource has the Shared Objects profile (others are never opened). */
  supportsResource(resource: ResourceId): Promise<boolean>;
  profileOf(resource: ResourceId): Promise<SharedObjectsDataProfile>;
  writeIntent(resource: ResourceId, intent: ReplicaIntent): Promise<unknown>;
}

export type EngineDiagnosticCode =
  | ProjectionDiagnosticCode
  /** A previously seen projection lost its ref: local detachment, the object is untouched. */
  | "PROJECTION_DETACHED"
  /** Writing an intent failed (e.g. writing is locked); the Markdown is unchanged. */
  | "WRITE_FAILED";

export interface ProjectionDiagnostic {
  readonly code: EngineDiagnosticCode;
  readonly severity: "warning" | "info" | "error";
  readonly path: string;
  /** 0-based Task line. */
  readonly line: number;
  readonly resource?: string;
  readonly objectId?: string;
  readonly field?: string;
  readonly message: string;
  /** ST-2: a repair the user can apply (applyRepair). */
  readonly repair?: MoveRefRepair;
}

export interface SentIntent {
  readonly resource: string;
  readonly objectId: string;
  readonly intent: ReplicaIntent;
}

export interface FileOutcome {
  readonly path: string;
  /** Why the file was not processed: the plugin's own write, or no runtime. */
  readonly skipped?: "echo" | "not-ready";
  readonly sent: readonly SentIntent[];
  readonly diagnostics: readonly ProjectionDiagnostic[];
}

const INFO = new Set<EngineDiagnosticCode>([
  "STATUS_NOT_OWNED",
  "COMPLETION_IGNORED",
  "PROJECTION_DETACHED",
  "LEGACY_TAGS_MIGRATED",
]);
const severity = (code: EngineDiagnosticCode): ProjectionDiagnostic["severity"] =>
  code === "WRITE_FAILED" ? "error" : INFO.has(code) ? "info" : "warning";

const objectKey = (p: { resourceId: Uint8Array; objectId: string }): string =>
  `${toBase64url(p.resourceId)}#${p.objectId}`;

export class ProjectionEngine {
  readonly #host: () => ProjectionHost | null;
  readonly #guard: MutationGuard;
  /** path → object keys projected there at the last scan (reconstructable from Markdown). */
  readonly #index = new Map<string, Set<string>>();
  /** path → object key → what the Markdown represented at the last sync (the three-way base). */
  readonly #bases = new Map<string, Map<string, Represented>>();
  readonly #store: BaseStore | undefined;

  constructor(host: () => ProjectionHost | null, guard: MutationGuard, store?: BaseStore) {
    this.#host = host;
    this.#guard = guard;
    this.#store = store;
  }

  async #basesOf(path: string): Promise<Map<string, Represented>> {
    let bases = this.#bases.get(path);
    if (bases === undefined) {
      const stored = (await this.#store?.load(path)) ?? {};
      bases = new Map(Object.entries(stored));
      this.#bases.set(path, bases);
    }
    return bases;
  }

  async #saveBases(path: string): Promise<void> {
    const bases = this.#bases.get(path);
    await this.#store?.save(
      path,
      bases === undefined || bases.size === 0 ? null : Object.fromEntries(bases),
    );
  }

  /**
   * Records what `text` shows as the index and the bases, without sending
   * anything: for the plugin's own writes (a guard echo does this too).
   */
  async reindex(path: string, text: string): Promise<void> {
    const scan = scanRefs(text);
    this.#index.set(path, new Set(scan.projections.map(objectKey)));
    const bases = new Map<string, Represented>();
    for (const p of scan.projections) {
      const key = objectKey(p);
      if (!bases.has(key)) bases.set(key, represent(p, scan));
    }
    this.#bases.set(path, bases);
    await this.#saveBases(path);
  }

  /** Object keys projected in `path` at the last scan. */
  indexed(path: string): readonly string[] {
    return [...(this.#index.get(path) ?? [])].sort();
  }

  /** Paths whose last scan projected the object `key` (`<resource>#<object id>`). */
  pathsOf(key: string): string[] {
    return [...this.#index]
      .filter(([, keys]) => keys.has(key))
      .map(([path]) => path)
      .sort();
  }

  /**
   * Forgets the base of `key` in every note, so the next pass treats each
   * projection's Markdown as the user's intent (G-EP5: re-applying an own
   * change a Key Epoch cut off).
   */
  async forgetBase(key: string): Promise<void> {
    for (const path of this.pathsOf(key)) {
      const bases = await this.#basesOf(path);
      if (bases.delete(key)) await this.#saveBases(path);
    }
  }

  /** A deleted note leaves the index; no LFCP operation. */
  forgetPath(path: string): void {
    this.#index.delete(path);
    this.#bases.delete(path);
    void this.#store?.save(path, null);
    this.#guard.forget(path);
  }

  /** Object identity is independent of the path (§23): only the index moves. */
  renamePath(oldPath: string, newPath: string): void {
    const keys = this.#index.get(oldPath);
    this.#index.delete(oldPath);
    if (keys !== undefined) this.#index.set(newPath, keys);
    const bases = this.#bases.get(oldPath);
    this.#bases.delete(oldPath);
    if (bases !== undefined) {
      this.#bases.set(newPath, bases);
      void this.#store?.save(oldPath, null);
      void this.#saveBases(newPath);
    }
    this.#guard.rename(oldPath, newPath);
  }

  /** Vault changes (whatever made them): rescans changed Markdown files. */
  async handleChanges(
    changes: readonly VaultChange[],
    read: (path: string) => Promise<string | null>,
  ): Promise<FileOutcome[]> {
    const out: FileOutcome[] = [];
    for (const change of changes) {
      if (change.kind === "delete") {
        this.forgetPath(change.path);
        continue;
      }
      if (change.kind === "rename") this.renamePath(change.oldPath, change.path);
      const text = await read(change.path);
      if (text !== null) out.push(await this.processFile(change.path, text));
    }
    return out;
  }

  /** One file's current content: intents for its bound Tasks, and diagnostics. */
  async processFile(path: string, text: string): Promise<FileOutcome> {
    if (this.#guard.consume(path, text)) {
      await this.reindex(path, text);
      return { path, skipped: "echo", sent: [], diagnostics: [] };
    }
    const host = this.#host();
    if (host === null) return { path, skipped: "not-ready", sent: [], diagnostics: [] };

    const scan = scanRefs(text);
    const bases = await this.#basesOf(path);
    const nextBases = new Map<string, Represented>();
    const diagnostics: ProjectionDiagnostic[] = [];
    const sent: SentIntent[] = [];
    const note = (
      p: MarkdownProjectionRef,
      code: EngineDiagnosticCode,
      message: string,
      extra: { field?: string; repair?: MoveRefRepair } = {},
    ) =>
      diagnostics.push({
        code,
        severity: severity(code),
        path,
        line: p.taskLine,
        resource: toBase64url(p.resourceId),
        objectId: p.objectId,
        message,
        ...extra,
      });

    // Detachment: a projection seen before whose ref is gone (§ DETACH).
    const now = new Set(scan.projections.map(objectKey));
    for (const key of this.#index.get(path) ?? [])
      if (!now.has(key)) {
        const [resource, objectId] = key.split("#") as [string, string];
        diagnostics.push({
          code: "PROJECTION_DETACHED",
          severity: "info",
          path,
          line: 0,
          resource,
          objectId,
          message: "This Task is no longer shared here; the shared object is unchanged.",
        });
      }
    this.#index.set(path, now);

    // Group the file's projections per object: one object, one decision.
    const groups = new Map<string, MarkdownProjectionRef[]>();
    for (const p of scan.projections) {
      const key = objectKey(p);
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }

    for (const projections of groups.values()) {
      const first = projections[0] as MarkdownProjectionRef;
      const R = resourceId(first.resourceId);
      if (!(await host.hasResource(R))) {
        for (const p of projections)
          note(
            p,
            "RESOURCE_UNKNOWN",
            "This Resource is not known on this device; nothing is sent.",
          );
        continue;
      }
      if (!(await host.supportsResource(R))) {
        for (const p of projections)
          note(
            p,
            "RESOURCE_UNSUPPORTED",
            "This collaboration needs a newer version of Shared Tasks; nothing is sent.",
          );
        continue;
      }
      const profile = await host.profileOf(R);
      const view = profile.replica.task(first.objectId);
      const key = objectKey(first);
      const base = bases.get(key);
      const plans: { p: MarkdownProjectionRef; plan: Plan; represented: Represented }[] = [];
      for (const p of projections) {
        const sharedTitle = view?.task?.title;
        const repair =
          sharedTitle === undefined ? null : suspectReassociation(p, scan.tasks, sharedTitle);
        if (repair !== null) {
          note(
            p,
            "REF_REASSOCIATION_SUSPECTED",
            `This shared Task's ref now sits under another Task line; nothing is sent. Move the ref back under "${sharedTitle}".`,
            { repair },
          );
          continue;
        }
        const represented = represent(p, scan);
        const plan = planIntents(represented, view, base);
        for (const i of plan.issues) note(p, i.code, i.message, fieldOf(i));
        plans.push({ p, plan, represented });
      }
      const edits = plans.filter((x) => x.plan.intents.length > 0);
      const distinct = new Set(edits.map((x) => JSON.stringify(x.plan.intents)));
      if (distinct.size > 1) {
        if (base !== undefined) nextBases.set(key, base); // still edits next time
        for (const { p } of edits)
          note(
            p,
            "PROJECTIONS_DISAGREE",
            "Several copies of this shared Task in this note were edited differently; nothing is sent.",
          );
        continue;
      }
      const chosen = edits[0];
      // The base becomes what the note shows now; a failed write keeps the old one (retried).
      const shown = (chosen ?? plans[0])?.represented ?? base;
      let failed = false;
      for (const intent of chosen?.plan.intents ?? []) {
        try {
          await host.writeIntent(R, intent);
          sent.push({ resource: toBase64url(R), objectId: first.objectId, intent });
        } catch (e) {
          note(
            (chosen as (typeof plans)[number]).p,
            "WRITE_FAILED",
            e instanceof Error ? e.message : String(e),
          );
          failed = true;
          break;
        }
      }
      const kept = failed ? base : shown;
      if (kept !== undefined) nextBases.set(key, kept);
    }
    this.#bases.set(path, nextBases);
    await this.#saveBases(path);
    return { path, sent, diagnostics };
  }
}

const fieldOf = (i: FieldIssue): { field?: string } =>
  i.field === undefined ? {} : { field: i.field };

/** Persists the three-way bases per note (local state, never synced; reconstructable). */
export interface BaseStore {
  load(path: string): Promise<Record<string, Represented> | undefined>;
  save(path: string, bases: Record<string, Represented> | null): Promise<void>;
}

/** What a projection's Task line represents (glyph status and parsed text). */
function represent(p: MarkdownProjectionRef, scan: ReturnType<typeof scanRefs>): Represented {
  const glyph = scan.tasks.find((t) => t.task.line === p.taskLine)?.task.status ?? " ";
  return { status: statusOfGlyph(glyph), text: parseTaskText(p.taskText) };
}
