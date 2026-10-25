// Repairing a note's shared sections (LFCP-02-062, UX §9): broken
// boundaries, bindings that cannot be matched, unsupported content, and a
// projection whose base is lost. Pure.
//
// A broken boundary is never widened by itself: the repair offers the exact
// lines a missing marker could go after, and the user picks one. A lost base
// is compared, never overwritten by default. Only lines of the section
// itself appear in a repair: private text around it is never shown or used.

import { splitLines } from "../refs/lines";
import type { StoredBase } from "./base";
import { sectionKey } from "./context";
import { sharedState } from "./engine";
import {
  formatBoundary,
  parseBoundary,
  parseSectionRef,
  type SectionRef,
  sameSection,
} from "./grammar";
import { type ParsedSection, parseSections, type SectionDiagnostic } from "./parser";
import type { SectionSnapshot } from "./port";
import { type DocChange, lineStarts } from "./source-map";

export type RepairItem =
  /** A start marker without its end: where the section ends is the user's choice. */
  | {
      readonly kind: "missing-end";
      readonly line: number;
      readonly ref: SectionRef;
      /** Lines after which the end marker may go (block boundaries before the next heading). */
      readonly candidates: readonly { readonly afterLine: number; readonly preview: string }[];
    }
  /** An end marker without its start: which heading the section starts under. */
  | {
      readonly kind: "missing-start";
      readonly line: number;
      readonly ref: SectionRef;
      readonly candidates: readonly { readonly headingLine: number; readonly preview: string }[];
    }
  /**
   * A start or end marker with a few characters changed, of a section this
   * device holds, and one candidate only: rewriting that line restores it.
   */
  | {
      readonly kind: "restore";
      readonly line: number;
      readonly boundary: "start" | "end";
      readonly ref: SectionRef;
      /** The line as the note has it now, and as it is restored. */
      readonly original: string;
      readonly text: string;
      /** The title of the heading above the line, or null. */
      readonly title: string | null;
    }
  /** Something to locate and edit by hand: what, where. */
  | { readonly kind: "locate"; readonly line: number; readonly message: string };

const MESSAGES: Partial<Record<SectionDiagnostic["code"], string>> = {
  SECTION_BOUNDARY_MISMATCH:
    "Section boundary needs repair: this end marker names another section. Your text is kept locally.",
  SECTION_BOUNDARY_OVERLAP:
    "Section boundary needs repair: a section starts inside another one. Your text is kept locally.",
  SECTION_HEADING_INVALID:
    "Section boundary needs repair: the start marker must be right under the section's heading.",
  SECTION_MARKER_MALFORMED: "This line looks like a section marker but cannot be read.",
  SECTION_UNSUPPORTED_SYNTAX:
    "This content cannot be shared by this version yet: edit it, or end the section before it.",
  NODE_MARKER_MALFORMED:
    "Cannot safely match this text to its shared item: its marker cannot be read.",
  NODE_BINDING_ORPHAN:
    "Cannot safely match this text to its shared item: the marker has nothing under it.",
  NODE_BINDING_LOST: "Cannot safely match this text to its shared item: the task's line is gone.",
  NODE_KIND_MISMATCH: "Cannot safely match this text to its shared item: its kind changed.",
  NODE_BINDING_DUPLICATE: "Cannot safely match this text to its shared item: it appears twice.",
  // Its ref names another shared section or a 0.1 shared task: neutral, as either reads it.
  FOREIGN_RESOURCE_REF: "This task is shared elsewhere: move it out of the section.",
};

const ATX = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

/** How many characters a marker may differ by and still be restored: more is not a typo. */
export const RESTORE_DISTANCE = 2;

/** The edit distance of `a` and `b`, or `max + 1` once it is certainly more than `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      row.push(v);
      if (v < least) least = v;
    }
    if (least > max) return max + 1;
    prev = row;
  }
  return Math.min(prev[b.length] as number, max + 1);
}

/** The section ref of a held section key (`<resource base64url>#<section id>`), or undefined. */
function heldRef(key: string): SectionRef | undefined {
  const at = key.indexOf("#");
  if (at < 0) return undefined;
  return parseSectionRef(`lfcp1:${key.slice(0, at)}#section:${key.slice(at + 1)}`);
}

const SLASH = /^[ \t]*<!--\s*\//;
const headingTitle = (s: string) =>
  s
    .replace(/^ {0,3}#{1,6}[ \t]*/, "")
    .replace(/[ \t]#+[ \t]*$/, "")
    .trim();

/** The title of the nearest heading at or above `line`, or null. */
function titleAbove(lines: readonly { readonly text: string }[], line: number): string | null {
  for (let l = line; l >= 0; l--) {
    const text = lines[l]?.text ?? "";
    if (ATX.test(text)) return headingTitle(text);
  }
  return null;
}

/**
 * A malformed boundary line's restore: the one held section whose start or
 * end marker is within RESTORE_DISTANCE of the line. Two candidates, or
 * none, is no restore: the existing repair stays the way.
 */
function restoreOf(
  lines: readonly { readonly text: string }[],
  line: number,
  held: readonly SectionRef[],
): Extract<RepairItem, { kind: "restore" }> | null {
  const original = lines[line]?.text ?? "";
  const boundary = SLASH.test(original) ? "end" : "start";
  const near = held
    .map((ref) => ({ ref, text: formatBoundary(boundary, ref) }))
    .filter((c) => editDistance(original.trim(), c.text, RESTORE_DISTANCE) <= RESTORE_DISTANCE);
  const only = near[0];
  if (near.length !== 1 || only === undefined) return null;
  return {
    kind: "restore",
    line,
    boundary,
    ref: only.ref,
    original,
    text: only.text,
    title: titleAbove(lines, boundary === "start" ? line - 1 : line),
  };
}

/**
 * The repair items of a note. `held` are the keys of the sections this
 * device holds (`<resource base64url>#<section id>`): a damaged marker of
 * one of them is a restore. One cause is one item: a start or end marker
 * left without its mate by a damaged one is not listed beside it.
 */
export function repairItems(markdown: string, held: readonly string[] = []): RepairItem[] {
  const lines = splitLines(markdown);
  const scan = parseSections(markdown);
  const refs = held.flatMap((k) => heldRef(k) ?? []);
  const out: RepairItem[] = [];
  /** A damaged marker line and, when known, the section it belongs to. */
  const damagedMarkers: { line: number; ref: SectionRef | null }[] = [];
  for (const d of scan.diagnostics) {
    if (d.severity === "info" || d.code === "SECTION_PRIVATE_TAIL") continue;
    if (d.code === "SECTION_MARKER_MALFORMED") {
      const restore = restoreOf(lines, d.line, refs);
      if (restore !== null) {
        out.push(restore);
        damagedMarkers.push({ line: d.line, ref: restore.ref });
        continue;
      }
      damagedMarkers.push({ line: d.line, ref: null });
    }
    if (d.code === "SECTION_BOUNDARY_MISSING") {
      const marker = parseBoundary(lines[d.line]?.text ?? "");
      if (marker === null || marker.kind === "malformed") continue;
      if (marker.kind === "start") {
        // The section's heading: the line above the start marker.
        const level = ATX.exec(lines[d.line - 1]?.text ?? "")?.[1]?.length ?? 6;
        const candidates: { afterLine: number; preview: string }[] = [];
        for (let l = d.line + 1; l < lines.length; l++) {
          const h = ATX.exec(lines[l]?.text ?? "");
          if (h !== null && (h[1]?.length ?? 7) <= level) break;
          const next = lines[l + 1];
          const atBoundary =
            (lines[l]?.text.trim() ?? "") !== "" &&
            (next === undefined || next.text.trim() === "" || ATX.test(next.text));
          if (atBoundary) candidates.push({ afterLine: l, preview: clip(lines[l]?.text ?? "") });
        }
        out.push({ kind: "missing-end", line: d.line, ref: marker.ref, candidates });
      } else {
        const candidates: { headingLine: number; preview: string }[] = [];
        for (let l = d.line - 1; l >= 0; l--) {
          if (ATX.test(lines[l]?.text ?? "")) {
            candidates.push({ headingLine: l, preview: clip(lines[l]?.text ?? "") });
            // Only up to the nearest heading's own level and above.
            if ((ATX.exec(lines[l]?.text ?? "")?.[1]?.length ?? 1) <= 1) break;
          }
        }
        out.push({ kind: "missing-start", line: d.line, ref: marker.ref, candidates });
      }
      continue;
    }
    const message = MESSAGES[d.code];
    if (message !== undefined) out.push({ kind: "locate", line: d.line, message });
  }
  return out.filter((item) => {
    if (item.kind !== "missing-start" && item.kind !== "missing-end") return true;
    // A damaged marker of this section sits where its mate is missing: it is the cause.
    return !damagedMarkers.some((m) => {
      const inGap = item.kind === "missing-start" ? m.line < item.line : m.line > item.line;
      if (!inGap) return false;
      if (m.ref !== null) return sameSection(m.ref, item.ref);
      // Not a held section: the orphan marker's own spelling says it is the same one.
      const orphan = formatBoundary(item.kind === "missing-start" ? "start" : "end", item.ref);
      const text = (lines[m.line]?.text ?? "").trim();
      const same = SLASH.test(text) === (item.kind === "missing-end");
      return same && editDistance(text, orphan, RESTORE_DISTANCE) <= RESTORE_DISTANCE;
    });
  });
}

/** What a restorable marker says to the user: what changed, and that edits wait. */
export function restoreText(item: Extract<RepairItem, { kind: "restore" }>): string {
  const name = item.title === null ? "a shared section" : `"${item.title}"`;
  return `The ${item.boundary} line of ${name} was changed. Edits to ${name} are not being sent until this is fixed.`;
}

/** The note change that restores a marker line: that line only. */
export function restoreChange(
  markdown: string,
  item: Extract<RepairItem, { kind: "restore" }>,
): DocChange {
  const lines = splitLines(markdown);
  const l = lines[item.line];
  if (l === undefined || l.text !== item.original) throw new Error("the line changed");
  const from = lineStarts(lines)[item.line] ?? markdown.length;
  return { from, to: from + l.text.length, insert: item.text };
}

/** A repair item of a note with its line key (LFCP-03-018). */
export interface KeyedRepair {
  readonly key: string;
  readonly item: RepairItem;
}

/**
 * Each repair item of `markdown` with its line key (LFCP-03-018, UX §7):
 * for a boundary, its kind and section; for a problem to locate, its
 * message and the text of its line. A line number does not survive an edit
 * above it, the key does: a surface keeps the key with the note's revision,
 * and before acting the note is parsed again and the item found by its key
 * (findRepair), never by the old line number alone.
 */
export function keyedRepairs(markdown: string, held: readonly string[] = []): KeyedRepair[] {
  const lines = splitLines(markdown);
  return repairItems(markdown, held).map((item) => ({
    key:
      item.kind === "locate"
        ? `locate:${item.message}:${(lines[item.line]?.text ?? "").trim()}`
        : item.kind === "restore"
          ? `restore:${item.boundary}:${sectionKey(item.ref)}`
          : `${item.kind}:${sectionKey(item.ref)}`,
    item,
  }));
}

/** The item with line key `key`, the one nearest `line` when several have it; undefined when none is left. */
export function findRepair(
  keyed: readonly KeyedRepair[],
  key: string,
  line: number,
): KeyedRepair | undefined {
  let best: KeyedRepair | undefined;
  for (const k of keyed)
    if (
      k.key === key &&
      (best === undefined || Math.abs(k.item.line - line) < Math.abs(best.item.line - line))
    )
      best = k;
  return best;
}

/** The note change that places the missing marker where the user chose. */
export function boundaryRepair(
  markdown: string,
  item: Extract<RepairItem, { kind: "missing-end" | "missing-start" }>,
  line: number,
): DocChange {
  const lines = splitLines(markdown);
  const starts = lineStarts(lines);
  const eol = lines.find((l) => l.eol !== "")?.eol ?? "\n";
  const after = (n: number, text: string): DocChange => {
    const l = lines[n];
    const end = (starts[n] ?? markdown.length) + (l?.text.length ?? 0);
    return l === undefined || l.eol === ""
      ? { from: end, to: end, insert: `${eol}${text}` }
      : { from: end + l.eol.length, to: end + l.eol.length, insert: `${text}${eol}` };
  };
  if (item.kind === "missing-end") {
    if (!item.candidates.some((c) => c.afterLine === line)) throw new Error("not a candidate line");
    return after(line, formatBoundary("end", item.ref));
  }
  if (!item.candidates.some((c) => c.headingLine === line))
    throw new Error("not a candidate heading");
  return after(line, formatBoundary("start", item.ref));
}

/** One line of a comparison: in both, only in the note, or only in the shared version. */
export interface ComparedLine {
  readonly kind: "same" | "local" | "shared";
  readonly text: string;
}

/**
 * A lost base (MS11): the note's section and the shared version side by
 * side, line by line (longest common subsequence). Nothing is chosen.
 */
export function compare(local: string, shared: string): ComparedLine[] {
  const a = local.replace(/\r\n?/g, "\n").split("\n");
  const b = shared.replace(/\r\n?/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (dp[i] as number[])[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
  const out: ComparedLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number))
      out.push({ kind: "local", text: a[i++] as string });
    else out.push({ kind: "shared", text: b[j++] as string });
  }
  while (i < n) out.push({ kind: "local", text: a[i++] as string });
  while (j < m) out.push({ kind: "shared", text: b[j++] as string });
  return out;
}

/**
 * "Keep my version" of a lost base: the base is the shared state, so the
 * note's differences from it are this vault's edits, sent on the next pass.
 */
export function adoptedBase(
  path: string,
  ref: SectionRef,
  snap: SectionSnapshot,
  /**
   * Per Task, the model's line in the note's format (modelTaskLine): its
   * fields the note shows otherwise are then edits the next pass sends
   * (LFCP-03-043). A Task without one keeps no line and is not planned.
   */
  taskLines: Readonly<Record<string, string>> = {},
): StoredBase {
  const state = sharedState(snap);
  const nodes = { ...state.nodes };
  for (const [id, line] of Object.entries(taskLines)) {
    const n = nodes[id];
    if (n?.kind === "task") nodes[id] = { ...n, line };
  }
  return { locator: { path, section: ref }, state: { ...state, nodes }, revision: snap.revision };
}

/**
 * "Use the shared version" of a lost base: the section's lines between its
 * boundaries become the shared block's (the note's own heading stays). The
 * caller keeps the replaced text as a recovery copy first.
 */
export function sharedVersionChange(
  markdown: string,
  section: ParsedSection,
  block: string,
): DocChange {
  const lines = splitLines(markdown);
  const starts = lineStarts(lines);
  const eol = lines.find((l) => l.eol !== "")?.eol ?? "\n";
  const from = starts[section.startLine] ?? markdown.length;
  const end = lines[section.endLine];
  const to = (starts[section.endLine] ?? markdown.length) + (end?.text.length ?? 0);
  // The block: heading, start marker, …, end marker; without its heading line.
  const body = block
    .replace(/\r?\n$/, "")
    .split("\n")
    .slice(1)
    .join(eol);
  return { from, to, insert: body };
}

/**
 * The base without `ids` (and their descendants): the engine takes a node of
 * the shared version that the base does not know as a collaborator's new one
 * and writes it where the shared version has it (Put back, LFCP-03-057).
 */
export function withoutNodes(base: StoredBase, ids: readonly string[]): StoredBase {
  const gone = new Set(ids);
  // Descendants go with their parent: the note shows none of them either way.
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, n] of Object.entries(base.state.nodes))
      if (!gone.has(id) && n.parent !== null && gone.has(n.parent)) {
        gone.add(id);
        grew = true;
      }
  }
  const nodes = Object.fromEntries(
    Object.entries(base.state.nodes).filter(([id]) => !gone.has(id)),
  );
  const order = Object.fromEntries(
    Object.entries(base.state.order)
      .filter(([parent]) => !gone.has(parent))
      .map(([parent, children]) => [parent, children.filter((id) => !gone.has(id))]),
  );
  const { nodeRevisions, drifted, ...rest } = base;
  return {
    ...rest,
    state: { ...base.state, nodes, order },
    ...(drifted === undefined
      ? {}
      : {
          drifted: Array.isArray(drifted)
            ? drifted.filter((id: string) => !gone.has(id))
            : Object.fromEntries(
                Object.entries(drifted as Readonly<Record<string, string | null>>).filter(
                  ([id]) => !gone.has(id),
                ),
              ),
        }),
    ...(nodeRevisions === undefined
      ? {}
      : {
          nodeRevisions: Object.fromEntries(
            Object.entries(nodeRevisions).filter(([id]) => !gone.has(id)),
          ),
        }),
  };
}
