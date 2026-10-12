// Edits held in a note, not sent (the MVP 0.3 baseline review, F-04): with a
// broken boundary or binding, content a section cannot share (a heading
// inside it), or a copy this vault may not write, a pass sends nothing, yet
// the card said "No local changes waiting." and "Current as last checked".
// Here each projection's pass result says what it holds back: how many
// edits, why, and where (the line to go to). Pure.
//
// An edit is one node of the note that differs from the projection's base
// (what was last reconciled with the model): changed, moved, new or gone;
// a line the section cannot share (a heading inside it) counts as one too.

import { markdownState, type SectionState, UNBOUND_PARENT } from "../sections/base";
import type { SectionResult } from "../sections/engine";
import type { ParsedSection, SectionDiagnostic, SectionScan } from "../sections/parser";

export type HeldCause =
  /** Content the section cannot share: a heading inside it, an unclosed fence. */
  | "unsupported"
  /** A node or Task binding line damaged, duplicated or left without its node. */
  | "binding"
  /** The section's start or end marker is damaged (the whole copy is held). */
  | "boundary"
  /** This vault may read the section, not edit it. */
  | "read-only"
  /** This vault's access was removed. */
  | "revoked"
  /** The server refuses this vault the section. */
  | "refused"
  /** The SDK refused the edit as it was. */
  | "rejected"
  /** No base: the copy has to be compared with the shared version first. */
  | "base-unknown";

export interface HeldEdits {
  /** The note's path and the projection. */
  readonly path: string;
  readonly projectionId: string;
  readonly cause: HeldCause;
  /** Edits not sent; null when they cannot be counted (no base to compare with). */
  readonly count: number | null;
  /** The 0-based line to go to: the cause's, else the first held edit's, else the heading. */
  readonly line: number;
  /** The diagnostic behind the cause, when there is one. */
  readonly code?: string;
  /** Bound nodes whose edits are held (for the editor's row cues). */
  readonly nodeIds: readonly string[];
}

/** The short reason, after "N edits not sent: ". */
export const HELD_CAUSE: Readonly<Record<HeldCause, string>> = {
  unsupported: "the section has content it cannot share",
  binding: "a binding line in the section is damaged",
  boundary: "the section's start or end marker is damaged",
  "read-only": "you can read this section, not edit it",
  revoked: "your access to this section was removed",
  refused: "the sync server refuses this section",
  rejected: "the server refused the change",
  "base-unknown": "this copy has to be compared with the shared version first",
};

/** What to do about it, for the card's problem line. */
export function heldAdvice(h: HeldEdits): string {
  const at = `line ${h.line + 1} of ${h.path}`;
  switch (h.cause) {
    case "unsupported":
      return h.code === "unclosed-fence"
        ? `A code block without its closing fence (${at}) hides the rest of the section. Close the fence; until then nothing in this copy is sent.`
        : `A heading inside the shared section (${at}) cannot be shared. Remove it, or move it below the section's end marker; until then nothing in this copy is sent.`;
    case "binding":
      return `A binding line of the section is damaged (${at}). Undo the edit, or run "Repair shared sections in this note"; until then nothing in this copy is sent.`;
    case "boundary":
      return `One copy of this section has a damaged start or end marker (${at}). Run "Repair shared sections in this note"; until then nothing in this copy is sent.`;
    case "read-only":
      return `You can read this section, not edit it: your edits (from ${at}) stay in this note and are not sent. Ask the owner for write access, or undo them.`;
    case "revoked":
      return `Your access to this section was removed: your edits (from ${at}) stay in this note only.`;
    case "refused":
      return `The sync server refuses this section: your edits (from ${at}) stay in this note only.`;
    case "rejected":
      return `The server refused an edit (from ${at}): it stays in your note, not sent.`;
    case "base-unknown":
      return `This copy (${at}) differs from the shared version and has to be compared with it before it syncs.`;
  }
}

/** Diagnostics that pause a section's projection, most telling first. */
const BLOCKING: readonly { code: string; cause: HeldCause; detail?: string }[] = [
  { code: "SECTION_UNSUPPORTED_SYNTAX", cause: "unsupported", detail: "heading" },
  { code: "SECTION_UNSUPPORTED_SYNTAX", cause: "unsupported", detail: "unclosed-fence" },
  { code: "NODE_BINDING_LOST", cause: "binding" },
  { code: "NODE_MARKER_MALFORMED", cause: "binding" },
  { code: "NODE_BINDING_DUPLICATE", cause: "binding" },
  { code: "NODE_BINDING_ORPHAN", cause: "binding" },
  { code: "FOREIGN_RESOURCE_REF", cause: "binding" },
];

/** The blocking diagnostics of `section`, in BLOCKING's order, then by line. */
export function blockingDiagnostics(
  scan: SectionScan,
  section: ParsedSection,
): { readonly d: SectionDiagnostic; readonly cause: HeldCause }[] {
  const inside = scan.diagnostics.filter(
    (d) => d.line > section.heading.line && d.line <= section.endLine,
  );
  return BLOCKING.flatMap((b) =>
    inside
      .filter((d) => d.code === b.code && (b.detail === undefined || d.detail === b.detail))
      .sort((x, y) => x.line - y.line)
      .map((d) => ({ d, cause: b.cause })),
  );
}

/** The note's edits against `base`: nodes changed, moved, new or gone. */
export function editsAgainst(
  markdown: string,
  section: ParsedSection,
  base: SectionState,
): { readonly count: number; readonly nodeIds: string[]; readonly lines: number[] } {
  const note = markdownState(markdown, section);
  const nodeIds: string[] = [];
  const lineOf = new Map<string, number>();
  const walk = (ns: ParsedSection["nodes"]) => {
    for (const n of ns) {
      if (n.id !== null) lineOf.set(n.id, n.lines.from);
      walk(n.children);
    }
  };
  walk(section.nodes);
  for (const [id, n] of Object.entries(note.state.nodes)) {
    const b = base.nodes[id];
    if (
      b === undefined ||
      b.text !== n.text ||
      (n.line !== undefined && b.line !== n.line) ||
      (n.parent !== UNBOUND_PARENT && b.parent !== n.parent)
    )
      nodeIds.push(id);
  }
  const gone = Object.keys(base.nodes).filter((id) => note.state.nodes[id] === undefined);
  // A node whose binding broke shows as new here and gone there, its content
  // unchanged: the binding is the cause, not an edit of its own.
  const unbound = note.unbound.filter((u) => {
    const at = gone.findIndex((id) => {
      const b = base.nodes[id];
      return b !== undefined && b.kind === u.kind && b.text === u.text;
    });
    if (at < 0) return true;
    gone.splice(at, 1);
    return false;
  });
  const lines = [
    ...nodeIds.map((id) => lineOf.get(id) ?? section.heading.line),
    ...unbound.map((u) => u.line),
  ].sort((a, b) => a - b);
  return { count: nodeIds.length + unbound.length + gone.length, nodeIds, lines };
}

const KEPT: Readonly<Record<string, HeldCause>> = {
  "unsupported-syntax": "unsupported",
  "binding-lost": "binding",
  "base-unknown": "base-unknown",
  "read-only": "read-only",
  "access-revoked": "revoked",
  "access-refused": "refused",
  rejected: "rejected",
};

/**
 * What a pass of `section` in note `path` holds back, or null when it holds
 * nothing. `base`: the projection's stored base, if any.
 */
export function heldEdits(input: {
  readonly path: string;
  readonly markdown: string;
  readonly scan: SectionScan;
  readonly section: ParsedSection;
  readonly result: SectionResult;
  readonly base: SectionState | undefined;
}): HeldEdits | null {
  const { path, markdown, scan, section, result: r, base } = input;
  let cause: HeldCause | null = null;
  let line: number | null = null;
  let code: string | undefined;
  const blocking = blockingDiagnostics(scan, section);
  if (r.skipped === "blocked" || r.lost.length > 0) {
    const first = blocking[0];
    cause = first?.cause ?? "binding";
    line = first?.d.line ?? null;
    code = first === undefined ? undefined : (first.d.detail ?? first.d.code);
  } else if (r.skipped === "base-unknown") cause = "base-unknown";
  else if (r.local?.kind === "kept") cause = KEPT[r.local.candidate.reason] ?? "rejected";
  if (cause === null) return null;
  const edits = base === undefined ? null : editsAgainst(markdown, section, base);
  // A heading inside the section is content too, not sent.
  const unsent = blocking.filter((b) => b.cause === "unsupported").length;
  return {
    path,
    projectionId: r.projectionId,
    cause,
    count: edits === null ? null : edits.count + unsent,
    line: line ?? edits?.lines[0] ?? section.heading.line,
    ...(code === undefined ? {} : { code }),
    nodeIds: edits?.nodeIds ?? [],
  };
}

/** A copy with a damaged boundary (C17): all of it is held, its edits not countable. */
export function damagedHeld(
  path: string,
  projectionId: string,
  line: number,
  code?: string,
): HeldEdits {
  return {
    path,
    projectionId,
    cause: "boundary",
    count: null,
    line,
    ...(code === undefined ? {} : { code }),
    nodeIds: [],
  };
}
