// Where a cursor or a selection sits relative to shared sections (task
// LFCP-02-100, workbook mvp-0.2/notes/legacy-commands-in-sections.md): the
// 0.1 commands act only outside sections and refuse inside them, before any
// dialog or write. A damaged boundary counts as inside (fail closed).

import { type LineRange, parseSections } from "./parser";

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
