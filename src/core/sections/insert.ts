// Inserting a shared section into a note (LFCP-02-052,
// OBSIDIAN-SHARED-SECTIONS-UX-01 §5): only a section that is ready and
// fully loaded, written as one complete projection (heading, boundaries
// and every node bound) at a block boundary, never an empty section that
// fills in later. Inserting publishes nothing: the projection's base is
// the model it shows, so the engine has nothing to send.
//
// The insertion is journaled under its ID before the note is written, and
// that ID becomes the projection's: a retry finds its own block and does
// not write a second one; a deliberate second insertion has its own ID and
// makes a second projection. A note that changed since the preview takes
// the block at the same anchor line, or the insertion waits for a new one
// (stale). Cancelling an insertion writes nothing and leaves the joined
// Resource alone.

import { fromBase64url, type ResourceId, toBase64url } from "@openlfcp/core";
import type { Task } from "@openlfcp/shared-objects";
import { contentHash } from "../projection/guard";
import { lineKinds } from "../refs";
import { indentWidth, isBlank, splitLines } from "../refs/lines";
import type { RefPlacement } from "../settings";
import { markdownState, type SectionBaseStore } from "./base";
import { applyChanges } from "./engine";
import { formatBoundary, type SectionRef, sameSection } from "./grammar";
import { type ParsedSection, parseSections } from "./parser";
import type { SectionPort, SectionSnapshot } from "./port";
import { type ShareWarning, sectionPreview } from "./share";
import { type DocChange, lineStarts } from "./source-map";
import type { KeyValue } from "./stores";
import { planStructure } from "./structure";

export type InsertRefusal =
  /** No `ready` yet: the section is still being imported (SSP §12.1). */
  | "importing"
  /** The section is not here yet, or some of its changes are still missing. */
  | "not-loaded"
  /** The model has problems, or a node cannot be written as it is. */
  | "not-renderable";

export interface InsertPreview {
  readonly resource: string;
  readonly sectionId: string;
  readonly title: string;
  /** The exact lines that would be inserted. */
  readonly block: string;
  /** The section is read-only for this vault: edits here stay local. */
  readonly readOnly: boolean;
  /** The model revision the block shows. */
  readonly revision: string;
}

export interface InsertionEntry {
  readonly insertionId: string;
  readonly path: string;
  readonly preview: InsertPreview;
  /** The note's revision when the insertion was chosen, and the line the block goes before. */
  readonly target: {
    readonly revision: string;
    readonly line: number;
    /** The text of that line, to find it again in a changed note; null at the end. */
    readonly anchor: string | null;
    /** How many projections of the section the note had before. */
    readonly before: number;
  };
  readonly phase: "prepared" | "inserted" | "cancelled";
  readonly warnings?: readonly ShareWarning[];
}

export type InsertResult =
  | { readonly kind: "inserted"; readonly entry: InsertionEntry }
  /** The note changed where the block would go: choose the place again. */
  | { readonly kind: "stale"; readonly entry: InsertionEntry }
  | { readonly kind: "cancelled"; readonly entry: InsertionEntry };

export interface InsertionDeps {
  readonly port: SectionPort;
  readonly bases: SectionBaseStore;
  readonly journal: KeyValue;
  /** Whether every change of the Resource known so far is here (none held for a dependency). */
  readonly loaded: (resource: string) => boolean;
  /** A section Task as the model holds it, to render its line. */
  readonly task: (resource: string, taskId: string) => Task | undefined;
  /** Applies the changes `fn` returns against the note's current text; null applies nothing. */
  readonly edit: (
    path: string,
    fn: (current: string) => readonly DocChange[] | null,
  ) => Promise<void>;
  readonly newInsertionId: () => string;
  readonly refPlacement?: () => RefPlacement;
}

const OPEN = "section-inserts";
const entryKey = (id: string) => `section-insert:${id}`;
const ids = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/**
 * The line a new block goes before: after the block at `line` (at `line`
 * itself when it is blank), at the start of the next top-level block (a
 * heading, or a line after a blank one), outside every section, fence,
 * comment and front matter; the note's end otherwise.
 */
export function insertionLine(markdown: string, line: number): number {
  const lines = splitLines(markdown);
  const kinds = lineKinds(lines);
  const claimed = parseSections(markdown).claimed;
  const from = Math.max(0, isBlank(lines[line]?.text ?? "") ? line : line + 1);
  for (let l = from; l < lines.length; l++) {
    const inside = claimed.find((r) => l >= r.from && l <= r.to);
    if (inside !== undefined) {
      l = inside.to;
      continue;
    }
    const text = lines[l]?.text ?? "";
    const previous = lines[l - 1];
    const starts =
      l === 0 || (previous !== undefined && isBlank(previous.text)) || HEADING.test(text);
    if (starts && !isBlank(text) && kinds[l] !== "literal" && indentWidth(text) === 0) return l;
  }
  return lines.length;
}

/** How many projections of `ref` a note holds. */
const occurrences = (markdown: string, ref: SectionRef) =>
  parseSections(markdown).sections.filter((s) => sameSection(s.ref, ref)).length;

export class SectionInsertion {
  constructor(private readonly deps: InsertionDeps) {}

  /** The section as it would be inserted, or why it cannot be yet. */
  async preview(
    resource: ResourceId,
    sectionId: string,
    level = 2,
  ): Promise<InsertPreview | { readonly refused: InsertRefusal }> {
    const r = toBase64url(resource);
    const snap = this.deps.port.snapshot(r, sectionId);
    if (snap === undefined) return { refused: "not-loaded" };
    if (!snap.ready) return { refused: "importing" };
    if (!this.deps.loaded(r)) return { refused: "not-loaded" };
    const block = renderSection(snap, { resourceId: resource, sectionId }, level, {
      task: (id) => this.deps.task(r, id),
      placement: this.deps.refPlacement?.() ?? "child-line",
    });
    if (block === null) return { refused: "not-renderable" };
    return {
      resource: r,
      sectionId,
      title: snap.title,
      block,
      readOnly: !(await this.deps.port.canWrite(r)).allowed,
      revision: snap.revision,
    };
  }

  /** Journals an insertion of `preview` into `markdown` after the block at `line`, before writing anything. */
  async prepare(
    path: string,
    markdown: string,
    line: number,
    preview: InsertPreview,
  ): Promise<InsertionEntry> {
    const lines = splitLines(markdown);
    const at = insertionLine(markdown, line);
    const entry: InsertionEntry = {
      insertionId: this.deps.newInsertionId(),
      path,
      preview,
      target: {
        revision: contentHash(markdown),
        line: at,
        anchor: lines[at]?.text ?? null,
        before: occurrences(markdown, refOf(preview)),
      },
      phase: "prepared",
    };
    await this.#save(entry);
    return entry;
  }

  /** Writes the block (once) and records its projection; again after a crash, it finds its block. */
  async run(entry: InsertionEntry): Promise<InsertResult> {
    if (entry.phase === "cancelled") return { kind: "cancelled", entry };
    if (entry.phase === "inserted") return { kind: "inserted", entry };
    const ref = refOf(entry.preview);
    let written: string | null = null;
    await this.deps.edit(entry.path, (current) => {
      // Written before a crash: the note has one projection more than it had.
      if (occurrences(current, ref) > entry.target.before) {
        written = current;
        return null;
      }
      const at = this.#place(current, entry);
      if (at === null) return null;
      const change = blockChange(current, at, entry.preview.block);
      written = applyChanges(current, [change]);
      return [change];
    });
    if (written === null) return { kind: "stale", entry };
    const text: string = written;
    // The projection's base is the model the block shows.
    const sections = parseSections(text).sections.filter((s) => sameSection(s.ref, ref));
    const section =
      sections.find((s) => sectionText(text, s) === entry.preview.block) ?? sections.at(-1);
    if (section !== undefined && (await this.deps.bases.load(entry.insertionId)) === undefined)
      await this.deps.bases.save(entry.insertionId, {
        locator: { path: entry.path, section: ref },
        state: { ...markdownState(text, section).state, localComments: [] },
        revision: entry.preview.revision,
      });
    const done: InsertionEntry = {
      ...entry,
      phase: "inserted",
      ...(section === undefined ? {} : { warnings: sectionPreview(section) }),
    };
    await this.#save(done);
    return { kind: "inserted", entry: done };
  }

  /** Before the block is written: nothing is written; the Resource stays joined. */
  async cancel(entry: InsertionEntry): Promise<InsertionEntry> {
    if (entry.phase !== "prepared") return entry;
    const e: InsertionEntry = { ...entry, phase: "cancelled" };
    await this.#save(e);
    return e;
  }

  /** The insertions not written yet, to resume. */
  async unfinished(): Promise<InsertionEntry[]> {
    const out: InsertionEntry[] = [];
    for (const id of ids(await this.deps.journal.get(OPEN))) {
      const e = (await this.deps.journal.get(entryKey(id))) as InsertionEntry | undefined;
      if (e !== undefined) out.push(e);
    }
    return out;
  }

  async #save(e: InsertionEntry): Promise<void> {
    await this.deps.journal.put(entryKey(e.insertionId), e);
    await this.deps.journal.update(OPEN, (v) => {
      const rest = ids(v).filter((x) => x !== e.insertionId);
      return e.phase === "prepared" ? [...rest, e.insertionId] : rest;
    });
  }

  /** Where the block goes in `current`: the chosen line, or its anchor's line in a changed note. */
  #place(current: string, entry: InsertionEntry): number | null {
    const { target } = entry;
    if (contentHash(current) === target.revision) return target.line;
    const lines = splitLines(current);
    if (target.anchor === null) return lines.length;
    let best: number | null = null;
    lines.forEach((l, i) => {
      if (l.text !== target.anchor) return;
      if (best === null || Math.abs(i - target.line) < Math.abs(best - target.line)) best = i;
    });
    if (best === null || (best > 0 && insertionLine(current, best - 1) !== best)) return null;
    return best;
  }
}

const refOf = (p: InsertPreview): SectionRef => ({
  resourceId: fromBase64url(p.resource),
  sectionId: p.sectionId,
});

/** A section's lines in a note, heading to end marker, each with its line ending. */
function sectionText(markdown: string, s: ParsedSection): string {
  return splitLines(markdown)
    .slice(s.heading.line, s.endLine + 1)
    .map((l) => l.text + l.eol)
    .join("");
}

/** The change inserting `block` before line `at`, set apart from its neighbours by blank lines. */
function blockChange(markdown: string, at: number, block: string): DocChange {
  const lines = splitLines(markdown);
  const starts = lineStarts(lines);
  const eol = lines.find((l) => l.eol !== "")?.eol ?? "\n";
  const body = block.replace(/\n/g, eol);
  if (at >= lines.length) {
    const last = lines.at(-1);
    const end = markdown.length;
    const lead =
      last === undefined ? "" : last.eol === "" ? `${eol}${eol}` : isBlank(last.text) ? "" : eol;
    return { from: end, to: end, insert: `${lead}${body}` };
  }
  const offset = starts[at] ?? markdown.length;
  const previous = lines[at - 1];
  const lead = previous === undefined || isBlank(previous.text) ? "" : eol;
  return { from: offset, to: offset, insert: `${lead}${body}${eol}` };
}

/**
 * The complete projection of a loaded section: its heading, its boundaries
 * and every visible node in its binding form, or null when a node cannot be
 * written yet (a model problem, a Task not here, an unrenderable value).
 */
export function renderSection(
  snap: SectionSnapshot,
  ref: SectionRef,
  level: number,
  opts: { readonly task: (taskId: string) => Task | undefined; readonly placement: RefPlacement },
): string | null {
  if (/[\r\n]/.test(snap.title)) return null;
  const empty = `${"#".repeat(level)} ${snap.title}\n${formatBoundary("start", ref)}\n${formatBoundary("end", ref)}\n`;
  const section = parseSections(empty).sections[0];
  if (section === undefined) return null;
  const plan = planStructure(empty, section, { title: snap.title, nodes: {}, order: {} }, snap, {
    resourceId: ref.resourceId,
    task: opts.task,
    placement: opts.placement,
  });
  if (plan.deferred.length > 0) return null;
  const block = applyChanges(empty, plan.changes);
  // Every visible node is there, bound.
  const shown = parseSections(block).sections[0];
  if (shown === undefined || shown.blocked) return null;
  const state = markdownState(block, shown);
  const visible = Object.values(snap.nodes).filter(
    (n) => n.lifecycle === "active" && n.hidden !== true,
  );
  if (state.unbound.length > 0 || Object.keys(state.state.nodes).length !== visible.length)
    return null;
  return block;
}
