// "Share section…": the exact range and the preflight shown before anything
// is written (LFCP-02-049, OBSIDIAN-SHARED-SECTIONS-UX-01 §3, MARKDOWN-
// SECTIONS-01 §3, §8). Pure: the note in, a preview out; the modal shows it
// and creation (LFCP-02-050) starts only from an unchanged, approved one.
//
// - A heading proposes its content down to the next heading of the same or
//   a higher level, or the end of the note; the user may end it earlier, on
//   a block boundary only. After sharing, only the markers decide scope.
// - The proposed range is parsed as the section it would become (the same
//   parser, around temporary markers), so the preview shows exactly the
//   nodes that would be shared, with every child text.
// - Problems block the share: a heading inside (offer to split, M6), an
//   unclosed fence, a range that cuts a block, bindings already there (a
//   section or node marker), and 0.1 shared Tasks (they are imported as new
//   Tasks by a separate, explicit path, never silently re-shared).
// - Warnings do not block: comments that stay local (§4.5), private text
//   left under the heading after the range (H5), and the sentence that
//   everything inside, future additions included, will be shared.

import { contentHash } from "../projection/guard";
import { isBlank, splitLines } from "../refs/lines";
import { scanRefs } from "../refs/scanner";
import { formatBoundary, type SectionRef } from "./grammar";
import { type ParsedSection, parseSections, type SectionNode } from "./parser";
import { nodeSource } from "./source-map";

/** 0-based lines of the note, both ends included. */
export interface ShareRange {
  readonly headingLine: number;
  /** The last line of the content (the heading line itself when the section is empty). */
  readonly lastLine: number;
}

export type ShareProblem =
  | { readonly code: "NOT_A_HEADING"; readonly line: number }
  /** A heading inside the range (M6): the share offers to split it. */
  | { readonly code: "NESTED_HEADING"; readonly line: number }
  | { readonly code: "UNCLOSED_FENCE"; readonly line: number }
  /** The range's end cuts a block (a paragraph or a list item goes on after it). */
  | { readonly code: "PARTIAL_BLOCK"; readonly line: number }
  /** Section or node markers already in the range: it is (part of) a shared section. */
  | { readonly code: "ALREADY_BOUND"; readonly line: number }
  /** 0.1 shared Tasks: they go through the explicit import path (UX §3). */
  | { readonly code: "LEGACY_SHARED_TASKS"; readonly lines: readonly number[] }
  /** A ref that cannot be read: nothing is shared until it is repaired. */
  | { readonly code: "BROKEN_REF"; readonly line: number };

export type ShareWarning =
  | "future-additions"
  /** Comments in the range stay on this device (section comments setting, §4.5). */
  | "local-comments"
  /** Private text under the same heading after the range (H5: it folds, drags and embeds with it). */
  | "private-text-before-next-heading";

export interface SharePreview {
  readonly range: ShareRange;
  readonly title: string;
  /** The note's revision the preview was made from (SHA-256). */
  readonly sourceRevision: string;
  /** The exact source that would be shared, heading excluded. */
  readonly content: string;
  readonly counts: {
    readonly tasks: number;
    readonly paragraphs: number;
    readonly items: number;
    readonly raw: number;
    readonly characters: number;
  };
  /** How many changes the import takes, from the authoring budgets (SSP §16.2). */
  readonly changes: number;
  readonly problems: readonly ShareProblem[];
  readonly warnings: readonly ShareWarning[];
  /** The text kept outside: the private lines under the heading after the range. */
  readonly privateTail: string | null;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const MARKER = /<!--[ \t]+\/?lfcp-(section|node):/;
/** Throwaway identities for parsing the range as a section (never written). */
const PREVIEW: SectionRef = {
  resourceId: new Uint8Array(32).fill(0xa5),
  sectionId: "00000000-0000-7000-8000-000000000000",
};
export const TEXT_BUDGET = 8192;
export const NODE_BUDGET = 256;

/** The heading's level and title, or null when the line is no ATX heading. */
function heading(text: string): { level: number; title: string } | null {
  const m = ATX.exec(text);
  return m === null ? null : { level: (m[1] as string).length, title: (m[2] ?? "").trim() };
}

/** The range a heading proposes: down to the next heading of the same or a higher level, blank lines trimmed. */
export function proposeRange(markdown: string, headingLine: number): ShareRange | null {
  const lines = splitLines(markdown);
  const h = heading(lines[headingLine]?.text ?? "");
  if (h === null) return null;
  let end = lines.length - 1;
  for (let l = headingLine + 1; l < lines.length; l++) {
    const next = heading(lines[l]?.text ?? "");
    if (next !== null && next.level <= h.level) {
      end = l - 1;
      break;
    }
  }
  while (end > headingLine && isBlank(lines[end]?.text ?? "")) end--;
  return { headingLine, lastLine: end };
}

function* walk(nodes: readonly SectionNode[]): Generator<SectionNode> {
  for (const n of nodes) {
    yield n;
    yield* walk(n.children);
  }
}

/** The preview of sharing `range` of `markdown`: exactly what would be shared, and what blocks it. */
export function preflight(markdown: string, range: ShareRange): SharePreview {
  const lines = splitLines(markdown);
  const h = heading(lines[range.headingLine]?.text ?? "");
  const problems: ShareProblem[] = [];
  const warnings: ShareWarning[] = ["future-additions"];
  const title = h?.title ?? "";
  if (h === null) problems.push({ code: "NOT_A_HEADING", line: range.headingLine });

  const first = range.headingLine + 1;
  const last = range.lastLine;
  for (let l = first; l <= last; l++)
    if (MARKER.test(lines[l]?.text ?? "")) {
      problems.push({ code: "ALREADY_BOUND", line: l });
      break;
    }
  // The range must end on a block boundary: the next line is blank, a heading or the end.
  const after = lines[last + 1]?.text;
  const lastText = lines[last]?.text ?? "";
  if (
    after !== undefined &&
    !isBlank(after) &&
    !isBlank(lastText) &&
    heading(after) === null &&
    last >= first
  )
    problems.push({ code: "PARTIAL_BLOCK", line: last + 1 });

  // The range parsed as the section it would become.
  const eol = lines.find((l) => l.eol !== "")?.eol ?? "\n";
  const body = lines.slice(first, last + 1).map((l) => l.text);
  const head = lines[range.headingLine]?.text ?? "";
  const synthetic = [
    head,
    formatBoundary("start", PREVIEW),
    ...body,
    formatBoundary("end", PREVIEW),
    "",
  ].join("\n");
  const scan = parseSections(synthetic);
  const section: ParsedSection | undefined = scan.sections[0];
  const at = (syntheticLine: number) => syntheticLine - 2 + first;
  for (const d of scan.diagnostics) {
    if (d.code === "SECTION_UNSUPPORTED_SYNTAX" && d.detail === "heading")
      problems.push({ code: "NESTED_HEADING", line: at(d.line) });
    if (d.code === "SECTION_BOUNDARY_MISSING" || d.detail === "unclosed-fence")
      problems.push({ code: "UNCLOSED_FENCE", line: Math.max(first, at(d.line)) });
  }
  if (section === undefined && !problems.some((p) => p.code === "UNCLOSED_FENCE"))
    problems.push({ code: "UNCLOSED_FENCE", line: first });

  // 0.1 refs in the range: shared Tasks of other collaborations, or broken ones.
  const refs = scanRefs(markdown);
  const legacy = refs.projections.filter((p) => p.taskLine >= first && p.taskLine <= last);
  if (legacy.length > 0)
    problems.push({ code: "LEGACY_SHARED_TASKS", lines: legacy.map((p) => p.taskLine) });
  for (const d of refs.diagnostics)
    if (d.line >= first && d.line <= last) {
      problems.push({ code: "BROKEN_REF", line: d.line });
      break;
    }

  const counts = { tasks: 0, paragraphs: 0, items: 0, raw: 0, characters: 0 };
  if (section !== undefined) {
    for (const n of walk(section.nodes)) {
      if (n.kind === "task") counts.tasks++;
      else if (n.kind === "paragraph") counts.paragraphs++;
      else if (n.kind === "item") counts.items++;
      else counts.raw++;
      counts.characters += nodeSource(synthetic, n)?.text.length ?? 0;
    }
    if (section.localBlocks.length > 0) warnings.push("local-comments");
  }
  const nodes = counts.tasks + counts.paragraphs + counts.items + counts.raw;
  const changes = Math.max(
    1,
    Math.ceil(counts.characters / TEXT_BUDGET),
    Math.ceil(nodes / NODE_BUDGET),
  );

  // Private text left under the heading after the range (H5).
  const proposed = proposeRange(markdown, range.headingLine);
  const tail: string[] = [];
  if (proposed !== null)
    for (let l = last + 1; l <= proposed.lastLine; l++) tail.push(lines[l]?.text ?? "");
  const privateTail = tail.some((t) => !isBlank(t)) ? tail.join(eol).trim() : null;
  if (privateTail !== null) warnings.push("private-text-before-next-heading");

  return {
    range,
    title,
    sourceRevision: contentHash(markdown),
    content: body.join(eol),
    counts,
    changes,
    problems,
    warnings,
    privateTail,
  };
}

/** The preview of an already shared section: what is outside it under its heading (MS36, H5). */
export function sectionPreview(section: ParsedSection): readonly ShareWarning[] {
  return section.privateTail === null ? [] : ["private-text-before-next-heading"];
}

/**
 * Whether an approved preview still holds for the note as it is now (UX02):
 * the same revision, or the same heading with exactly the same content. A
 * changed range must be reviewed again before anything is created.
 */
export function revalidate(
  markdown: string,
  preview: SharePreview,
):
  | { readonly kind: "unchanged" | "moved"; readonly preview: SharePreview }
  | { readonly kind: "changed"; readonly preview: SharePreview | null } {
  if (contentHash(markdown) === preview.sourceRevision) return { kind: "unchanged", preview };
  const lines = splitLines(markdown);
  const candidates = lines
    .map((l, i) => (heading(l.text)?.title === preview.title ? i : -1))
    .filter((i) => i >= 0);
  for (const i of candidates) {
    const length = preview.range.lastLine - preview.range.headingLine;
    const again = preflight(markdown, { headingLine: i, lastLine: i + length });
    if (again.content === preview.content && again.problems.length === preview.problems.length)
      return { kind: "moved", preview: again };
  }
  const first = candidates[0];
  const proposed = first === undefined ? null : proposeRange(markdown, first);
  return { kind: "changed", preview: proposed === null ? null : preflight(markdown, proposed) };
}

/** What the share preview says, in the user's words (UX §3); the modal only lays it out. */
export interface ShareMessages {
  readonly heading: string;
  /** The persistent sentence (UX §3). */
  readonly scope: string;
  readonly counts: string;
  /** Blocking: Share is unavailable while any is listed. */
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One blocking problem in the user's words. */
function problemText(x: ShareProblem): string {
  switch (x.code) {
    case "NOT_A_HEADING":
      return "Put the cursor on a heading (or under one): a section starts at a heading.";
    case "NESTED_HEADING":
      return `Line ${x.line + 1} is a heading inside the section. Share each part as its own section, or end the section before it.`;
    case "UNCLOSED_FENCE":
      return `A code block from line ${x.line + 1} is not closed. Close it before sharing.`;
    case "PARTIAL_BLOCK":
      return `The section would end in the middle of a paragraph or list item (line ${x.line + 1}). End it at a blank line.`;
    case "ALREADY_BOUND":
      return `Line ${x.line + 1} is already part of a shared section.`;
    case "LEGACY_SHARED_TASKS":
      return `${plural(x.lines.length, "task is", "tasks are")} already shared in another collaboration. Import creates new shared tasks; existing collaborations continue separately.`;
    case "BROKEN_REF":
      return `The shared task marker on line ${x.line + 1} is damaged. Repair it before sharing.`;
  }
}

export function shareMessages(p: SharePreview): ShareMessages {
  const problems = p.problems.map(problemText);
  const warnings = p.warnings.flatMap((w): string[] => {
    if (w === "local-comments")
      return ["Comments (%% … %% and <!-- … -->) in this section stay on this device."];
    if (w === "private-text-before-next-heading")
      return [
        "The text after the section, under the same heading, stays private, but Obsidian folds, drags and embeds it with the heading.",
      ];
    return [];
  });
  const c = p.counts;
  const parts = [
    plural(c.tasks, "task"),
    plural(c.paragraphs, "paragraph"),
    plural(c.items, "list item"),
    ...(c.raw > 0 ? [plural(c.raw, "other block")] : []),
  ];
  return {
    heading: `Share section "${p.title}"`,
    scope: "Everything inside this section, including future additions, will be shared.",
    counts: `${parts.join(", ")}${p.changes > 1 ? `; sent in ${p.changes} parts` : ""}.`,
    problems,
    warnings,
  };
}
