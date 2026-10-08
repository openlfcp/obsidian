// Remote changes into the note (LFCP-02-040, SDK-SECTIONS-INTEGRATION-01
// §7.6): minimal patches of the spans a section owns, computed against one
// source revision and applied only to that revision. Pure; not wired in.
//
// Three-way, as for edits (base.ts): a node is patched only while the note
// still shows its base, so concurrent local typing is never overwritten;
// the local edit is committed first and the merged value comes back later.
// What this pass projects:
// - the title, a Text (paragraph, item, raw) and a Task line (through the
//   0.1 renderer, so a remote completion touches only the checkbox and its
//   date, MS02, MS12), each as the smallest change inside its own span;
// - a node deleted in the model: its lines (markers, ref and children
//   included) when none of them changed here and no local comment sits
//   among them.
// What it never does: delete a node only because the model's effective
// tree omits it (a conflict or an isolated node keeps its last safe source,
// MS14), touch a node the model reports a problem for, or write a value the
// note cannot hold (a blank line inside a paragraph). Creations and moves
// are left to the structural writer and listed as `unprojected`.

import { contentHash } from "../projection/guard";
import {
  type RenderedProjection,
  type RenderTarget,
  renderProjectedLine,
} from "../projection/render";
import { isBlank, splitLines } from "../refs/lines";
import { scanRefs } from "../refs/scanner";
import { longestCommonSubsequence, markdownState, type NodeState, type SectionState } from "./base";
import type { LineRange, ParsedSection, SectionNode } from "./parser";
import type { SectionSnapshot } from "./port";
import { type DocChange, lineStarts, nodeSource, textEditToDoc } from "./source-map";
import { diffText, scalarToUtf16 } from "./text";

/** Why a node (or the title, `nodeId` null) was left as the note shows it. */
export type DeferReason =
  /** The note differs from the base here: the local edit goes first. */
  | "local-edit"
  /** The model reports a conflict, cycle or isolation for the node. */
  | "problem"
  /** Deleted in the model, but changed here (EDIT_UNDER_DELETED_ANCESTOR is the planner's to send). */
  | "edited-under-deletion"
  /** Deleted in the model, but a local comment sits among its lines. */
  | "private-text"
  /** The model's value cannot be written here as it is (a blank line in a paragraph, a line break in a title). */
  | "unrenderable";

export interface RemotePatch {
  readonly kind: "patch";
  /** The source revision the changes were computed for (SHA-256 of the note). */
  readonly sourceRevision: string;
  /** The snapshot's revision: the projection's base revision once applied. */
  readonly modelRevision: string;
  /** Note changes in UTF-16 offsets, ascending, not overlapping. */
  readonly changes: readonly DocChange[];
  /** The projection's base once the changes are written. */
  readonly base: SectionState;
  readonly deferred: readonly { readonly nodeId: string | null; readonly reason: DeferReason }[];
  /** The model has problems: nothing structural (no deletion) is projected. */
  readonly frozen: boolean;
  /** Model nodes created or moved elsewhere, left for the structural writer. */
  readonly unprojected: readonly string[];
  /** Task render reports that carry issues (OBJECT_UNKNOWN, TAG_NOT_RENDERABLE, …). */
  readonly reports: readonly RenderedProjection[];
}

export type RemotePlan =
  | RemotePatch
  | {
      readonly kind: "skip";
      /** importing: no `ready` (§4.3); no-base: rebuild first (MS11); blocked: the parser paused the section. */
      readonly reason: "importing" | "no-base" | "blocked";
    };

const HEADING = /^( {0,3}#{1,6})(?:([ \t]+)(.*?))?((?:[ \t]+#+)?[ \t]*)$/;

/** The smallest change turning `before` into `after`, both on one line starting at `at`. */
function spanChange(at: number, before: string, after: string): DocChange | null {
  const edit = diffText(before, after);
  if (edit === null) return null;
  return {
    from: at + scalarToUtf16(before, edit.index),
    to: at + scalarToUtf16(before, edit.index + edit.deleteCount),
    insert: edit.insert,
  };
}

/** Whether `text` can stand in the note as the Text of a `kind` node without changing its structure. */
function renderable(kind: SectionNode["kind"], text: string): boolean {
  if (kind === "raw") return true;
  return !text.split("\n").some((l, i) => i > 0 && isBlank(l));
}

/** Every line of a node and its descendants. */
function subtreeLines(n: SectionNode): LineRange {
  let to = n.lines.to;
  for (const c of n.children) to = Math.max(to, subtreeLines(c).to);
  return { from: n.lines.from, to };
}

function* subtree(n: SectionNode): Generator<SectionNode> {
  yield n;
  for (const c of n.children) yield* subtree(c);
}

/**
 * The patch that projects `model` onto the note's section, against the
 * projection's `base`. `tasks` gives the render target of a Task ID.
 */
export function planRemote(
  markdown: string,
  section: ParsedSection,
  base: SectionState | undefined,
  model: SectionSnapshot,
  tasks: (taskId: string) => RenderTarget | undefined,
): RemotePlan {
  if (!model.ready) return { kind: "skip", reason: "importing" };
  if (base === undefined) return { kind: "skip", reason: "no-base" };
  if (section.blocked) return { kind: "skip", reason: "blocked" };

  const note = markdownState(markdown, section).state;
  const lines = splitLines(markdown);
  const starts = lineStarts(lines);
  const scan = scanRefs(markdown);
  const refAt = new Map(scan.projections.map((p) => [p.taskLine, p]));
  const problem = new Set(model.problems.flatMap((p) => p.nodeIds));
  const frozen = model.problems.length > 0;

  const changes: DocChange[] = [];
  const deferred: { nodeId: string | null; reason: DeferReason }[] = [];
  const reports: RenderedProjection[] = [];
  const next: Record<string, NodeState> = { ...base.nodes };
  const gone = new Set<string>();
  let title = base.title;

  // The title, inside the heading line.
  if (model.title !== base.title) {
    if (note.title === model.title) title = model.title;
    else if (note.title !== base.title) deferred.push({ nodeId: null, reason: "local-edit" });
    else {
      const line = lines[section.heading.line]?.text ?? "";
      const m = HEADING.exec(line);
      if (m === null || model.title.includes("\n") || /[ \t]#+$/.test(model.title))
        deferred.push({ nodeId: null, reason: "unrenderable" });
      else {
        const at = (starts[section.heading.line] ?? 0) + (m[1] as string).length;
        const change =
          m[2] === undefined
            ? model.title === ""
              ? null
              : { from: at, to: at, insert: ` ${model.title}` }
            : spanChange(at + m[2].length, m[3] ?? "", model.title);
        if (change !== null) changes.push(change);
        title = model.title;
      }
    }
  }

  const unchanged = (n: SectionNode): boolean => {
    for (const d of subtree(n)) {
      if (d.id === null) return false; // new local content
      const now = note.nodes[d.id];
      const was = base.nodes[d.id];
      if (now === undefined || was === undefined) return false;
      if (now.text !== was.text || now.line !== was.line) return false;
    }
    return true;
  };

  const deleteLines = (n: SectionNode): DocChange | null => {
    const range = subtreeLines(n);
    if (section.localBlocks.some((b) => b.from <= range.to && b.to >= range.from)) return null;
    // The blank line after the node goes with it: the separator before it stays.
    const to = range.to + (isBlank(lines[range.to + 1]?.text ?? "x") ? 1 : 0);
    return { from: starts[range.from] ?? 0, to: starts[to + 1] ?? markdown.length, insert: "" };
  };

  const visit = (n: SectionNode): void => {
    const id = n.id;
    const m = id === null ? undefined : model.nodes[id];
    const was = id === null ? undefined : base.nodes[id];
    const now = id === null ? undefined : note.nodes[id];
    if (id === null || m === undefined || was === undefined || now === undefined) {
      n.children.forEach(visit);
      return;
    }
    if (problem.has(id)) {
      deferred.push({ nodeId: id, reason: "problem" });
      n.children.forEach(visit);
      return;
    }
    if (m.lifecycle === "deleted") {
      if (frozen) deferred.push({ nodeId: id, reason: "problem" });
      else if (!unchanged(n)) deferred.push({ nodeId: id, reason: "edited-under-deletion" });
      else {
        const change = deleteLines(n);
        if (change === null) deferred.push({ nodeId: id, reason: "private-text" });
        else {
          changes.push(change);
          for (const d of subtree(n)) if (d.id !== null) gone.add(d.id);
          return;
        }
      }
      n.children.forEach(visit);
      return;
    }
    if (m.kind !== now.kind) {
      // NODE_KIND_MISMATCH: never edited (base.ts).
      n.children.forEach(visit);
      return;
    }
    if (n.kind === "task") visitTask(n, id, was, now);
    else if (m.text !== undefined && now.text !== undefined && m.text !== now.text) {
      if (now.text !== was.text) deferred.push({ nodeId: id, reason: "local-edit" });
      else if (!renderable(n.kind, m.text)) deferred.push({ nodeId: id, reason: "unrenderable" });
      else {
        const src = nodeSource(markdown, n);
        const edit = diffText(now.text, m.text);
        if (src !== null && edit !== null) changes.push(textEditToDoc(src, edit));
        next[id] = { ...was, text: m.text };
      }
    } else if (m.text !== undefined && m.text === now.text) next[id] = { ...was, text: m.text };
    n.children.forEach(visit);
  };

  const visitTask = (n: SectionNode, id: string, was: NodeState, now: NodeState): void => {
    const p = refAt.get(n.lines.from);
    const target = tasks(id);
    const text = lines[n.lines.from]?.text ?? "";
    if (p === undefined || p.objectId !== id || target === undefined) return;
    const r = renderProjectedLine(text, p, scan.tasks, target);
    if (r === null) {
      deferred.push({ nodeId: id, reason: "unrenderable" });
      return;
    }
    if (r.projection.issues.length > 0) reports.push(r.projection);
    if (r.line === text) next[id] = { ...was, line: text };
    else if (now.line !== was.line) deferred.push({ nodeId: id, reason: "local-edit" });
    else {
      const change = spanChange(starts[n.lines.from] ?? 0, text, r.line);
      if (change !== null) changes.push(change);
      next[id] = { ...was, line: r.line };
    }
  };

  section.nodes.forEach(visit);

  for (const id of gone) delete next[id];
  const order: Record<string, readonly string[]> = {};
  for (const [parent, ids] of Object.entries(base.order))
    if (!gone.has(parent)) order[parent] = ids.filter((i) => !gone.has(i));

  return {
    kind: "patch",
    sourceRevision: contentHash(markdown),
    modelRevision: model.revision,
    changes: changes.sort((a, b) => a.from - b.from),
    base: { title, nodes: next, order },
    deferred,
    frozen,
    unprojected: unprojected(base, note, model),
    reports,
  };
}

/** Active model nodes this note does not show where the model has them: created, or moved. */
export function unprojected(
  base: SectionState,
  note: SectionState,
  model: SectionSnapshot,
): string[] {
  const out = new Set<string>();
  const visible = (id: string) => {
    const m = model.nodes[id];
    return m !== undefined && m.lifecycle === "active" && m.hidden !== true;
  };
  for (const [id, m] of Object.entries(model.nodes)) {
    if (!visible(id)) continue;
    const was = base.nodes[id];
    if (was === undefined) {
      if (note.nodes[id] === undefined) out.add(id);
    } else if (was.parent !== m.parent) out.add(id);
  }
  // Among siblings that stayed under their parent, the longest run that kept
  // its order stays; the others moved (as reduceMoves does for local edits).
  const parents = new Set([...Object.keys(model.order), ...Object.keys(base.order)]);
  for (const key of parents) {
    const stayed = (id: string) =>
      visible(id) &&
      base.nodes[id] !== undefined &&
      base.nodes[id]?.parent === model.nodes[id]?.parent;
    const now = (model.order[key] ?? []).filter(stayed);
    const was = (base.order[key] ?? []).filter((id) => now.includes(id));
    const keep = new Set(longestCommonSubsequence(was, now));
    for (const id of now) if (!keep.has(id)) out.add(id);
  }
  return [...out].sort();
}

/**
 * The note with the patch applied, or null (stale) when the note is no longer
 * the revision the patch was computed for: the caller plans again from the
 * current note (§7.6), never shifts the old offsets.
 */
export function applyRemote(markdown: string, patch: RemotePatch): string | null {
  if (contentHash(markdown) !== patch.sourceRevision) return null;
  let out = markdown;
  for (const c of [...patch.changes].reverse())
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}
