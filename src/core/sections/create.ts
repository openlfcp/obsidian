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
import { contentHash } from "../projection/guard";
import { splitLines } from "../refs/lines";
import type { RefPlacement } from "../settings";
import { applyChanges, composeChanges } from "./engine";
import { formatBoundary, type SectionRef } from "./grammar";
import {
  type ImportChoices,
  importedTask,
  type LegacySource,
  legacyPreflight,
  legacyStrip,
  missingChoices,
} from "./legacy";
import { bindingChanges } from "./markers";
import { parseSections, type SectionNode } from "./parser";
import {
  CommitRefused,
  type NewSectionTask,
  type Receipt,
  type SectionIntent,
  type SectionPort,
} from "./port";
import { preflight, revalidate, type SharePreview, type ShareRange } from "./share";
import { type DocChange, nodeSource } from "./source-map";
import type { KeyValue } from "./stores";

export type CreationPhase =
  | "prepared"
  | "local"
  | "projected"
  | "hosted"
  | "cancelled"
  | "failed"
  /** An import whose note view was restored (054); the target stays as it is. */
  | "rolled-back";

/** An import of 0.1 shared Tasks (053, 054): what a rollback or a later check needs. Local only. */
export interface LegacyImport {
  /** The note's range as it was before the import, legacy refs and all. */
  readonly original: string;
  /** SHA-256 of the note when the import was chosen. */
  readonly originalRevision: string;
  /** Each source Task and the new Task IDs it was copied to (never shared). */
  readonly mapping: Readonly<Record<string, readonly string[]>>;
  /** Each source Resource's revision as captured. */
  readonly captured: Readonly<Record<string, string>>;
  /** The section as the import wrote it into the note: later edits show against it. */
  readonly written?: string;
}

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
  /** Present for an import of 0.1 shared Tasks. */
  readonly legacy?: LegacyImport;
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
const IMPORTS = "section-imports";
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
  async prepare(
    path: string,
    markdown: string,
    preview: SharePreview,
    /** A Task node's own content instead of its line's (an import's copied values), by line. */
    taskAt?: (line: number, id: string) => NewSectionTask | undefined,
    legacy?: LegacyImport,
  ): Promise<CreationEntry> {
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
            // The section's start marker sits after the heading: one line down.
            task:
              taskAt?.(n.lines.from - 1, id) ??
              this.deps.newTask(lines[n.lines.from]?.text ?? "", id),
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
      ...(legacy === undefined ? {} : { legacy }),
    };
    await this.#save(entry);
    return entry;
  }

  /**
   * Journals the import of a range holding 0.1 shared Tasks (053): the
   * legacy refs come out of the copy, each legacy Task becomes a new Task
   * with the source's values (and the chosen ones), and the original range
   * is kept locally for a rollback. Refused while the preflight blocks or a
   * choice is missing. The source collaboration is never written.
   */
  async prepareImport(
    path: string,
    markdown: string,
    range: ShareRange,
    source: (resource: string, objectId: string) => LegacySource | undefined,
    chosen: ImportChoices,
  ): Promise<CreationEntry> {
    const check = legacyPreflight(markdown, range, source);
    if (check.blocks.length > 0) throw new Error(`the import is blocked: ${check.blocks[0]?.code}`);
    const missing = missingChoices(check, chosen);
    if (missing.length > 0) throw new Error(`a choice is missing: ${missing[0]?.code}`);
    const strip = legacyStrip(markdown, range);
    const stripped = applyChanges(markdown, strip);
    const removedBefore = (line: number) =>
      strip.filter(
        (c) => markdown.slice(c.from, c.to).includes("\n") && c.from < lineStart(markdown, line),
      ).length;
    const lastLine = range.lastLine - removedBefore(range.lastLine + 1);
    const preview = preflight(stripped, { headingLine: range.headingLine, lastLine });
    if (preview.problems.length > 0)
      throw new Error(`the copy cannot be shared: ${preview.problems[0]?.code}`);
    const byLine = new Map(check.tasks.map((t) => [t.line - removedBefore(t.line), t]));
    const mapping: Record<string, string[]> = {};
    const taskAt = (line: number, id: string): NewSectionTask | undefined => {
      const t = byLine.get(line);
      const view = t === undefined ? undefined : source(t.resource, t.objectId)?.view;
      if (t === undefined || view === undefined) return undefined;
      mapping[t.objectId] = [...(mapping[t.objectId] ?? []), id];
      return importedTask(view, id, this.deps.createdBy, chosen.values?.[t.objectId]);
    };
    const original = splitLines(markdown)
      .slice(range.headingLine, range.lastLine + 1)
      .map((l) => l.text + l.eol)
      .join("");
    // Allocated in prepare; the mapping is filled as its Tasks are built.
    return this.prepare(path, stripped, preview, taskAt, {
      original,
      originalRevision: contentHash(markdown),
      mapping,
      captured: check.captured,
    });
  }

  /**
   * Restores the note's view of an import (054): the original range, legacy
   * refs and all, in place of the section when nobody edited it since the
   * import wrote it; otherwise after it, for comparison, so no work on the
   * new section is lost. The new section's Resource and anything already
   * shared or invited stay as they are.
   */
  async rollback(
    entry: CreationEntry,
  ): Promise<{ readonly kind: "restored" | "beside" | "none"; readonly entry: CreationEntry }> {
    const legacy = entry.legacy;
    if (legacy === undefined || (entry.phase !== "projected" && entry.phase !== "hosted"))
      return { kind: "none", entry };
    let kind: "restored" | "beside" | "none" = "none";
    await this.deps.edit(entry.path, (current) => {
      const section = parseSections(current).sections.find(
        (s) => s.ref.sectionId === entry.sectionId,
      );
      if (section === undefined) return null;
      const lines = splitLines(current);
      const from = lineStart(current, section.heading.line);
      const to = lineStart(current, section.endLine + 1);
      const now = lines
        .slice(section.heading.line, section.endLine + 1)
        .map((l) => l.text + l.eol)
        .join("");
      if (now === legacy.written) {
        kind = "restored";
        return [{ from, to, insert: legacy.original }];
      }
      kind = "beside";
      const eol = lines.find((l) => l.eol !== "")?.eol ?? "\n";
      const lead = current.slice(0, to).endsWith(eol) || to === 0 ? "" : eol;
      return [{ from: to, to, insert: `${lead}${eol}${legacy.original}` }];
    });
    if (kind === "none") return { kind, entry };
    const e: CreationEntry = { ...entry, phase: "rolled-back" };
    await this.#save(e);
    return { kind, entry: e };
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

  /** Imports whose note view can still be restored (054), most recent last. */
  async imports(path?: string): Promise<CreationEntry[]> {
    const out: CreationEntry[] = [];
    for (const id of ids(await this.deps.journal.get(IMPORTS))) {
      const e = (await this.deps.journal.get(entryKey(id))) as CreationEntry | undefined;
      if (e !== undefined && (path === undefined || e.path === path)) out.push(e);
    }
    return out;
  }

  async #save(e: CreationEntry): Promise<void> {
    await this.deps.journal.put(entryKey(e.operationId), e);
    if (e.legacy !== undefined)
      await this.deps.journal.update(IMPORTS, (v) => {
        const rest = ids(v).filter((x) => x !== e.operationId);
        return e.phase === "projected" || e.phase === "hosted" ? [...rest, e.operationId] : rest;
      });
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
    let written: string | undefined;
    await this.deps.edit(e.path, (current) => {
      // Already bound: the note was written, the journal not (a crash in between).
      if (parseSections(current).sections.some((s) => s.ref.sectionId === e.sectionId)) {
        bound = true;
        return null;
      }
      // An import: the legacy refs of its range come out with the binding.
      const strip = e.legacy === undefined ? [] : this.#legacyStrip(current, e);
      if (strip === null) return null;
      const base = applyChanges(current, strip);
      const now = revalidate(base, e.preview);
      if (now.kind === "changed") return null;
      const bindings = this.#bindings(base, now.preview, ref, e.nodeIds);
      const changes = bindings === null ? null : composeChanges(strip, bindings);
      bound = changes !== null;
      if (changes !== null && e.legacy !== undefined) {
        const out = applyChanges(current, changes);
        const s = parseSections(out).sections.find((x) => x.ref.sectionId === e.sectionId);
        written =
          s === undefined
            ? undefined
            : splitLines(out)
                .slice(s.heading.line, s.endLine + 1)
                .map((l) => l.text + l.eol)
                .join("");
      }
      return changes;
    });
    if (bound && written !== undefined && e.legacy !== undefined) {
      const withWritten: CreationEntry = { ...e, legacy: { ...e.legacy, written } };
      await this.#save(withWritten);
      Object.assign(e, { legacy: withWritten.legacy });
    }
    return bound;
  }

  /**
   * The legacy refs to take out of the note for an import: those of the
   * range that still holds the original (moved by edits elsewhere at most).
   */
  #legacyStrip(current: string, e: CreationEntry): DocChange[] | null {
    const legacy = e.legacy as LegacyImport;
    const length = splitLines(legacy.original).length;
    const lines = splitLines(current);
    for (let i = 0; i < lines.length; i++) {
      const region = lines
        .slice(i, i + length)
        .map((l) => l.text + l.eol)
        .join("");
      if (region !== legacy.original && `${region}` !== legacy.original.replace(/\r?\n$/, ""))
        continue;
      return legacyStrip(current, { headingLine: i, lastLine: i + length - 1 });
    }
    return null;
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

/** The offset where line `n` (0-based) starts; the text's end past the last line. */
function lineStart(markdown: string, n: number): number {
  let at = 0;
  for (const l of splitLines(markdown).slice(0, n)) at += l.text.length + l.eol.length;
  return at;
}
