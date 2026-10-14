// Where a cursor or a selection sits relative to shared sections (task
// LFCP-02-100, workbook mvp-0.2/notes/legacy-commands-in-sections.md): the
// 0.1 commands act only outside sections and refuse inside them, before any
// dialog or write. A damaged boundary counts as inside (fail closed).

import { toBase64url } from "@openlfcp/core";
import type { SectionRef } from "./grammar";
import { type LineRange, parseSections } from "./parser";

/** A section's key: its Resource (base64url) and section ID. */
export const sectionKey = (ref: SectionRef): string =>
  `${toBase64url(ref.resourceId)}#${ref.sectionId}`;

/**
 * The shared section a line is in (heading to end marker): its key and
 * title. A copy with a damaged boundary runs from its heading (or start
 * marker) to the end of the note, as the parser claims it (C17, 064).
 */
export function sectionAtLine(
  text: string,
  line: number,
): { readonly key: string; readonly title: string } | null {
  const scan = parseSections(text);
  const s = scan.sections.find((x) => line >= x.heading.line && line <= x.endLine);
  if (s !== undefined) return { key: sectionKey(s.ref), title: s.heading.title };
  const d = [...scan.damaged].reverse().find((x) => line >= (x.heading?.line ?? x.startLine));
  return d === undefined ? null : { key: sectionKey(d.ref), title: d.heading?.title ?? "" };
}

export type SectionContext = "outside" | "inside" | "crossing" | "damaged";

const overlaps = (a: LineRange, b: LineRange) => a.from <= b.to && b.from <= a.to;
const contains = (outer: LineRange, inner: LineRange) =>
  outer.from <= inner.from && inner.to <= outer.to;

export function sectionContext(markdown: string, range: LineRange): SectionContext {
  if (!markdown.includes("lfcp-section")) return "outside";
  const { sections, claimed } = parseSections(markdown);
  const valid = sections.map((s) => ({ from: s.heading.line, to: s.endLine }));
  // Claimed lines no valid section explains belong to a damaged boundary.
  const damaged = claimed.some(
    (c) =>
      overlaps(c, range) &&
      !valid.some((v) =>
        contains(v, { from: Math.max(c.from, range.from), to: Math.min(c.to, range.to) }),
      ),
  );
  if (damaged) return "damaged";
  const touching = valid.filter((v) => overlaps(v, range));
  if (touching.length === 0) return "outside";
  return touching.length === 1 && contains(touching[0] as LineRange, range) ? "inside" : "crossing";
}
