// One reconciliation pass of a note's shared sections (LFCP-02-039..043):
// the parser, bases, planner, journal, bindings, remote projection and the
// plugin's own writes put together. Obsidian-free and CodeMirror-free; the
// editor extension and the vault adapter call it through the coordinator
// with the source they read, and write the changes it returns.
//
// Per section, in one pass:
// 1. The model's snapshot, taken synchronously with the read (before any
//    await), as the 0.3.2 rule requires.
// 2. Without a base, nothing is published (MS11): a note that shows the
//    model exactly seeds the base; anything else waits for a comparison.
// 3. The user's edits against the base go out as one batch (commit.ts),
//    and the new nodes get their bindings (markers.ts).
// 4. The model, read again after that commit, is projected onto the note
//    (remote.ts); a pass whose local edits could not be committed projects
//    nothing, so they are never overwritten.
// The note changes come back as one list against the source read; the host
// writes them through its route and calls `written` (or `abandoned`).

import { type PrincipalId, toBase64url } from "@openlfcp/core";
import { contentHash } from "../projection/guard";
import type { RenderTarget } from "../projection/render";
import { splitLines } from "../refs/lines";
import type { RefPlacement, SectionComments } from "../settings";
import type { SectionPlan, UnboundNode } from "./base";
import {
  commentBlocks,
  markdownState,
  type NodeState,
  placementOrder,
  planSection,
  predecessor,
  ROOT,
  restoredMoves,
  type SectionBaseStore,
  type SectionState,
  type StoredBase,
  UNBOUND_PARENT,
  withRestored,
} from "./base";
import {
  applyBatch,
  type CommitDeps,
  commitPass,
  finish,
  markProjected,
  type PassOutcome,
  resumeOperation,
} from "./commit";
import { type SectionRef, sameSection } from "./grammar";
import { canonicalInline } from "./inline";
import { transientCandidates } from "./input";
import { advance, type JournalEntry } from "./journal";
import { bindingChanges, type NewBinding } from "./markers";
import { type ParsedSection, parseSections, type SectionNode } from "./parser";
import type { NewSectionTask, SectionIntent, SectionSnapshot } from "./port";
import { recurringCopyRepair } from "./recurrence";
import { misplaced, modelTaskLine, planRemote, type RemotePlan } from "./remote";
import { type DocChange, lineStarts } from "./source-map";
import { planStructure, type StructurePlan } from "./structure";
import { planTaskFields } from "./task-fields";
import { type ChangeOrigin, compensate, SessionLedger } from "./undo";

export interface EngineDeps extends CommitDeps {
  readonly bases: SectionBaseStore;
  /** The local Principal, the creator of new nodes. */
  readonly createdBy: PrincipalId;
  readonly newProjectionId: () => string;
  /** The 0.1 render target of a Task in a Resource (base64url). */
  readonly tasks: (resource: string, taskId: string) => RenderTarget | undefined;
  /** A new Task's fields from its line (as planShare reads it), with its new ID. */
  readonly newTask: (lineText: string, id: string) => NewSectionTask;
  /** The binding placement setting for new Task refs (§4.1); child-line by default. */
  readonly refPlacement?: () => RefPlacement;
  /** The section comments setting (§4.5): new comments local (default) or shared as raw nodes. */
  readonly sectionComments?: () => SectionComments;
  /**
   * Whether a Resource (base64url) has own work a Key Epoch cut off that is
   * not re-applied or reviewed yet (stale-work.ts): its passes are skipped,
   * so the rebuilt model never overwrites the note's text.
   */
  readonly staleWork?: (resource: string) => boolean | Promise<boolean>;
}

/** What the host knows about the edits since the last pass. */
export interface PassContext {
  /** The caret's line in the source, or null (no editor, or not focused). */
  readonly caretLine: number | null;
  /**
   * Bound nodes the user's own transactions removed together with their
   * bindings (rules.ts: a deletion). Any other bound node missing from the
   * note is NODE_BINDING_LOST, its text kept and nothing deleted (§7).
   */
  readonly deletedIds: ReadonlySet<string>;
  /** undo / redo / other, from the transactions' userEvent (undo.ts). */
  readonly origin: ChangeOrigin;
  /**
   * Bound nodes of the editing session's last cut (rules.ts CutRecord). One
   * back in the note while deleted in the model is that cut pasted: a move,
   * its node restored where it was pasted (§10).
   */
  readonly cut?: ReadonlySet<string>;
  /**
   * Bound nodes whose binding the user's own transactions inserted since the
   * last pass (a paste, a drop, Move line): the user put them where the note
   * shows them, so a one-place swap is theirs to have moved, not the
   * neighbour's, and one deleted in the model is restored there, as a paste
   * of the cut is. Unlike `cut`, it does not depend on the cut being seen as
   * one (the owner's check of 0.4.0-beta.9, step 6).
   */
  readonly inserted?: ReadonlySet<string>;
  /**
   * Nodes the user chose to restore where the note shows them (Review
   * conflicts: a node back in the note while deleted in the model). Restored
   * and placed as a paste of the cut is.
   */
  readonly restore?: ReadonlySet<string>;
  /**
   * Whether the note's source is still the revision (SHA-256) this pass
   * read. Asked before anything is committed: an edit planned from an older
   * source would send that source's text back over newer changes (the idle
   * editor that reverted a collaborator's edit, 0.4.0-beta.13). Without it,
   * the source is taken as current.
   */
  readonly isCurrent?: (revision: string) => boolean | Promise<boolean>;
  /**
   * An external plugin edit since the last pass (a transaction without an
   * editor userEvent): a recurring Task's next occurrence may carry a copied
   * ref (MS43, recurrence.ts).
   */
  readonly external?: boolean;
}

export type SectionSkip =
  | "no-snapshot"
  | "importing"
  | "blocked"
  /** MS11: no base, and the note differs from the model: compare before publishing. */
  | "base-unknown"
  /** Own work a Key Epoch cut off waits to be re-applied or reviewed (§19.1). */
  | "stale-work";

export interface SectionResult {
  readonly projectionId: string;
  readonly section: SectionRef;
  readonly skipped?: SectionSkip;
  readonly local?: PassOutcome;
  readonly remote?: RemotePlan;
  /** Missing bound nodes not explained as a deletion: NODE_BINDING_LOST. */
  readonly lost: readonly string[];
  /**
   * Back in the note while deleted in the model, not explained by undo, redo
   * or the cut: the note differs from the model until the user restores the
   * node or removes it from the note. Nothing is sent for it.
   */
  readonly reappeared?: readonly string[];
  /**
   * Nodes the written note shows elsewhere than the model (remote.ts
   * misplaced): the projection is not current until a pass places them.
   */
  readonly diverged?: readonly string[];
  /** Text edits held because the node's base revision is unknown. */
  readonly held: readonly string[];
  /**
   * Nodes whose shared Text was put back into the note after the SDK refused
   * an edit planned on a base that drifted from the model: the note's text
   * is kept as a local copy, the model's is shown (and nothing was sent).
   */
  readonly restored?: readonly string[];
  /** The base to store once the changes are written. */
  readonly base?: StoredBase;
  /** Committed operations whose bindings these changes write (resumed ones first). */
  readonly entries: readonly JournalEntry[];
  /** Nodes the model created or moved, as written or deferred this pass. */
  readonly structure?: StructurePlan;
  /**
   * The model revision this pass leaves the projection at: the commit's when
   * it committed, else the snapshot's it projected. A later revision is
   * not in the note yet (C14).
   */
  readonly modelRevision?: string;
  /**
   * The source was no longer the note's when the section would commit:
   * nothing was committed or planned for it; the host passes again on the
   * current source.
   */
  readonly stale?: true;
}

export interface NotePass {
  readonly path: string;
  readonly source: string;
  /** SHA-256 of the source: the host writes only onto this revision (or maps through its own edits). */
  readonly sourceRevision: string;
  /** Note changes against `source`, ascending, not overlapping. */
  readonly changes: readonly DocChange[];
  readonly sections: readonly SectionResult[];
  /** A section found the source stale (SectionResult.stale): write nothing, pass again. */
  readonly stale?: true;
}

/** The model's visible state in the planner's terms: active nodes only. */
export function sharedState(s: SectionSnapshot): SectionState {
  const nodes: Record<string, SectionState["nodes"][string]> = {};
  for (const [id, n] of Object.entries(s.nodes))
    if (n.lifecycle === "active" && n.hidden !== true)
      nodes[id] = {
        kind: n.kind,
        parent: n.parent,
        ...(n.text === undefined ? {} : { text: n.text }),
      };
  const order: Record<string, readonly string[]> = {};
  for (const [parent, ids] of Object.entries(s.order))
    if (parent === ROOT || nodes[parent] !== undefined)
      order[parent] = ids.filter((id) => nodes[id] !== undefined);
  return { title: s.title, nodes, order };
}

/** Whether the note shows exactly the model: same title, nodes, parents, Text and order. */
export function sameState(a: SectionState, b: SectionState): boolean {
  if (a.title !== b.title) return false;
  const ids = Object.keys(a.nodes);
  if (ids.length !== Object.keys(b.nodes).length) return false;
  for (const id of ids) {
    const x = a.nodes[id];
    const y = b.nodes[id];
    if (y === undefined || x?.kind !== y.kind || x.parent !== y.parent) return false;
    if (x.text !== undefined && y.text !== undefined && x.text !== y.text) return false;
  }
  const order = (s: SectionState) =>
    JSON.stringify(
      Object.entries(s.order)
        .filter(([, v]) => v.length > 0)
        .sort(),
    );
  return order(a) === order(b);
}

/** `changes` applied to `text` (ascending, not overlapping). */
export function applyChanges(text: string, changes: readonly DocChange[]): string {
  let out = text;
  for (const c of [...changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

/**
 * `second` (changes against the text `first` produces) composed with
 * `first` into one list against the original text. An insertion at the
 * edge of one of `first`'s spans stays on its side of it; a change covering
 * such a span replaces it. A change that cuts into text `first` inserted
 * is not mappable: null (the caller writes `first` alone and plans again).
 */
export function composeChanges(
  first: readonly DocChange[],
  second: readonly DocChange[],
): DocChange[] | null {
  const spans = [...first].sort((a, b) => a.from - b.from);
  // Where each of `first`'s changes sits in the intermediate text.
  const at: { a: number; b: number; c: DocChange }[] = [];
  let delta = 0;
  for (const c of spans) {
    at.push({ a: c.from + delta, b: c.from + delta + c.insert.length, c });
    delta += c.insert.length - (c.to - c.from);
  }
  /**
   * An intermediate position on the original text, as the start or the end
   * of a range: a range never takes in text that `first` removed.
   */
  const map = (p: number, role: "from" | "to"): number | null => {
    let shift = 0;
    for (let i = 0; i < at.length; i++) {
      const s = at[i] as (typeof at)[number];
      if (p < s.a) return p - shift;
      if (p === s.a && s.b === s.a) {
        // Text `first` removed here: a range ends before it, starts after it
        // (and after any other removal at this same place).
        if (role === "to") return s.c.from;
        shift += s.c.insert.length - (s.c.to - s.c.from);
        continue;
      }
      if (p === s.a) return s.c.from;
      if (p < s.b) return null;
      if (p === s.b) {
        if (role === "to") return s.c.to;
        let end = s.c.to;
        for (let j = i + 1; j < at.length; j++) {
          const e = at[j] as (typeof at)[number];
          if (e.a !== p || e.b !== p) break;
          end = e.c.to;
        }
        return end;
      }
      shift += s.c.insert.length - (s.c.to - s.c.from);
    }
    return p - shift;
  };
  const dropped = new Set<DocChange>();
  /** `inter`: where the change sits in the intermediate text (ties keep its order). */
  const out: { c: DocChange; rank: number; inter: number }[] = [];
  for (const c of second) {
    // A span `first` emptied (a deletion) at the very edge of this change is
    // not covered by it: merged in, an insertion of `second` at that same
    // edge would land inside the merged range (the 5000-seed sweep, 2974).
    const covered = at.filter(
      (s) =>
        s.a >= c.from &&
        s.b <= c.to &&
        c.to > c.from &&
        (s.b > s.a || (s.a > c.from && s.a < c.to)),
    );
    for (const s of at)
      if (!covered.includes(s) && c.from < s.b && c.to > s.a && s.b > s.a) return null;
    const from = map(c.from, "from");
    const to = c.to === c.from ? from : map(c.to, "to");
    if (from === null || to === null) return null;
    for (const s of covered) dropped.add(s.c);
    // An insertion at the start of a span goes before it, at its end after it.
    const startEdge = at.some((s) => s.a === c.from && s.b > s.a);
    out.push({
      c: {
        from: Math.min(from, ...covered.map((s) => s.c.from)),
        to: Math.max(to, ...covered.map((s) => s.c.to)),
        insert: c.insert,
      },
      rank: c.to === c.from ? (startEdge ? 0 : 2) : 3,
      inter: c.from,
    });
  }
  for (const s of at)
    if (!dropped.has(s.c)) out.push({ c: s.c, rank: s.c.to === s.c.from ? 1 : 3, inter: s.a });
  // At one position of the original: insertions before a removal there (it
  // would take them), in the order the intermediate text has them.
  const width = (x: { c: DocChange }) => (x.c.to > x.c.from ? 1 : 0);
  return out
    .sort(
      (x, y) => x.c.from - y.c.from || width(x) - width(y) || x.inter - y.inter || x.rank - y.rank,
    )
    .map((x) => x.c);
}

/**
 * `base` with every restored node it still lacks where the model restored
 * it. A restored node under a parent without a binding yet (a Task pasted
 * under a new one) gets no placement in this batch: the restore brings it
 * back where the model has it, and the note's place is a move the next pass
 * sends, once the parent is bound (the peer-structure property test, seeds
 * 38 and 757).
 */
function withModelPlaced(
  base: SectionState,
  restored: readonly string[],
  inNote: (id: string) => NodeState | undefined,
  model: SectionSnapshot,
  as: (id: string, n: NodeState) => NodeState,
): SectionState {
  let out = base;
  for (const id of restored) {
    const n = inNote(id);
    // From the snapshot itself: a node under a deleted parent is hidden, yet
    // restored, and its move is still the user's to send (seed 757).
    const m = model.nodes[id];
    if (out.nodes[id] !== undefined || n === undefined || m === undefined) continue;
    const key = m.parent ?? ROOT;
    const list = [...(out.order[key] ?? [])];
    const siblings = model.order[key] ?? [];
    let after: string | undefined;
    for (let i = siblings.indexOf(id) - 1; i >= 0 && after === undefined; i--)
      if (list.includes(siblings[i] as string)) after = siblings[i];
    list.splice(after === undefined ? 0 : list.indexOf(after) + 1, 0, id);
    out = {
      ...out,
      nodes: { ...out.nodes, [id]: { ...as(id, n), parent: m.parent } },
      order: { ...out.order, [key]: list },
    };
  }
  return out;
}

/** The section `ref` in `markdown`, at or after the line `near` had (the same projection). */
function sectionLike(
  markdown: string,
  ref: SectionRef,
  near: ParsedSection,
): ParsedSection | undefined {
  return parseSections(markdown).sections.find(
    (s) => sameSection(s.ref, ref) && s.heading.line >= near.heading.line,
  );
}

/** A source line's number once insertion-only `changes` are applied. */
function shiftLine(line: number, source: string, changes: readonly DocChange[]): number {
  const at = lineStarts(splitLines(source))[line] ?? source.length;
  let shift = 0;
  for (const c of changes) if (c.from < at) shift += (c.insert.match(/\n/g) ?? []).length;
  return line + shift;
}

/**
 * The new nodes of a committed batch found again among the note's unbound
 * nodes, by kind and content (a paragraph's Text, a Task's title), in note
 * order: their IDs were allocated before the crash and are reused.
 */
/** The note line of the bound Task `id` in `section`. */
function taskLineOf(section: ParsedSection, id: string): number | undefined {
  const walk = (ns: readonly ParsedSection["nodes"][number][]): number | undefined => {
    for (const n of ns) {
      if (n.kind === "task" && n.id === id) return n.lines.from;
      const found = walk(n.children);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(section.nodes);
}

/** The node a create intent makes, if it is one. */
function createdIdOf(i: SectionIntent): string | undefined {
  return i.intent === "task.create_in_section"
    ? i.task.id
    : i.intent === "paragraph.create" || i.intent === "item.create" || i.intent === "raw.create"
      ? i.id
      : undefined;
}

function relocate(
  intents: readonly SectionIntent[],
  unbound: readonly UnboundNode[],
  used: Set<number>,
  /** A Task line's title, read as a new Task with the batch's own Task ID. */
  titleOf: (line: number, taskId: string) => string | undefined,
  /** The note line of each new node of the batch (JournalEntry.createdLines). */
  createdAt: Readonly<Record<string, number>> = {},
): NewBinding[] {
  const out: NewBinding[] = [];
  const kindOf = (i: SectionIntent) =>
    i.intent === "task.create_in_section" ? "task" : i.intent.slice(0, i.intent.indexOf("."));
  for (const i of intents) {
    const createdId =
      i.intent === "task.create_in_section"
        ? i.task.id
        : i.intent === "paragraph.create" || i.intent === "item.create" || i.intent === "raw.create"
          ? i.id
          : undefined;
    if (createdId === undefined) continue;
    // The line its ID was allocated for, when an unbound node of its kind is
    // still there: the user may have typed on since (its title or Text
    // differs then, and is the user's newer edit, not the model's).
    const line = createdAt[createdId];
    const there =
      line === undefined
        ? undefined
        : unbound.find((u) => u.line === line && !used.has(u.line) && u.kind === kindOf(i));
    if (there !== undefined) {
      used.add(there.line);
      out.push({ line: there.line, kind: there.kind, id: createdId });
      continue;
    }
    const match = (u: UnboundNode) => {
      if (used.has(u.line)) return false;
      if (i.intent === "task.create_in_section")
        return u.kind === "task" && titleOf(u.line, i.task.id) === i.task.title;
      if (
        i.intent === "paragraph.create" ||
        i.intent === "item.create" ||
        i.intent === "raw.create"
      )
        return u.kind === i.intent.slice(0, i.intent.indexOf(".")) && u.text === i.text;
      return false;
    };
    const u = unbound.find(match);
    if (u === undefined) continue;
    used.add(u.line);
    const id = i.intent === "task.create_in_section" ? i.task.id : "id" in i ? i.id : "";
    out.push({ line: u.line, kind: u.kind, id });
  }
  return out;
}

/** The texts of the comments a note's section keeps local (§4.5), for the base. */
function localCommentsOf(markdown: string, ref: SectionRef, near: ParsedSection): string[] {
  const s = sectionLike(markdown, ref, near);
  return s === undefined ? [] : commentBlocks(markdown, s).map((c) => c.text);
}

/** The prefix of a provisional projection ID (a section occurrence without a base). */
const PENDING = "pending:";

export class SectionEngine {
  readonly #ledger = new SessionLedger();

  constructor(private readonly deps: EngineDeps) {}

  #placement(): RefPlacement {
    return this.deps.refPlacement?.() ?? "child-line";
  }

  /** One pass over a note's sections, on `source` as just read. */
  async pass(path: string, source: string, ctx: PassContext): Promise<NotePass> {
    if (ctx.external === true) {
      // MS43: the Tasks plugin's next occurrence of a recurring Task loses
      // its copied ref first; the pass then sees it as a new Task.
      const repair = await this.#recurringRepairs(path, source);
      if (repair.length > 0) {
        // The repaired text is not the note's: freshness is the source's.
        const inner = await this.#pass(
          path,
          applyChanges(source, repair),
          ctx,
          contentHash(source),
        );
        const changes = composeChanges(repair, inner.changes);
        if (changes !== null)
          return { ...inner, source, sourceRevision: contentHash(source), changes };
      }
    }
    return this.#pass(path, source, ctx, contentHash(source));
  }

  async #recurringRepairs(path: string, source: string): Promise<DocChange[]> {
    const sections = parseSections(source).sections;
    const out: DocChange[] = [];
    for (const id of await this.deps.bases.projectionsOf(path)) {
      const b = await this.deps.bases.load(id);
      const section = sections.find(
        (s) => b !== undefined && sameSection(s.ref, b.locator.section),
      );
      if (b === undefined || section === undefined) continue;
      out.push(...recurringCopyRepair(source, section, b.state));
    }
    return out.sort((a, b) => a.from - b.from);
  }

  async #pass(path: string, source: string, ctx: PassContext, revision: string): Promise<NotePass> {
    const scan = parseSections(source);
    // The whole pass alone for each Resource of the note (port.exclusive): a
    // coalesced pass the timer commits meanwhile would be sent again by this
    // one, which replans what waits. In one order, so two passes never wait
    // for each other.
    const resources = [...new Set(scan.sections.map((s) => toBase64url(s.ref.resourceId)))].sort();
    const port = this.deps.port;
    const alone = resources.reduceRight<() => Promise<NotePass>>(
      (inner, r) => () => (port.exclusive === undefined ? inner() : port.exclusive(r, inner)),
      () => this.#passAlone(path, source, scan, ctx, revision),
    );
    return alone();
  }

  async #passAlone(
    path: string,
    source: string,
    scan: ReturnType<typeof parseSections>,
    ctx: PassContext,
    revision: string,
  ): Promise<NotePass> {
    const fresh = async () => ctx.isCurrent === undefined || (await ctx.isCurrent(revision));
    // A source already stale: nothing is planned, stored or committed from it.
    if (!(await fresh()))
      return {
        path,
        source,
        sourceRevision: contentHash(source),
        changes: [],
        sections: [],
        stale: true,
      };
    // The snapshot rule: every snapshot now, before the first await.
    const snapshots = scan.sections.map((s) =>
      this.deps.port.snapshot(toBase64url(s.ref.resourceId), s.ref.sectionId),
    );
    const projectionIds = await this.#projectionIds(path, scan.sections);
    const results: SectionResult[] = [];
    let changes: DocChange[] = [];
    for (const [k, section] of scan.sections.entries()) {
      const r = await this.#section(
        path,
        source,
        section,
        snapshots[k],
        projectionIds[k] as string,
        ctx,
        fresh,
      );
      const revision =
        r.result.local?.kind === "committed"
          ? r.result.local.receipt.modelRevision
          : snapshots[k]?.revision;
      results.push(revision === undefined ? r.result : { ...r.result, modelRevision: revision });
      changes = changes.concat(r.changes);
    }
    const stale = results.some((r) => r.stale === true);
    return {
      path,
      source,
      sourceRevision: contentHash(source),
      changes: stale ? [] : changes.sort((a, b) => a.from - b.from),
      sections: results,
      ...(stale ? { stale: true as const } : {}),
    };
  }

  /** The host wrote the pass's changes: bases are stored and operations finish. */
  async written(pass: NotePass, text: string): Promise<void> {
    const hash = contentHash(text);
    for (const r of pass.sections) {
      if (r.base !== undefined) {
        // Marks reported meanwhile (drifted()) outlive this base; those this
        // pass healed (its `restored`) are done.
        const now = driftMarks(await this.deps.bases.load(r.projectionId));
        const marks: Record<string, string | null> = { ...driftMarks(r.base) };
        for (const [id, text] of Object.entries(now))
          if (!(id in marks) && !(r.restored ?? []).includes(id)) marks[id] = text;
        const { drifted: _marks, ...base } = r.base;
        await this.deps.bases.save(
          r.projectionId,
          Object.keys(marks).length === 0 ? base : { ...base, drifted: marks },
        );
      }
      for (const entry of r.entries) {
        const projected = await markProjected(this.deps, entry, hash);
        await finish(this.deps, projected);
      }
    }
  }

  /**
   * The SDK refused a Text edit of these nodes as INVALID_INTENT (at once or
   * when a coalesced pass was flushed): the projection's base drifted from
   * the model. The next pass shows the model's Text for them.
   */
  async drifted(projectionId: string, nodeIds: readonly string[]): Promise<void> {
    const stored = await this.deps.bases.load(projectionId);
    if (stored === undefined || nodeIds.length === 0) return;
    const marks = driftMarks(stored);
    for (const id of nodeIds) if (!(id in marks)) marks[id] = null;
    await this.deps.bases.save(projectionId, { ...stored, drifted: marks });
  }

  /**
   * The changes were not written (the source moved on). Bases stay; a
   * committed operation stays committed in the journal, so its IDs are
   * projected by a later pass, never allocated again.
   */
  abandoned(_pass: NotePass): void {}

  /** Projection IDs of the note's sections: the stored ones by section, in order; new ones otherwise. */
  async #projectionIds(path: string, sections: readonly ParsedSection[]): Promise<string[]> {
    const known: { id: string; section: SectionRef }[] = [];
    for (const id of await this.deps.bases.projectionsOf(path)) {
      const b = await this.deps.bases.load(id);
      if (b !== undefined) known.push({ id, section: b.locator.section });
    }
    const used = new Set<string>();
    const seen = new Map<string, number>();
    return sections.map((s) => {
      const found = known.find((k) => !used.has(k.id) && sameSection(k.section, s.ref));
      if (found !== undefined) {
        used.add(found.id);
        return found.id;
      }
      // No base yet: a provisional ID, stable for this occurrence of the
      // section in this note, until a base is seeded (CM11 candidates).
      const key = `${toBase64url(s.ref.resourceId)}#${s.ref.sectionId}`;
      const k = seen.get(key) ?? 0;
      seen.set(key, k + 1);
      return `${PENDING}${path}#${key}#${k}`;
    });
  }

  async #section(
    path: string,
    source: string,
    section: ParsedSection,
    snap: SectionSnapshot | undefined,
    projectionId: string,
    ctx: PassContext,
    fresh: () => Promise<boolean>,
  ): Promise<{ result: SectionResult; changes: DocChange[] }> {
    const ref = section.ref;
    const resource = toBase64url(ref.resourceId);
    const none = { lost: [], held: [], entries: [] };
    const skip = (skipped: SectionSkip) => ({
      result: { projectionId, section: ref, skipped, ...none },
      changes: [],
    });
    if (snap === undefined) return skip("no-snapshot");
    if ((await this.deps.staleWork?.(resource)) === true) return skip("stale-work");
    if (section.blocked) return skip("blocked");
    if (!snap.ready) return skip("importing");

    const locator = { path, section: ref };
    const stored = await this.deps.bases.load(projectionId);
    const shared = sharedState(snap);
    if (stored === undefined) {
      // MS11, CM11: only a note that already shows the model seeds a base.
      // Otherwise its bindings are recovered but no causal base is guessed:
      // nothing is uploaded, and the section's source is kept as a
      // comparison candidate until the note and the model agree.
      const note = markdownState(source, section);
      const candidateId = `base-unknown:${projectionId}`;
      if (note.unbound.length > 0 || !sameState(note.state, shared)) {
        const lines = splitLines(source);
        await this.deps.journal.putCandidate({
          candidateId,
          projectionId,
          reason: "base-unknown",
          sourceText: lines
            .slice(section.heading.line, section.endLine + 1)
            .map((l) => l.text + l.eol)
            .join(""),
        });
        return skip("base-unknown");
      }
      await this.deps.journal.resolveCandidate(candidateId);
      const seeded = projectionId.startsWith(PENDING) ? this.deps.newProjectionId() : projectionId;
      return {
        result: {
          projectionId: seeded,
          section: ref,
          ...none,
          base: {
            locator,
            state: {
              ...note.state,
              localComments: commentBlocks(source, section).map((c) => c.text),
            },
            revision: snap.revision,
          },
        },
        changes: [],
      };
    }
    const sourceLines = splitLines(source);
    const sourceText = sourceLines
      .slice(section.heading.line, section.endLine + 1)
      .map((l) => l.text + l.eol)
      .join("");

    // 0. Typing coalescing (025): the projection's base moves only by a
    //    receipt. The model moved since the base (a collaborator's change):
    //    what waits is committed first, so the remote patch comes after it.
    const port = this.deps.port;
    if (snap.revision !== stored.revision && port.waiting?.(resource, projectionId) !== undefined)
      await port.flush?.(resource, projectionId);
    const waiting = port.waiting?.(resource, projectionId);

    // 1. Operations of this projection a crash or an unwritten pass left
    //    unfinished: their batch is in the base, their new nodes get the
    //    IDs already allocated (matched by content), never new ones.
    let baseState = stored.state;
    /**
     * The revision a resumed batch left its nodes at: their base Text now
     * includes it, so a Text edit planned on it goes against that revision,
     * not the stored one (a coalesced pass the timer committed, 025).
     */
    const resumedRevisions = new Map<string, string>();
    const entries: JournalEntry[] = [];
    const resumed: NewBinding[] = [];
    /**
     * Nodes a resumed batch created that the note no longer shows: the user
     * removed their lines before their bindings were written (a new Task
     * typed, then cut or deleted while its pass was abandoned). Deleted, as
     * a line deleted with its binding is; never shown again from the model.
     */
    const vanished = new Set<string>();
    const used = new Set<number>();
    const unbound0 = markdownState(source, section).unbound;
    for (const e of await this.deps.journal.unfinished()) {
      if (e.projectionId !== projectionId) continue;
      // Waiting in the coalescer: this pass replans it (and replaces it).
      if (e.operationId === waiting) continue;
      const r = await resumeOperation(this.deps, e, sourceText);
      if (r.kind === "re-evaluate") {
        await this.deps.journal.put(advance(e, "abandoned", { reason: "re-evaluated" }));
        continue;
      }
      if (r.kind === "finish") {
        await finish(this.deps, e);
        continue;
      }
      if (r.kind === "save-failed")
        return {
          result: {
            projectionId,
            section: ref,
            local: { kind: "save-failed", entry: r.entry, error: r.error },
            ...none,
          },
          changes: [],
        };
      if (r.kind !== "project") continue;
      for (const id of r.receipt.affectedNodeIds) resumedRevisions.set(id, r.receipt.modelRevision);
      // The line read as the batch's own Task (a made-up ID is not a valid
      // Task ID: it threw, and every later pass with it, 0.4.0-beta.8).
      // A node of the batch the model has deleted since (vanished at an
      // earlier pass, deleted on a peer) is never bound to a line again.
      const live = (r.entry.intents ?? []).filter((i) => {
        const id = createdIdOf(i);
        return id === undefined || snap.nodes[id]?.lifecycle !== "deleted";
      });
      const found = relocate(
        live,
        unbound0,
        used,
        (l, taskId) => {
          const text = sourceLines[l]?.text ?? "";
          try {
            return this.deps.newTask(text, taskId).title;
          } catch {
            return undefined; // not a Task line (any more)
          }
        },
        r.entry.createdLines,
      );
      resumed.push(...found);
      for (const i of r.entry.intents ?? []) {
        const id = createdIdOf(i);
        if (id !== undefined && !found.some((b) => b.id === id)) vanished.add(id);
      }
      // New Tasks: their lines found again; Tasks whose fields the batch sent:
      // their lines as the batch was planned (JournalEntry.taskLines).
      const lineOf = new Map<string, string | undefined>([
        ...found.map((b) => [b.id, sourceLines[b.line]?.text] as const),
        ...Object.entries(r.entry.taskLines ?? {}),
      ]);
      baseState = applyBatch(
        baseState,
        r.entry.intents ?? [],
        ref.sectionId,
        (id) => lineOf.get(id),
        // The restore is committed now: the node's base is the model's, read here.
        (id) => {
          const rn = r.entry.restoredNodes?.[id];
          if (rn === undefined) return undefined;
          if (rn.node.kind === "task") {
            const at = taskLineOf(section, id);
            const line =
              at === undefined
                ? undefined
                : modelTaskLine(source, at, id, (taskId) => this.deps.tasks(resource, taskId));
            return line === undefined ? rn : { ...rn, node: { ...rn.node, line } };
          }
          const text = snap.nodes[id]?.text;
          return text === undefined ? rn : { ...rn, node: { ...rn.node, text } };
        },
      );
      entries.push(r.entry);
    }
    const resumedChanges = bindingChanges(
      source,
      section,
      resumed,
      ref.resourceId,
      this.#placement(),
    ).changes;
    const md0 = applyChanges(source, resumedChanges);
    const section0 = sectionLike(md0, ref, section);
    if (section0 === undefined) return skip("blocked");
    const lines0 = splitLines(md0);
    const lineText0 = (l: number) => lines0[l]?.text ?? "";
    // The source line of each working-copy (md0: the source with the bindings
    // this pass resumes) line: new nodes are recorded by source line.
    const sourceLineOf = new Map<number, number>();
    for (let l = 0; l < sourceLines.length; l++)
      sourceLineOf.set(shiftLine(l, source, resumedChanges), l);
    const note = markdownState(md0, section0);

    // Nodes whose base drifted from the model (drifted()): the model is
    // authoritative for them, their note Text is not, but never Text the user
    // is still typing. A node heals once its note Text is the same as at the
    // last pass: in this pass only (nothing is stored before the pass is
    // written), its base takes that Text at the model's revision, so the pass
    // projects the model's Text into the note; nothing is sent, nothing is
    // deleted on a peer, the refused text stays a kept local copy. Until then
    // its Text edits are held: planned on a base the model never had, they
    // would land at the wrong places (the SDK maps an insert, it cannot check it).
    const marks = driftMarks(stored);
    const healing = new Set<string>();
    const pendingMarks: Record<string, string> = {};
    for (const [id, seen] of Object.entries(marks)) {
      const text = note.state.nodes[id]?.text;
      const n = baseState.nodes[id];
      if (text === undefined || n === undefined) continue;
      if (seen === text) {
        baseState = { ...baseState, nodes: { ...baseState.nodes, [id]: { ...n, text } } };
        healing.add(id);
      } else pendingMarks[id] = text;
    }
    // What the note shows of them and the model does not is kept first, as a
    // local copy (typed after the refusal, it was held and never sent).
    if ([...healing].some((id) => note.state.nodes[id]?.text !== shared.nodes[id]?.text))
      await this.deps.journal.putCandidate({
        candidateId: `drift:${projectionId}:${contentHash(sourceText).slice(0, 16)}`,
        projectionId,
        reason: "rejected",
        sourceText,
      });
    // The Text seen now, for the next pass to compare (marks only, no base).
    if (Object.entries(pendingMarks).some(([id, text]) => marks[id] !== text))
      await this.deps.bases.save(projectionId, {
        ...stored,
        drifted: { ...marks, ...pendingMarks },
      });

    // 2. The user's edits since then, as one batch.
    const plan = planSection(
      baseState,
      note.state,
      shared,
      new Set([...(ctx.cut ?? []), ...ctx.deletedIds, ...(ctx.inserted ?? [])]),
    );
    const reappeared = Object.keys(note.state.nodes).filter(
      (id) => snap.nodes[id]?.lifecycle === "deleted",
    );
    const here = new Set([...(ctx.cut ?? []), ...(ctx.restore ?? []), ...(ctx.inserted ?? [])]);
    const comp = compensate(ctx.origin, plan.missing, reappeared, this.#ledger, here);
    const pasted = comp.restores.filter((id) => here.has(id));
    const removedHere = (id: string) => ctx.deletedIds.has(id) || vanished.has(id);
    const deletes = [...new Set([...comp.deletes, ...comp.lost.filter(removedHere)])];
    const lost = comp.lost.filter((id) => !removedHere(id));
    if (lost.length > 0)
      // NODE_BINDING_LOST (§7, MS18, MS21): the section's publication is
      // suspended until the binding is repaired; the base stays as it was.
      return {
        result: { projectionId, section: ref, lost, held: [], entries },
        changes: resumedChanges,
      };
    const revisionOf = (id: string) => {
      if (id in pendingMarks) return null;
      if (healing.has(id)) return snap.revision;
      // The model's Text is the base's now: an edit planned on it goes against
      // the model as it is. This also heals a base whose stored revision fell
      // behind its Text (0.4.0-beta.5: every edit of the node refused).
      const now = shared.nodes[id]?.text;
      if (now !== undefined && now === baseState.nodes[id]?.text) return snap.revision;
      return (
        resumedRevisions.get(id) ??
        (stored.nodeRevisions?.[id] === undefined ? stored.revision : stored.nodeRevisions[id])
      );
    };
    const held = plan.textEdits.filter((e) => revisionOf(e.nodeId) === null).map((e) => e.nodeId);
    const fields = planTaskFields(
      note.state,
      baseState,
      (taskId) => this.deps.tasks(resource, taskId)?.view,
    );
    const caret = ctx.caretLine === null ? null : shiftLine(ctx.caretLine, source, resumedChanges);
    const transient = transientCandidates(note.unbound, lineText0, caret);
    // §4.5: under the `shared` section comments setting, a comment new since
    // the base becomes a raw node; the ones kept local before stay local.
    const keptLocal = new Set(baseState.localComments ?? []);
    const sharedComments: UnboundNode[] =
      this.deps.sectionComments?.() === "shared"
        ? commentBlocks(md0, section0)
            .filter((c) => !keptLocal.has(c.text))
            .map((c) => ({
              kind: "raw",
              parent: c.parent,
              after: c.after,
              text: c.text,
              line: c.lines.from,
            }))
        : [];
    const creations = [
      ...note.unbound.filter((u) => !transient.has(u.line)),
      ...sharedComments,
    ].sort((a, b) => a.line - b.line);
    // A restored node's base is what the restore brings back, the model's
    // content in the note's place: what the user typed on it since (the
    // pasted Task's title edited before this pass) stays an edit to send,
    // never overwritten by the model's older text (a Task: its line rendered
    // from the model in the note's format).
    const restoredAs = (id: string, n: NodeState): NodeState => {
      if (n.kind === "task") {
        const at = taskLineOf(section0, id);
        const line =
          at === undefined
            ? undefined
            : modelTaskLine(md0, at, id, (taskId) => this.deps.tasks(resource, taskId));
        return line === undefined ? n : { ...n, line };
      }
      const text = snap.nodes[id]?.text;
      return text === undefined ? n : { ...n, text };
    };
    // §6: a placement follows a visible child of its parent. A sibling the
    // note still shows may be deleted in the model by now (a collaborator's
    // deletion, the note's copy kept): the batch would be refused
    // (INVALID_PREDECESSOR) on every pass. Each placement follows the
    // nearest sibling before it that the model shows there, or that this
    // batch places there itself (the peer-structure property test, seed 10).
    // A node the model has under one deleted here, that the note shows
    // elsewhere (a collaborator nested it there after this note's cut): the
    // deletion does not take it along, hidden with nothing to review. It is
    // placed where the note shows it (the peer-structure property test,
    // seeds 406 and 598).
    const freed: SectionPlan["moves"] = Object.entries(note.state.nodes).flatMap(([id, n]) => {
      const m = snap.nodes[id];
      if (m === undefined || m.lifecycle !== "active" || m.parent === null) return [];
      if (!deletes.includes(m.parent) || deletes.includes(id)) return [];
      if (n.parent === UNBOUND_PARENT || n.parent === m.parent) return [];
      if (plan.moves.some((x) => x.nodeId === id)) return [];
      return [{ nodeId: id, parent: n.parent, after: predecessor(note.state, n.parent, id) }];
    });
    const placedHere = new Set([
      ...plan.moves.map((m) => m.nodeId),
      ...freed.map((m) => m.nodeId),
      ...pasted,
      ...comp.restores,
    ]);
    const anchor = (parent: string | null, after: string | null): string | null => {
      if (after === null) return null;
      const shown = (x: string) => {
        const m = snap.nodes[x];
        return (
          placedHere.has(x) ||
          (m !== undefined && m.lifecycle === "active" && m.hidden !== true && m.parent === parent)
        );
      };
      if (shown(after)) return after;
      const siblings = note.state.order[parent ?? ROOT] ?? [];
      for (let i = siblings.indexOf(after) - 1; i >= 0; i--) {
        const x = siblings[i] as string;
        if (shown(x)) return x;
      }
      return null;
    };
    const anchored = <T extends { parent: string | null; after: string | null }>(m: T): T => ({
      ...m,
      after: anchor(m.parent, m.after),
    });
    // §6 again: a parent the model does not show (deleted meanwhile, the
    // note's copy kept and offered as reappeared) takes no placement: it
    // would refuse (INVALID_PARENT) the whole batch on every pass. Such a
    // placement waits until the parent is restored; the rest is sent (the
    // peer-structure property test, seed 54).
    const parentShown = (m: { parent: string | null }) => {
      if (m.parent === null || m.parent === UNBOUND_PARENT || placedHere.has(m.parent)) return true;
      const p = snap.nodes[m.parent];
      return p !== undefined && p.lifecycle === "active" && p.hidden !== true;
    };
    // Checked last, right before the commit: the awaits above may have let
    // the note change. A stale source commits nothing; the pass runs again.
    if (!(await fresh()))
      return {
        result: { projectionId, section: ref, lost: [], held: [], entries, stale: true },
        changes: [],
      };
    const local = await commitPass(this.deps, {
      projectionId,
      resource,
      sectionId: ref.sectionId,
      createdBy: this.deps.createdBy,
      sourceHash: contentHash(source),
      sourceText,
      baseRevision: stored.revision ?? snap.revision,
      textBase: (id) => revisionOf(id) ?? undefined,
      plan: {
        ...plan,
        textEdits: plan.textEdits.filter((e) => !held.includes(e.nodeId)),
        moves: placementOrder(
          [...plan.moves, ...freed, ...restoredMoves(note.state, pasted)]
            .filter(parentShown)
            .map(anchored),
        ),
      },
      deletes,
      restores: comp.restores,
      creations: creations.filter(parentShown).map(anchored),
      newTask: (c, id) => this.deps.newTask(lineText0(c.line), id),
      taskIntents: fields.intents,
      lineOf: lineText0,
      sourceLineOf: (l) => sourceLineOf.get(l),
      taskLines: Object.fromEntries(
        fields.intents.map((i) => [i.id, note.state.nodes[i.id]?.line ?? ""]),
      ),
      restoredNodes: Object.fromEntries(
        comp.restores.flatMap((id) => {
          const n = note.state.nodes[id];
          return n === undefined || n.parent === UNBOUND_PARENT
            ? []
            : [[id, { node: n, after: anchor(n.parent, predecessor(note.state, n.parent, id)) }]];
        }),
      ),
    });
    // A Text edit refused as INVALID_INTENT at once: its base drifted (drifted()).
    if (local.kind === "kept" && local.code === "INVALID_INTENT") {
      const ids = [...new Set(plan.textEdits.map((e) => e.nodeId))];
      if (ids.length > 0) await this.drifted(projectionId, ids);
    }
    // Text kept after a refusal that the note now shows, and this pass synced:
    // it is in the shared state, no longer only on this device.
    // Not in a pass that heals: it replaces the note's Text, it does not sync it.
    if (
      (local.kind === "committed" || local.kind === "nothing") &&
      held.length === 0 &&
      healing.size === 0
    )
      for (const c of await this.deps.journal.candidates(projectionId))
        if (c.reason === "rejected" && c.sourceText === sourceText)
          await this.deps.journal.resolveCandidate(c.candidateId);
    const resumedBase: StoredBase = {
      locator,
      state: baseState,
      ...(stored.revision === undefined ? {} : { revision: stored.revision }),
      ...(stored.nodeRevisions === undefined ? {} : { nodeRevisions: stored.nodeRevisions }),
    };
    if (local.kind !== "nothing" && local.kind !== "committed")
      // Not committed: the edit stays in the note, and nothing is projected over it.
      return {
        result: {
          projectionId,
          section: ref,
          local,
          lost,
          ...(comp.unexplained.length > 0 ? { reappeared: comp.unexplained } : {}),
          held,
          entries,
          ...(entries.length > 0 ? { base: resumedBase } : {}),
        },
        changes: resumedChanges,
      };

    // 3. The bindings of new nodes, and the base this batch leads to.
    let markerChanges: DocChange[] = [];
    let localBase = baseState;
    if (local.kind === "committed") {
      entries.push(local.entry);
      const bindings: NewBinding[] = creations.flatMap((c) => {
        const id = local.ids[c.line];
        return id === undefined ? [] : [{ line: c.line, kind: c.kind, id }];
      });
      for (const b of bindings) this.#ledger.created(b.id);
      for (const id of deletes) this.#ledger.deleted(id);
      for (const id of comp.restores) this.#ledger.restored(id);
      markerChanges = bindingChanges(
        md0,
        section0,
        bindings,
        ref.resourceId,
        this.#placement(),
      ).changes;
      const lineOf = new Map(bindings.map((b) => [b.id, lineText0(b.line)]));
      // A Task whose fields were sent: its line as the note shows it is its base now.
      for (const i of fields.intents) lineOf.set(i.id, note.state.nodes[i.id]?.line ?? "");
      localBase = applyBatch(
        // A restored node's base is what the restore brings back, the model's
        // (a Task: no line yet, so what the user typed on it since stays an edit).
        withModelPlaced(
          withRestored(baseState, note.state, comp.restores, restoredAs),
          comp.restores,
          (id) => note.state.nodes[id],
          // The model after this batch: the nodes it restored are in it.
          this.deps.port.snapshot(resource, ref.sectionId) ?? snap,
          restoredAs,
        ),
        local.entry.intents ?? [],
        ref.sectionId,
        (id) => lineOf.get(id),
      );
    }
    const md1 = applyChanges(md0, markerChanges);
    const ownChanges = composeChanges(resumedChanges, markerChanges) ?? resumedChanges;
    const section1 = sectionLike(md1, ref, section0);

    // 4. Remote changes, from the model as it is after the commit.
    const after = this.deps.port.snapshot(resource, ref.sectionId) ?? snap;
    const remote =
      section1 === undefined
        ? undefined
        : planRemote(md1, section1, localBase, after, (taskId) =>
            this.deps.tasks(resource, taskId),
          );
    const composed = remote?.kind === "patch" ? composeChanges(ownChanges, remote.changes) : null;
    // A remote change over a fresh binding cannot happen (the binding is new
    // to the model too); if it did, the bindings go first and the remote
    // projection waits for the next pass.
    const projected = remote?.kind === "patch" && composed !== null;
    let base = projected && remote?.kind === "patch" ? remote.base : localBase;
    let changes = projected && composed !== null ? composed : ownChanges;

    // 5. Nodes the model created or moved (structure.ts), over the Text patches.
    let structure: StructurePlan | undefined;
    if (projected && remote?.kind === "patch") {
      const md2 = applyChanges(md1, remote.changes);
      const section2 = sectionLike(md2, ref, section0);
      if (section2 !== undefined) {
        structure = planStructure(md2, section2, base, after, {
          resourceId: ref.resourceId,
          task: (taskId) => this.deps.tasks(resource, taskId)?.view?.task,
          placement: this.#placement(),
        });
        const all =
          structure.changes.length === 0 ? null : composeChanges(changes, structure.changes);
        const md3 = all === null ? undefined : applyChanges(md2, structure.changes);
        const section3 = md3 === undefined ? undefined : sectionLike(md3, ref, section0);
        if (all !== null && md3 !== undefined && section3 !== undefined) {
          // The placed nodes as the note now shows them; the order as the note has it.
          const shown = markdownState(md3, section3).state;
          const nodes = { ...base.nodes };
          for (const id of structure.placed) {
            const n = shown.nodes[id];
            if (n !== undefined) nodes[id] = n;
          }
          base = { ...base, nodes, order: shown.order };
          changes = all;
        }
      }
    }
    // 6. MS45: an idle Task line whose inline ref sits after its Tasks fields
    //    gets the canonical form (§4.1); a source rewrite, nothing published.
    const final = applyChanges(source, changes);
    const sectionF = sectionLike(final, ref, section0);
    if (sectionF !== undefined) {
      const linesF = splitLines(final);
      const startsF = lineStarts(linesF);
      const caretText = ctx.caretLine === null ? undefined : sourceLines[ctx.caretLine]?.text;
      const moves: DocChange[] = [];
      const nodes = { ...base.nodes };
      const walk = (ns: readonly SectionNode[]) => {
        for (const n of ns) {
          walk(n.children);
          if (n.kind !== "task" || n.id === null) continue;
          const text = linesF[n.lines.from]?.text ?? "";
          const was = nodes[n.id];
          if (was?.line !== text || text === caretText) continue;
          const canonical = canonicalInline(text);
          if (canonical === null) continue;
          const at = startsF[n.lines.from] ?? 0;
          moves.push({ from: at, to: at + text.length, insert: canonical });
          nodes[n.id] = { ...was, line: canonical };
        }
      };
      walk(sectionF.nodes);
      const all = moves.length === 0 ? null : composeChanges(changes, moves);
      if (all !== null) {
        changes = all;
        base = { ...base, nodes };
      }
    }
    // The note as written, against the model it was projected from: a node
    // the model has elsewhere is a divergence the badge must show, unless its
    // placement waits for the user's edit or a frozen section.
    let diverged: string[] = [];
    if (projected) {
      const written = applyChanges(source, changes);
      const sectionW = sectionLike(written, ref, section0);
      const waiting = new Set(
        (structure?.deferred ?? [])
          .filter((d) => d.reason === "local-edit" || d.reason === "frozen")
          .map((d) => d.nodeId),
      );
      if (sectionW !== undefined)
        diverged = misplaced(markdownState(written, sectionW).state, after, waiting);
    }
    const affected = new Set(local.kind === "committed" ? local.receipt.affectedNodeIds : []);
    const nodeRevisions: Record<string, string | null> = {};
    for (const [id, n] of Object.entries(base.nodes)) {
      const m = after.nodes[id];
      if (n.text === undefined || (m !== undefined && m.text === n.text))
        nodeRevisions[id] = after.revision;
      // Not the model's Text: still the old base's, or unknown after our own
      // merged edit; for a drifted node unknown (its Text was never the model's).
      else nodeRevisions[id] = affected.has(id) || id in marks ? null : (revisionOf(id) ?? null);
    }
    // A drifted node is healed once the note shows the model's Text; the
    // others keep their mark (with the Text seen now).
    const restored = [...healing].filter(
      (id) => base.nodes[id]?.text !== undefined && base.nodes[id]?.text === after.nodes[id]?.text,
    );
    const remaining: Record<string, string | null> = {};
    for (const [id, seen] of Object.entries(marks))
      if (!restored.includes(id) && base.nodes[id] !== undefined)
        remaining[id] = pendingMarks[id] ?? note.state.nodes[id]?.text ?? seen;
    return {
      result: {
        projectionId,
        section: ref,
        local,
        ...(restored.length === 0 ? {} : { restored }),
        ...(remote === undefined ? {} : { remote }),
        lost,
        ...(comp.unexplained.length > 0 ? { reappeared: comp.unexplained } : {}),
        ...(diverged.length > 0 ? { diverged } : {}),
        held,
        entries,
        ...(structure === undefined ? {} : { structure }),
        base: {
          locator,
          state: {
            ...base,
            localComments: localCommentsOf(applyChanges(source, changes), ref, section0),
          },
          revision: after.revision,
          nodeRevisions,
          ...(Object.keys(remaining).length === 0 ? {} : { drifted: remaining }),
        },
      },
      changes,
    };
  }
}

/** A base's drift marks by node (driftMarks of 0.4.0-beta.7's list: no Text seen yet). */
function driftMarks(base: Pick<StoredBase, "drifted"> | undefined): Record<string, string | null> {
  const d = base?.drifted;
  if (d === undefined) return {};
  if (Array.isArray(d)) return Object.fromEntries(d.map((id: string) => [id, null]));
  return { ...(d as Readonly<Record<string, string | null>>) };
}
