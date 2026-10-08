// The spelling of shared-section markers (MVP 0.2), and nothing else.
//
// Source: spec integration/MARKDOWN-SECTIONS-01.md §2–§4 (Working Draft,
// spec 3a13ba2, LFCP-02-007), with the owner's decisions M1 (Task refs on
// their own child line), M4 (the start marker on the line right after the
// section's heading) and M6 (raw blocks). Until the grammar is frozen, this
// file is the one place to change: everything else in src/core/sections
// asks this module and never matches marker text itself.
//
//   ## Joint launch
//   <!-- lfcp-section: lfcp1:<resource>#section:<uuidv7> -->
//   - [ ] Prepare contract
//     <!-- lfcp-ref: lfcp1:<resource>#task:<uuidv7> -->
//     <!-- lfcp-node: paragraph:<uuidv7> -->
//     Use the updated draft.
//   <!-- /lfcp-section: lfcp1:<resource>#section:<uuidv7> -->

import { decodeResourceId, isObjectId, toBase64Url } from "../refs/tokens";

/** A shared section's identity: its Resource and its section ID. */
export interface SectionRef {
  readonly resourceId: Uint8Array;
  readonly sectionId: string;
}

/** Non-Task node kinds with their own marker (Tasks keep their lfcp-ref). */
export const NODE_KINDS = ["item", "paragraph", "raw"] as const;
export type MarkedNodeKind = (typeof NODE_KINDS)[number];

export type BoundaryMarker =
  | { readonly kind: "start" | "end"; readonly ref: SectionRef }
  /** Looks like a section marker, but is not a valid one: a diagnostic, never a boundary. */
  | { readonly kind: "malformed" };

export type NodeMarker =
  | { readonly kind: MarkedNodeKind; readonly nodeId: string }
  | { readonly kind: "malformed" };

// Whole physical line at column zero; one or more spaces or tabs at each
// separator, trailing whitespace accepted; a serializer writes one space
// (§2, the whitespace rule of MARKDOWN-REFS-01 §6).
const BOUNDARY = /^<!--[ \t]+(\/?)lfcp-section:[ \t]+(\S+)[ \t]+-->[ \t]*$/;
const BOUNDARY_LIKE = /^[ \t]*<!--\s*\/?\s*lfcp-section\b/;
// The only non-whitespace on its line, indented to its parent's content (§4).
const NODE = /^([ \t]*)<!--[ \t]+lfcp-node:[ \t]+([a-z]+):(\S+)[ \t]+-->[ \t]*$/;
const NODE_LIKE = /<!--\s*lfcp-node\b/;

/** `lfcp1:<resource>#section:<uuidv7>`, or undefined. */
export function parseSectionRef(text: string): SectionRef | undefined {
  const m = /^lfcp1:([A-Za-z0-9_-]+)#section:(.+)$/.exec(text);
  if (!m) return undefined;
  const resourceId = decodeResourceId(m[1] as string);
  const sectionId = m[2] as string;
  if (!resourceId || !isObjectId(sectionId)) return undefined;
  return { resourceId, sectionId };
}

export function formatSectionRef(ref: SectionRef): string {
  return `lfcp1:${toBase64Url(ref.resourceId)}#section:${ref.sectionId}`;
}

/** Whether two section refs name the same section. */
export function sameSection(a: SectionRef, b: SectionRef): boolean {
  return (
    a.sectionId === b.sectionId &&
    a.resourceId.length === b.resourceId.length &&
    a.resourceId.every((byte, i) => byte === b.resourceId[i])
  );
}

/** A section boundary on this line, a malformed one, or null for an ordinary line. */
export function parseBoundary(line: string): BoundaryMarker | null {
  const m = BOUNDARY.exec(line);
  if (m) {
    const ref = parseSectionRef(m[2] as string);
    return ref ? { kind: m[1] === "/" ? "end" : "start", ref } : { kind: "malformed" };
  }
  return BOUNDARY_LIKE.test(line) ? { kind: "malformed" } : null;
}

/** A node marker on this line (with its indentation), a malformed one, or null. */
export function parseNodeMarker(line: string): (NodeMarker & { readonly indent: string }) | null {
  const m = NODE.exec(line);
  if (m) {
    const kind = m[2] as string;
    const nodeId = m[3] as string;
    const indent = m[1] as string;
    return (NODE_KINDS as readonly string[]).includes(kind) && isObjectId(nodeId)
      ? { kind: kind as MarkedNodeKind, nodeId, indent }
      : { kind: "malformed", indent };
  }
  return NODE_LIKE.test(line) ? { kind: "malformed", indent: "" } : null;
}

export function formatBoundary(kind: "start" | "end", ref: SectionRef): string {
  return `<!-- ${kind === "end" ? "/" : ""}lfcp-section: ${formatSectionRef(ref)} -->`;
}

export function formatNodeMarker(kind: MarkedNodeKind, nodeId: string, indent = ""): string {
  return `${indent}<!-- lfcp-node: ${kind}:${nodeId} -->`;
}
