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
import type { UnboundNode } from "./base";
import {
  commentBlocks,
  markdownState,
  planSection,
  ROOT,
  type SectionBaseStore,
  type SectionState,
  type StoredBase,
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
import { planRemote, type RemotePlan } from "./remote";
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
  | "base-unknown";

export interface SectionResult {
  readonly projectionId: string;
  readonly section: SectionRef;
  readonly skipped?: SectionSkip;
  readonly local?: PassOutcome;
  readonly remote?: RemotePlan;
  /** Missing bound nodes not explained as a deletion: NODE_BINDING_LOST. */
  readonly lost: readonly string[];
  /** Text edits held because the node's base revision is unknown. */
  readonly held: readonly string[];
  /** The base to store once the changes are written. */
  readonly base?: StoredBase;
  /** Committed operations whose bindings these changes write (resumed ones first). */
  readonly entries: readonly JournalEntry[];
  /** Nodes the model created or moved, as written or deferred this pass. */
  readonly structure?: StructurePlan;
}

export interface NotePass {
  readonly path: string;
  readonly source: string;
  /** SHA-256 of the source: the host writes only onto this revision (or maps through its own edits). */
  readonly sourceRevision: string;
  /** Note changes against `source`, ascending, not overlapping. */
  readonly changes: readonly DocChange[];
  readonly sections: readonly SectionResult[];
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
function sameState(a: SectionState, b: SectionState): boolean {
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
    for (const s of at) {
      if (p < s.a) return p - shift;
      if (p === s.a) return s.b === s.a && role === "from" ? s.c.to : s.c.from;
      if (p < s.b) return null;
      if (p === s.b) return s.c.to;
      shift += s.c.insert.length - (s.c.to - s.c.from);
    }
    return p - shift;
  };
  const dropped = new Set<DocChange>();
  const out: { c: DocChange; rank: number }[] = [];
  for (const c of second) {
    const covered = at.filter((s) => s.a >= c.from && s.b <= c.to && c.to > c.from);
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
    });
  }
  for (const c of spans) if (!dropped.has(c)) out.push({ c, rank: c.to === c.from ? 1 : 3 });
  return out.sort((x, y) => x.c.from - y.c.from || x.rank - y.rank).map((x) => x.c);
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
function relocate(
  intents: readonly SectionIntent[],
  unbound: readonly UnboundNode[],
  used: Set<number>,
  titleOf: (line: number) => string,
): NewBinding[] {
  const out: NewBinding[] = [];
  for (const i of intents) {
    const match = (u: UnboundNode) => {
      if (used.has(u.line)) return false;
      if (i.intent === "task.create_in_section")
        return u.kind === "task" && titleOf(u.line) === i.task.title;
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
        const inner = await this.#pass(path, applyChanges(source, repair), ctx);
        const changes = composeChanges(repair, inner.changes);
        if (changes !== null)
          return { ...inner, source, sourceRevision: contentHash(source), changes };
      }
    }
    return this.#pass(path, source, ctx);
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

  async #pass(path: string, source: string, ctx: PassContext): Promise<NotePass> {
    const scan = parseSections(source);
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
      );
      results.push(r.result);
      changes = changes.concat(r.changes);
    }
    return {
      path,
      source,
      sourceRevision: contentHash(source),
      changes: changes.sort((a, b) => a.from - b.from),
      sections: results,
    };
  }

  /** The host wrote the pass's changes: bases are stored and operations finish. */
  async written(pass: NotePass, text: string): Promise<void> {
    const hash = contentHash(text);
    for (const r of pass.sections) {
      if (r.base !== undefined) await this.deps.bases.save(r.projectionId, r.base);
      for (const entry of r.entries) {
        const projected = await markProjected(this.deps, entry, hash);
        await finish(this.deps, projected);
      }
    }
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
  ): Promise<{ result: SectionResult; changes: DocChange[] }> {
    const ref = section.ref;
    const resource = toBase64url(ref.resourceId);
    const none = { lost: [], held: [], entries: [] };
    const skip = (skipped: SectionSkip) => ({
      result: { projectionId, section: ref, skipped, ...none },
      changes: [],
    });
    if (snap === undefined) return skip("no-snapshot");
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
    const entries: JournalEntry[] = [];
    const resumed: NewBinding[] = [];
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
      const found = relocate(r.entry.intents ?? [], unbound0, used, (l) => {
        const text = sourceLines[l]?.text ?? "";
        return this.deps.newTask(text, "relocate").title;
      });
      resumed.push(...found);
      const lineOf = new Map(found.map((b) => [b.id, sourceLines[b.line]?.text]));
      baseState = applyBatch(baseState, r.entry.intents ?? [], ref.sectionId, (id) =>
        lineOf.get(id),
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
    const note = markdownState(md0, section0);

    // 2. The user's edits since then, as one batch.
    const plan = planSection(baseState, note.state, shared);
    const reappeared = Object.keys(note.state.nodes).filter(
      (id) => snap.nodes[id]?.lifecycle === "deleted",
    );
    const comp = compensate(ctx.origin, plan.missing, reappeared, this.#ledger);
    const deletes = [
      ...new Set([...comp.deletes, ...comp.lost.filter((id) => ctx.deletedIds.has(id))]),
    ];
    const lost = comp.lost.filter((id) => !ctx.deletedIds.has(id));
    if (lost.length > 0)
      // NODE_BINDING_LOST (§7, MS18, MS21): the section's publication is
      // suspended until the binding is repaired; the base stays as it was.
      return {
        result: { projectionId, section: ref, lost, held: [], entries },
        changes: resumedChanges,
      };
    const revisionOf = (id: string) =>
      stored.nodeRevisions?.[id] === undefined ? stored.revision : stored.nodeRevisions[id];
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
    const local = await commitPass(this.deps, {
      projectionId,
      resource,
      sectionId: ref.sectionId,
      createdBy: this.deps.createdBy,
      sourceHash: contentHash(source),
      sourceText,
      baseRevision: stored.revision ?? snap.revision,
      textBase: (id) => revisionOf(id) ?? undefined,
      plan: { ...plan, textEdits: plan.textEdits.filter((e) => !held.includes(e.nodeId)) },
      deletes,
      restores: comp.restores,
      creations,
      newTask: (c, id) => this.deps.newTask(lineText0(c.line), id),
      taskIntents: fields.intents,
    });
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
      localBase = applyBatch(baseState, local.entry.intents ?? [], ref.sectionId, (id) =>
        lineOf.get(id),
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
    const affected = new Set(local.kind === "committed" ? local.receipt.affectedNodeIds : []);
    const nodeRevisions: Record<string, string | null> = {};
    for (const [id, n] of Object.entries(base.nodes)) {
      const m = after.nodes[id];
      if (n.text === undefined || (m !== undefined && m.text === n.text))
        nodeRevisions[id] = after.revision;
      // Not the model's Text: still the old base's, or unknown after our own merged edit.
      else nodeRevisions[id] = affected.has(id) ? null : (revisionOf(id) ?? null);
    }
    return {
      result: {
        projectionId,
        section: ref,
        local,
        ...(remote === undefined ? {} : { remote }),
        lost,
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
        },
      },
      changes,
    };
  }
}
