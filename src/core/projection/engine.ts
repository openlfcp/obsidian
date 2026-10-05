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
import { type FieldIssue, type Plan, type ProjectionDiagnosticCode, planIntents } from "./intents";
import { type MoveRefRepair, suspectReassociation } from "./reassociation";
import { parseTaskText, statusOfGlyph } from "./task-text";

/** What the engine needs from the LFCP runtime. */
export interface ProjectionHost {
  hasResource(resource: ResourceId): Promise<boolean>;
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

  constructor(host: () => ProjectionHost | null, guard: MutationGuard) {
    this.#host = host;
    this.#guard = guard;
  }

  /** Object keys projected in `path` at the last scan. */
  indexed(path: string): readonly string[] {
    return [...(this.#index.get(path) ?? [])].sort();
  }

  /** Vault changes (whatever made them): rescans changed Markdown files. */
  async handleChanges(
    changes: readonly VaultChange[],
    read: (path: string) => Promise<string | null>,
  ): Promise<FileOutcome[]> {
    const out: FileOutcome[] = [];
    for (const change of changes) {
      if (change.kind === "delete") {
        // No LFCP operation: a deleted file only leaves the local index.
        this.#index.delete(change.path);
        this.#guard.forget(change.path);
        continue;
      }
      if (change.kind === "rename") {
        // Object identity is independent of the path (§23): only the index moves.
        const keys = this.#index.get(change.oldPath);
        this.#index.delete(change.oldPath);
        if (keys !== undefined) this.#index.set(change.path, keys);
        this.#guard.rename(change.oldPath, change.path);
      }
      const text = await read(change.path);
      if (text !== null) out.push(await this.processFile(change.path, text));
    }
    return out;
  }

  /** One file's current content: intents for its bound Tasks, and diagnostics. */
  async processFile(path: string, text: string): Promise<FileOutcome> {
    if (this.#guard.consume(path, text))
      return { path, skipped: "echo", sent: [], diagnostics: [] };
    const host = this.#host();
    if (host === null) return { path, skipped: "not-ready", sent: [], diagnostics: [] };

    const scan = scanRefs(text);
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
      const profile = await host.profileOf(R);
      const view = profile.replica.task(first.objectId);
      const plans: { p: MarkdownProjectionRef; plan: Plan }[] = [];
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
        const glyph = scan.tasks.find((t) => t.task.line === p.taskLine)?.task.status ?? " ";
        const plan = planIntents(
          { status: statusOfGlyph(glyph), text: parseTaskText(p.taskText) },
          view,
        );
        for (const i of plan.issues) note(p, i.code, i.message, fieldOf(i));
        plans.push({ p, plan });
      }
      const edits = plans.filter((x) => x.plan.intents.length > 0);
      const distinct = new Set(edits.map((x) => JSON.stringify(x.plan.intents)));
      if (distinct.size > 1) {
        for (const { p } of edits)
          note(
            p,
            "PROJECTIONS_DISAGREE",
            "Several copies of this shared Task in this note were edited differently; nothing is sent.",
          );
        continue;
      }
      const chosen = edits[0];
      if (chosen === undefined) continue;
      for (const intent of chosen.plan.intents) {
        try {
          await host.writeIntent(R, intent);
          sent.push({ resource: toBase64url(R), objectId: first.objectId, intent });
        } catch (e) {
          note(chosen.p, "WRITE_FAILED", e instanceof Error ? e.message : String(e));
          break;
        }
      }
    }
    return { path, sent, diagnostics };
  }
}

const fieldOf = (i: FieldIssue): { field?: string } =>
  i.field === undefined ? {} : { field: i.field };
