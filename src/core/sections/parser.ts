// The shared-section parser (MVP 0.2, LFCP-02-034/035): which lines of a
// note belong to which shared section, and the tree of nodes inside each.
// Pure and Obsidian-free: text in, structure and diagnostics out. Not wired
// into the plugin yet (docs/architecture/section-parser.md).
//
// It reuses the 0.1 ref scanner instead of a second Markdown reader:
// lineKinds() says which lines are literal (fences, front matter, comments,
// indented code), so both parsers agree on what is live Markdown, and
// scanRefs() finds the Task refs (both placements, MARKDOWN-REFS-01).
// Indentation is measured in visual columns, tabs to the next multiple of
// four, as the 0.1 scanner does (decision M2: tabs are supported).
//
// Fail closed: a damaged boundary yields no section, only a claimed range
// (so no other engine acts on those lines) and a diagnostic. The parser
// never guesses a wider region.

import { type LineKind, lineKinds, scanRefs } from "../refs";
import { indentWidth, isBlank, type Line, splitLines } from "../refs/lines";
import { parseTaskLine, visualWidth } from "../refs/scanner";
import {
  type MarkedNodeKind,
  parseBoundary,
  parseNodeMarker,
  type SectionRef,
  sameSection,
} from "./grammar";

/** 0-based lines, both ends included. */
export interface LineRange {
  readonly from: number;
  readonly to: number;
}

export type SectionDiagnosticCode =
  /** A start marker without its end, or an end marker without its start. */
  | "SECTION_BOUNDARY_MISSING"
  /** An end marker naming another section than the open one. */
  | "SECTION_BOUNDARY_MISMATCH"
  /** A start marker while another section is open. */
  | "SECTION_BOUNDARY_OVERLAP"
  /** The start marker is not on the line right after an ATX heading (decision M4). */
  | "SECTION_HEADING_INVALID"
  /** Something that looks like a section marker but is not a valid one. */
  | "SECTION_MARKER_MALFORMED"
  /** A heading inside a section (offer to split it), or an unclosed fence (§3, §4.4). */
  | "SECTION_UNSUPPORTED_SYNTAX"
  /** Private text after the end marker, under the section's heading (H5): shown, folded and dragged with it. */
  | "SECTION_PRIVATE_TAIL"
  | "NODE_MARKER_MALFORMED"
  /** A node marker with nothing to bind (no item above, no block below). */
  | "NODE_BINDING_ORPHAN"
  /** A Task ref left without its Task (the line is no Task any more): the binding is lost (§7). */
  | "NODE_BINDING_LOST"
  /** A node marker of another kind than the block it binds (e.g. `raw` before a paragraph). */
  | "NODE_KIND_MISMATCH"
  /** The same node or Task ID twice in one section projection. */
  | "NODE_BINDING_DUPLICATE"
  /** A Task ref inside a section to another Resource. */
  | "FOREIGN_RESOURCE_REF";

export interface SectionDiagnostic {
  readonly code: SectionDiagnosticCode;
  readonly severity: "error" | "warning" | "info";
  /** 0-based line. */
  readonly line: number;
  /** Which unsupported syntax (SECTION_UNSUPPORTED_SYNTAX): each has its own message and effect. */
  readonly detail?: "heading" | "unclosed-fence" | "obsidian-comment" | "html-comment";
}

export type SectionNodeKind = "task" | MarkedNodeKind;

export interface SectionNode {
  readonly kind: SectionNodeKind;
  /** The bound ID (a Task ID for Tasks), or null for new content not bound yet. */
  readonly id: string | null;
  /** Every line the node owns, its markers and ref line included (children excluded). */
  readonly lines: LineRange;
  /** Visual column where the node starts (the list marker, or the text). */
  readonly column: number;
  readonly children: SectionNode[];
}

export interface ParsedSection {
  readonly ref: SectionRef;
  readonly heading: { readonly line: number; readonly level: number; readonly title: string };
  readonly startLine: number;
  readonly endLine: number;
  readonly nodes: SectionNode[];
  /** Non-blank private lines between the end marker and the next heading of the same or a higher level (H5). */
  readonly privateTail: LineRange | null;
  /** Problems inside the region that pause its projection (nested headings, broken bindings). */
  readonly blocked: boolean;
  /**
   * Obsidian comments (`%%`) inside the region (§4.5): kept in place, never
   * extracted or shared; the rest of the section syncs around them.
   */
  readonly localBlocks: LineRange[];
}

export interface SectionScan {
  /** Valid sections, in note order. */
  readonly sections: ParsedSection[];
  /**
   * Every line range that belongs to a section boundary, valid or damaged,
   * markers included. The 0.1 Task engine skips these lines (ADR 0001 §1);
   * a damaged region runs to the end of the note.
   */
  readonly claimed: LineRange[];
  readonly diagnostics: SectionDiagnostic[];
  /**
   * Copies of a section whose boundary is damaged (a start marker without
   * its end, overlapped, mismatched or not under a heading): they yield no
   * section, but each is still that section's copy in this note, with a
   * problem to show (C17).
   */
  readonly damaged: DamagedSection[];
}

export interface DamagedSection {
  readonly ref: SectionRef;
  /** The start marker's line (0-based). */
  readonly startLine: number;
  /** The heading above the start marker, when there is one. */
  readonly heading: { readonly line: number; readonly title: string } | null;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const TABLE = /^[ \t]*\|/;
/** An HTML block that is not a comment (§4.4: raw). */
const HTML_BLOCK = /^[ \t]*<(?!!--)/;
/** An HTML comment that is not an LFCP marker (§4.5: local). */
const HTML_COMMENT = /^[ \t]*<!--(?![ \t]*\/?lfcp-)/;
const OBSIDIAN_COMMENT = /^[ \t]*%%/;
/** A Task ref comment anywhere on a line (MARKDOWN-REFS-01 spelling). */
const TASK_REF = /<!--[ \t]+lfcp-ref:/;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

const ERROR: ReadonlySet<SectionDiagnosticCode> = new Set([
  "SECTION_BOUNDARY_MISSING",
  "SECTION_BOUNDARY_MISMATCH",
  "SECTION_BOUNDARY_OVERLAP",
  "SECTION_HEADING_INVALID",
  "NODE_BINDING_DUPLICATE",
  "FOREIGN_RESOURCE_REF",
]);
const severity = (code: SectionDiagnosticCode): SectionDiagnostic["severity"] =>
  ERROR.has(code) ? "error" : code === "SECTION_PRIVATE_TAIL" ? "info" : "warning";

function heading(
  text: string,
  kind: LineKind | undefined,
): { level: number; title: string } | null {
  if (kind !== "other" && kind !== "task") return null;
  const m = ATX.exec(text);
  return m ? { level: (m[1] as string).length, title: (m[2] ?? "").trim() } : null;
}

/**
 * The note's Task refs as section code reads them: inside a valid section,
 * an inline ref may be followed by a Tasks suffix (§4.1); elsewhere
 * MARKDOWN-REFS-01 applies unchanged.
 */
export function scanSectionRefs(markdown: string): ReturnType<typeof scanRefs> {
  const sections = parseSections(markdown).sections;
  return scanRefs(markdown, {
    tasksSuffix: (l) => sections.some((s) => l > s.startLine && l < s.endLine),
  });
}

/** The shared sections of a note. */
export function parseSections(markdown: string): SectionScan {
  const lines = splitLines(markdown);
  const kinds = lineKinds(lines);
  const diagnostics: SectionDiagnostic[] = [];
  const note: Note = (code, line, detail) =>
    diagnostics.push({
      code,
      // An Obsidian comment stays local; the section is not paused for it.
      severity: detail === "obsidian-comment" ? "warning" : severity(code),
      line,
      ...(detail === undefined ? {} : { detail }),
    });
  const claimed: LineRange[] = [];
  const regions: { ref: SectionRef; start: number; end: number; headingLine: number }[] = [];
  const damaged: DamagedSection[] = [];
  const damage = (o: { ref: SectionRef; start: number }) => {
    const above = o.start > 0 ? heading(lines[o.start - 1]?.text ?? "", kinds[o.start - 1]) : null;
    damaged.push({
      ref: o.ref,
      startLine: o.start,
      heading: above === null ? null : { line: o.start - 1, title: above.title },
    });
  };

  // Pass 1: boundaries. Markers in literal contexts or blockquotes are text.
  /** `reported`: a boundary error is already named for it; the end of the note adds no MISSING. */
  let open: { ref: SectionRef; start: number; damaged: boolean; reported: boolean } | null = null;
  /** End markers still owed by starts reported as OVERLAP: theirs, not new errors. */
  let owed = 0;
  const fail = (from: number) => {
    claimed.push({ from, to: lines.length - 1 });
  };
  lines.forEach(({ text }, i) => {
    if (kinds[i] === "literal" || kinds[i] === "blockquote") return;
    const marker = parseBoundary(text);
    if (marker === null) return;
    if (marker.kind === "malformed") {
      note("SECTION_MARKER_MALFORMED", i);
      return;
    }
    if (marker.kind === "start") {
      if (open !== null) {
        note("SECTION_BOUNDARY_OVERLAP", i);
        open.damaged = true;
        open.reported = true;
        owed++;
        return;
      }
      const above = i > 0 ? heading(lines[i - 1]?.text ?? "", kinds[i - 1]) : null;
      if (above === null) note("SECTION_HEADING_INVALID", i);
      open = { ref: marker.ref, start: i, damaged: above === null, reported: false };
      return;
    }
    // An end marker.
    if (open === null) {
      if (owed > 0) {
        owed--;
        claimed.push({ from: i, to: i });
        return;
      }
      note("SECTION_BOUNDARY_MISSING", i);
      claimed.push({ from: i, to: i });
      return;
    }
    if (!sameSection(open.ref, marker.ref)) {
      note("SECTION_BOUNDARY_MISMATCH", i);
      open.damaged = true;
      open.reported = true;
      return;
    }
    // A damaged region claims its lines (heading included) and yields no section.
    if (open.damaged) {
      claimed.push({ from: Math.max(0, open.start - 1), to: lines.length - 1 });
      damage(open);
    } else {
      claimed.push({ from: open.start - 1, to: i });
      regions.push({ ref: open.ref, start: open.start, end: i, headingLine: open.start - 1 });
    }
    open = null;
  });
  if (open !== null) {
    const o = open as { start: number; reported: boolean };
    if (!o.reported) note("SECTION_BOUNDARY_MISSING", o.start);
    // A fence opened in the region and never closed hid the end marker (§4.4, §9).
    for (let i = o.start + 1; i < lines.length; i++)
      if (
        kinds[i] === "literal" &&
        FENCE_OPEN.test(lines[i]?.text ?? "") &&
        kinds.slice(i).every((k) => k === "literal")
      ) {
        note("SECTION_UNSUPPORTED_SYNTAX", i, "unclosed-fence");
        break;
      }
    fail(Math.max(0, o.start - 1));
    damage(open as { ref: SectionRef; start: number });
  }

  // Pass 2: the nodes of each valid region. Inside one, an inline Task ref
  // may be followed by a Tasks suffix (§4.1).
  const refs = scanRefs(markdown, {
    tasksSuffix: (l) => regions.some((r) => l > r.start && l < r.end),
  });
  const sections = regions.map((r) => {
    const h = heading(lines[r.headingLine]?.text ?? "", kinds[r.headingLine]) as {
      level: number;
      title: string;
    };
    const body = parseBody(lines, kinds, refs, r, note);
    return {
      ref: r.ref,
      heading: { line: r.headingLine, ...h },
      startLine: r.start,
      endLine: r.end,
      nodes: body.nodes,
      privateTail: privateTail(lines, kinds, r.end, h.level),
      blocked: body.blocked,
      localBlocks: body.localBlocks,
    } satisfies ParsedSection;
  });
  for (const s of sections)
    if (s.privateTail !== null) note("SECTION_PRIVATE_TAIL", s.privateTail.from);
  return {
    sections,
    claimed: mergeRanges(claimed),
    diagnostics: diagnostics.sort((a, b) => a.line - b.line),
    damaged,
  };
}

/** H5: private lines that Obsidian treats as part of the section's heading. */
function privateTail(
  lines: readonly Line[],
  kinds: readonly LineKind[],
  end: number,
  level: number,
): LineRange | null {
  let from = -1;
  let to = -1;
  for (let i = end + 1; i < lines.length; i++) {
    const h = heading(lines[i]?.text ?? "", kinds[i]);
    if (h !== null && h.level <= level) break;
    if (isBlank(lines[i]?.text ?? "")) continue;
    if (from < 0) from = i;
    to = i;
  }
  return from < 0 ? null : { from, to };
}

type Note = (
  code: SectionDiagnosticCode,
  line: number,
  detail?: SectionDiagnostic["detail"],
) => void;

interface Open {
  readonly node: SectionNode;
  /** Children start at this column or deeper; -1 for nodes that take none. */
  readonly contentColumn: number;
}

function parseBody(
  lines: readonly Line[],
  kinds: readonly LineKind[],
  refs: ReturnType<typeof scanRefs>,
  r: { ref: SectionRef; start: number; end: number },
  note: Note,
): { nodes: SectionNode[]; blocked: boolean; localBlocks: LineRange[] } {
  const roots: SectionNode[] = [];
  const localBlocks: LineRange[] = [];
  const stack: Open[] = [];
  const seen = new Set<string>();
  let blocked = false;
  const byTaskLine = new Map(refs.projections.map((p) => [p.taskLine, p]));
  const refLines = new Set(
    refs.projections.filter((p) => p.placement === "child").map((p) => p.refLine),
  );
  const text = (i: number) => lines[i]?.text ?? "";

  const place = (node: SectionNode, contentColumn: number) => {
    // Paragraphs and raw blocks take no children; a container takes nodes at its content column or deeper.
    while (stack.length > 0) {
      const top = stack.at(-1) as Open;
      if (top.contentColumn >= 0 && top.contentColumn <= node.column) break;
      stack.pop();
    }
    const parent = stack.at(-1);
    if (parent !== undefined && parent.contentColumn >= 0) parent.node.children.push(node);
    else roots.push(node);
    if (node.id !== null) {
      if (seen.has(node.id)) {
        note("NODE_BINDING_DUPLICATE", node.lines.from);
        blocked = true;
      }
      seen.add(node.id);
    }
    stack.push({ node, contentColumn });
  };
  /** Lines from `i` to the line before the next blank line, node marker or the region's end. */
  const blockEnd = (i: number, keep: (j: number) => boolean) => {
    let j = i;
    while (
      j + 1 < r.end &&
      !isBlank(text(j + 1)) &&
      parseNodeMarker(text(j + 1)) === null &&
      // A Task ref is a binding, never part of a block's text.
      !(kinds[j + 1] !== "literal" && TASK_REF.test(text(j + 1))) &&
      keep(j + 1)
    )
      j++;
    return j;
  };

  /** Whether line `j` continues the paragraph above it (no blank line, no new block). */
  const continues = (j: number) => {
    const u = text(j);
    return (
      kinds[j] === "other" &&
      !isBlank(u) &&
      !refLines.has(j) &&
      !TASK_REF.test(u) &&
      parseNodeMarker(u) === null &&
      !LIST_ITEM.test(u) &&
      heading(u, kinds[j]) === null &&
      !TABLE.test(u) &&
      !HTML_BLOCK.test(u) &&
      !HTML_COMMENT.test(u) &&
      !OBSIDIAN_COMMENT.test(u)
    );
  };

  let pendingId: { kind: MarkedNodeKind; id: string; line: number } | null = null;
  for (let i = r.start + 1; i < r.end; i++) {
    const t = text(i);
    if (refLines.has(i)) continue; // a child-line Task ref, owned by its Task
    if (kinds[i] !== "literal" && TASK_REF.test(t) && parseTaskLine(t, i) === undefined) {
      // A Task ref no Task owns any more (its line was edited into
      // something else, MS17-transient): the Task's binding is lost, the
      // ref is never Text. Publication pauses until it is repaired (§7, MS21).
      note("NODE_BINDING_LOST", i);
      blocked = true;
      continue;
    }
    if (isBlank(t)) {
      if (pendingId?.kind === "paragraph") {
        // §4.3: an empty saved paragraph keeps its marker and identity.
        place(node("paragraph", pendingId.id, pendingId.line, pendingId.line, indentWidth(t)), -1);
        pendingId = null;
      }
      continue;
    }
    const marker = kinds[i] === "literal" ? null : parseNodeMarker(t);
    if (marker !== null) {
      if (marker.kind === "malformed") {
        note("NODE_MARKER_MALFORMED", i);
        blocked = true;
        continue;
      }
      if (marker.kind === "item") {
        // An item's marker follows its item line; a lone one has nothing to bind.
        note("NODE_BINDING_ORPHAN", i);
        blocked = true;
        continue;
      }
      if (pendingId !== null) note("NODE_BINDING_ORPHAN", pendingId.line);
      pendingId = { kind: marker.kind, id: marker.nodeId, line: i };
      continue;
    }
    const lead = pendingId;
    pendingId = null;
    const from = lead?.line ?? i;
    if (kinds[i] !== "literal" && heading(t, kinds[i]) !== null) {
      note("SECTION_UNSUPPORTED_SYNTAX", i, "heading");
      blocked = true;
      continue;
    }
    // A comment, Obsidian's or HTML's (§4.5, spec 2d1a829): not shared,
    // kept where it is. Its lines: the opening line and the literal lines
    // the lexer gives its body (blank ones included).
    const obsidian = OBSIDIAN_COMMENT.test(t);
    if (obsidian || HTML_COMMENT.test(t)) {
      let to = i;
      while (to + 1 < r.end && kinds[to + 1] === "literal") to++;
      if (lead?.kind === "raw") {
        // A comment with a raw marker is a shared raw node, whatever the
        // section comments setting (§4.5, MS41).
        place(node("raw", lead.id, from, to, indentWidth(t)), -1);
        i = to;
        continue;
      }
      localBlocks.push({ from: i, to });
      note("SECTION_UNSUPPORTED_SYNTAX", i, obsidian ? "obsidian-comment" : "html-comment");
      if (lead !== null) note("NODE_KIND_MISMATCH", lead.line);
      i = to;
      continue;
    }
    // Raw blocks (§4.4, M6): fences and other literal runs, tables,
    // blockquotes and callouts, HTML that is not a comment.
    const comment = HTML_BLOCK.test(t);
    if (kinds[i] === "literal" || kinds[i] === "blockquote" || TABLE.test(t) || comment) {
      let to: number;
      if (kinds[i] === "literal") {
        // A fence (closing line included), comment or indented code. An
        // unterminated fence also hides the end marker: the region then
        // never closes (SECTION_BOUNDARY_MISSING), so it cannot get here.
        to = i;
        while (to + 1 < r.end && kinds[to + 1] === "literal") to++;
      } else if (comment) {
        // An HTML block: down to the line before a blank line or a node marker.
        to = blockEnd(i, () => true);
      } else {
        const blockquote = kinds[i] === "blockquote";
        to = blockEnd(i, (j) => (blockquote ? kinds[j] === "blockquote" : kinds[j] !== "literal"));
      }
      place(node("raw", lead?.kind === "raw" ? lead.id : null, from, to, indentWidth(t)), -1);
      if (lead !== null && lead.kind !== "raw") note("NODE_KIND_MISMATCH", lead.line);
      i = to;
      continue;
    }
    const task = parseTaskLine(t, i);
    if (task !== undefined) {
      const p = byTaskLine.get(i);
      // A Task whose ref is blocked (text after an inline ref that is not a
      // Tasks suffix, a duplicate ref, MS44) is neither bound nor new: the
      // section pauses until it is repaired.
      if (refs.tasks.some((s) => s.task.line === i && s.binding === "blocked")) blocked = true;
      if (p !== undefined && !sameBytes(p.resourceId, r.ref.resourceId)) {
        note("FOREIGN_RESOURCE_REF", i);
        blocked = true;
      }
      const to = p?.placement === "child" ? p.refLine : i;
      place(node("task", p?.objectId ?? null, i, to, indentWidth(task.indent)), task.contentColumn);
      if (lead !== null) note("NODE_KIND_MISMATCH", lead.line);
      i = to;
      continue;
    }
    const item = LIST_ITEM.exec(t);
    if (item !== null) {
      const column = indentWidth(item[1] as string);
      const contentColumn = visualWidth(`${item[1]}${item[2]}${item[3] || " "}`);
      // The item's paragraph goes on in continuation lines, lazy ones too
      // (CommonMark; its Text joins them with LF). Its marker follows them.
      let last = i;
      while (last + 1 < r.end && continues(last + 1)) last++;
      const next = last + 1 < r.end ? parseNodeMarker(text(last + 1)) : null;
      // At the item's content column, or up to three columns deeper (a tab
      // can reach past it), as the 0.1 scanner places a child-line ref.
      const width = next === null ? -1 : indentWidth(next.indent);
      const bound = next?.kind === "item" && width >= contentColumn && width < contentColumn + 4;
      place(
        node("item", bound ? next.nodeId : null, i, bound ? last + 1 : last, column),
        contentColumn,
      );
      if (lead !== null) note("NODE_KIND_MISMATCH", lead.line);
      i = bound ? last + 1 : last;
      continue;
    }
    // A paragraph: text lines down to a blank line or the next block.
    const to = blockEnd(
      i,
      (j) =>
        kinds[j] === "other" && !LIST_ITEM.test(text(j)) && heading(text(j), kinds[j]) === null,
    );
    place(
      node("paragraph", lead?.kind === "paragraph" ? lead.id : null, from, to, indentWidth(t)),
      -1,
    );
    if (lead !== null && lead.kind !== "paragraph") note("NODE_KIND_MISMATCH", lead.line);
    i = to;
  }
  if (pendingId !== null) {
    if (pendingId.kind === "paragraph")
      place(node("paragraph", pendingId.id, pendingId.line, pendingId.line, 0), -1);
    else note("NODE_BINDING_ORPHAN", pendingId.line);
  }
  return { nodes: roots, blocked, localBlocks };
}

function node(
  kind: SectionNodeKind,
  id: string | null,
  from: number,
  to: number,
  column: number,
): SectionNode {
  return { kind, id, lines: { from, to }, column, children: [] };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last !== undefined && r.from <= last.to + 1)
      out[out.length - 1] = { from: last.from, to: Math.max(last.to, r.to) };
    else out.push(r);
  }
  return out;
}
