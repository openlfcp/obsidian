// Repairing a note's shared sections (LFCP-02-062, UX §9): broken
// boundaries, bindings that cannot be matched, unsupported content, and a
// projection whose base is lost. Pure.
//
// A broken boundary is never widened by itself: the repair offers the exact
// lines a missing marker could go after, and the user picks one. A lost base
// is compared, never overwritten by default. Only lines of the section
// itself appear in a repair: private text around it is never shown or used.

import { splitLines } from "../refs/lines";
import { formatBoundary, parseBoundary, type SectionRef } from "./grammar";
import { parseSections, type SectionDiagnostic } from "./parser";
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
  FOREIGN_RESOURCE_REF: "This task belongs to another collaboration: move it out of the section.",
};

const ATX = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

/** The repair items of a note. */
export function repairItems(markdown: string): RepairItem[] {
  const lines = splitLines(markdown);
  const scan = parseSections(markdown);
  const out: RepairItem[] = [];
  for (const d of scan.diagnostics) {
    if (d.severity === "info" || d.code === "SECTION_PRIVATE_TAIL") continue;
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
  return out;
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
