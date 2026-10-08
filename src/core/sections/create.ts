// Creating a shared section from an approved preview (LFCP-02-050,
// OBSIDIAN-SHARED-SECTIONS-UX-01 §3, SDK-SECTIONS-INTEGRATION-01 §3.1,
// SSP §12): one dedicated Resource, its section imported as one operation
// (the SDK splits it by the budgets and writes `ready` in its last change),
// the note's range bound to it, then hosting. Every identity and the whole
// batch are journaled before any effect, and every step can run again: a
// retry after a crash or a lost answer reuses the journaled Resource, IDs
// and operation, and never makes a second Resource or a second import.
//
//   prepared ──Resource + import──▶ local ──bind the note──▶ projected
//            ──host──▶ hosted (invitations from here on)
//
// The note is bound only onto the source the preview was approved for, or
// the same content moved by an edit elsewhere; anything else waits for a
// new review (stale). Cancelling before the note is bound keeps its text
// as it is; the Resource already created stays in the journal.

import { fromBase64url, type PrincipalId, type ResourceId, toBase64url } from "@openlfcp/core";
import { splitLines } from "../refs/lines";
import type { RefPlacement } from "../settings";
import { applyChanges, composeChanges } from "./engine";
import { formatBoundary, type SectionRef } from "./grammar";
import { bindingChanges } from "./markers";
import { parseSections, type SectionNode } from "./parser";
import {
  CommitRefused,
  type NewSectionTask,
  type Receipt,
  type SectionIntent,
  type SectionPort,
} from "./port";
import { revalidate, type SharePreview } from "./share";
import { type DocChange, nodeSource } from "./source-map";
import type { KeyValue } from "./stores";

export type CreationPhase = "prepared" | "local" | "projected" | "hosted" | "cancelled" | "failed";

export interface CreationEntry {
  readonly operationId: string;
  readonly path: string;
  /** The Resource (base64url) and section, chosen before any effect. */
  readonly resource: string;
  readonly sectionId: string;
  /** The node IDs, in the preorder of the range's nodes. */
  readonly nodeIds: readonly string[];
  /** The import: section.create, then every node in preorder; one operation. */
  readonly intents: readonly SectionIntent[];
  /** The preview the user approved. */
  readonly preview: SharePreview;
  readonly phase: CreationPhase;
  readonly receipt?: Receipt;
  /** Why the server has not hosted it yet (projected), or why it failed. */
  readonly reason?: string;
}

/** The hosting outcome of CollabService.host. */
export type HostResult =
  | { readonly kind: "hosted" }
  | { readonly kind: "pending"; readonly reason: string }
  | { readonly kind: "refused"; readonly code: string; readonly message: string };

export interface CreationHost {
  createSectionResource(o: {
    readonly name: string;
    readonly endpoints: readonly string[];
    readonly coordinatorUrl: string;
    readonly resourceId: ResourceId;
  }): Promise<ResourceId>;
  openSection(resource: ResourceId): Promise<unknown>;
  host(resource: ResourceId): Promise<HostResult>;
}

export interface CreationDeps {
  readonly host: CreationHost;
  readonly port: SectionPort;
  /**
   * Applies the changes `fn` returns against the note's current text (the
   * open editor's, else the file's), atomically; null applies nothing.
   */
  readonly edit: (
    path: string,
    fn: (current: string) => readonly DocChange[] | null,
  ) => Promise<void>;
  readonly journal: KeyValue;
  readonly createdBy: PrincipalId;
  readonly server: () => string;
  readonly newResourceId: () => ResourceId;
  readonly newNodeId: () => string;
  readonly newOperationId: () => string;
  readonly newTask: (lineText: string, id: string) => NewSectionTask;
  readonly refPlacement?: () => RefPlacement;
}

export type CreationResult =
  | { readonly kind: "hosted"; readonly entry: CreationEntry }
  /** Created and bound on this device; not hosted yet, so no invitation yet. */
  | { readonly kind: "local"; readonly entry: CreationEntry; readonly reason: string }
  /** The range changed since the preview: review it again. */
  | { readonly kind: "stale"; readonly entry: CreationEntry }
  | { readonly kind: "failed"; readonly entry: CreationEntry; readonly reason: string }
  | { readonly kind: "cancelled"; readonly entry: CreationEntry };

const OPEN = "section-creates";
const entryKey = (operationId: string) => `section-create:${operationId}`;
const ids = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

function preorder(nodes: readonly SectionNode[]): SectionNode[] {
  return nodes.flatMap((n) => [n, ...preorder(n.children)]);
}

/** The note with the range wrapped in the section's boundary markers, and the section parsed there. */
function withBoundaries(markdown: string, preview: SharePreview, ref: SectionRef) {
  const lines = splitLines(markdown);
  const eol = lines.find((l) => l.eol !== "")?.eol ?? "\n";
  /** Where a new line after line `n` goes: its ending first when it has none. */
  const after = (n: number): DocChange => {
    let at = 0;
    for (const l of lines.slice(0, n)) at += l.text.length + l.eol.length;
    const line = lines[n];
    const end = at + (line?.text.length ?? 0);
    return line === undefined || line.eol === ""
      ? { from: end, to: end, insert: eol }
      : { from: end + line.eol.length, to: end + line.eol.length, insert: "" };
  };
  const boundary = (n: number, kind: "start" | "end"): DocChange => {
    const c = after(n);
    return { ...c, insert: `${c.insert}${formatBoundary(kind, ref)}${eol}` };
  };
  const changes = [
    boundary(preview.range.headingLine, "start"),
    boundary(preview.range.lastLine, "end"),
  ];
  const text = applyChanges(markdown, changes);
  const section = parseSections(text).sections.find((s) => s.ref.sectionId === ref.sectionId);
  return { changes, text, section };
}

export class SectionCreation {
  constructor(private readonly deps: CreationDeps) {}

  /** Journals the creation of an approved preview: identities and the import, before any effect. */
  async prepare(path: string, markdown: string, preview: SharePreview): Promise<CreationEntry> {
    if (preview.problems.length > 0) throw new Error("the preview has problems: nothing to share");
    const R = this.deps.newResourceId();
    const sectionId = this.deps.newNodeId();
    const { text, section } = withBoundaries(markdown, preview, { resourceId: R, sectionId });
    if (section === undefined) throw new Error("the range does not parse as a section");
    const lines = splitLines(text);
    const nodes = preorder(section.nodes);
    const idOf = new Map(nodes.map((n) => [n, this.deps.newNodeId()]));
    const intents: SectionIntent[] = [
      { intent: "section.create", sectionId, title: preview.title, createdBy: this.deps.createdBy },
    ];
    const place = (children: readonly SectionNode[], parent: string) => {
      let after: string | null = null;
      for (const n of children) {
        const id = idOf.get(n) as string;
        if (n.kind === "task")
          intents.push({
            intent: "task.create_in_section",
            task: this.deps.newTask(lines[n.lines.from]?.text ?? "", id),
            parent,
            after,
          });
        else
          intents.push({
            intent: `${n.kind}.create`,
            id,
            parent,
            after,
            text: nodeSource(text, n)?.text ?? "",
            createdBy: this.deps.createdBy,
          });
        place(n.children, id);
        after = id;
      }
    };
    place(section.nodes, sectionId);
    const entry: CreationEntry = {
      operationId: this.deps.newOperationId(),
      path,
      resource: toBase64url(R),
      sectionId,
      nodeIds: nodes.map((n) => idOf.get(n) as string),
      intents,
      preview,
      phase: "prepared",
    };
    await this.#save(entry);
    return entry;
  }

  /** Runs, or resumes, a creation as far as it goes now. */
  async run(entry: CreationEntry): Promise<CreationResult> {
    let e = entry;
    const R = fromBase64url(e.resource) as ResourceId;
    if (e.phase === "cancelled") return { kind: "cancelled", entry: e };
    if (e.phase === "failed") return { kind: "failed", entry: e, reason: e.reason ?? "" };
    if (e.phase === "prepared") {
      const server = this.deps.server();
      await this.deps.host.createSectionResource({
        name: e.preview.title,
        endpoints: [server],
        coordinatorUrl: server,
        resourceId: R,
      });
      await this.deps.host.openSection(R);
      let receipt: Receipt | undefined;
      try {
        receipt = await this.deps.port.commit(e.resource, e.intents, {
          operationId: e.operationId,
        });
      } catch (error) {
        if (error instanceof CommitRefused) {
          e = { ...e, phase: "failed", reason: error.code };
          await this.#save(e);
          return { kind: "failed", entry: e, reason: error.code };
        }
        // The outcome is unknown: a receipt says it committed; without one the next run commits again.
        receipt = await this.deps.port.receiptOf(e.resource, e.operationId);
        if (receipt === undefined) throw error;
      }
      e = { ...e, phase: "local", receipt };
      await this.#save(e);
    }
    if (e.phase === "local") {
      if (!(await this.#project(e))) return { kind: "stale", entry: e };
      e = { ...e, phase: "projected" };
      await this.#save(e);
    }
    if (e.phase === "projected") {
      const hosted = await this.deps.host.host(R);
      if (hosted.kind !== "hosted") {
        const reason = hosted.kind === "pending" ? hosted.reason : hosted.message;
        e = { ...e, reason };
        await this.#save(e);
        return { kind: "local", entry: e, reason };
      }
      const { reason: _, ...rest } = e;
      e = { ...rest, phase: "hosted" };
      await this.#save(e);
    }
    return { kind: "hosted", entry: e };
  }

  /** Before the note is bound: its text stays as it is; the Resource created stays journaled. */
  async cancel(entry: CreationEntry): Promise<CreationEntry> {
    if (entry.phase !== "prepared" && entry.phase !== "local") return entry;
    const e: CreationEntry = { ...entry, phase: "cancelled" };
    await this.#save(e);
    return e;
  }

  /** The creations not finished yet, to resume or to show. */
  async unfinished(): Promise<CreationEntry[]> {
    const out: CreationEntry[] = [];
    for (const id of ids(await this.deps.journal.get(OPEN))) {
      const e = (await this.deps.journal.get(entryKey(id))) as CreationEntry | undefined;
      if (e !== undefined) out.push(e);
    }
    return out;
  }

  async #save(e: CreationEntry): Promise<void> {
    await this.deps.journal.put(entryKey(e.operationId), e);
    const open = e.phase === "prepared" || e.phase === "local" || e.phase === "projected";
    await this.deps.journal.update(OPEN, (v) => {
      const rest = ids(v).filter((x) => x !== e.operationId);
      return open ? [...rest, e.operationId] : rest;
    });
  }

  /** Binds the note to the section, onto the approved source or its moved content. */
  async #project(e: CreationEntry): Promise<boolean> {
    const ref: SectionRef = { resourceId: fromBase64url(e.resource), sectionId: e.sectionId };
    let bound = false;
    await this.deps.edit(e.path, (current) => {
      // Already bound: the note was written, the journal not (a crash in between).
      if (parseSections(current).sections.some((s) => s.ref.sectionId === e.sectionId)) {
        bound = true;
        return null;
      }
      const now = revalidate(current, e.preview);
      if (now.kind === "changed") return null;
      const changes = this.#bindings(current, now.preview, ref, e.nodeIds);
      bound = changes !== null;
      return changes;
    });
    return bound;
  }

  /** The boundary markers and every node's binding, as changes against `markdown`. */
  #bindings(
    markdown: string,
    preview: SharePreview,
    ref: SectionRef,
    nodeIds: readonly string[],
  ): DocChange[] | null {
    const { changes, text, section } = withBoundaries(markdown, preview, ref);
    if (section === undefined) return null;
    const nodes = preorder(section.nodes);
    if (nodes.length !== nodeIds.length) return null;
    const marks = bindingChanges(
      text,
      section,
      nodes.map((n, k) => ({ line: n.lines.from, kind: n.kind, id: nodeIds[k] as string })),
      ref.resourceId,
      this.deps.refPlacement?.() ?? "child-line",
    );
    if (marks.missed.length > 0) return null;
    return composeChanges(changes, marks.changes);
  }
}
