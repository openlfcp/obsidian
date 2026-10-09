// sdk-ts's SectionReplica.snapshot() (32b72bf) in the port's terms
// (port.ts). One synchronous read on one revision, as the snapshot rule
// needs; this only renames and regroups it.
//
// - A section the SDK classifies PROFILE_INVALID projects nothing: no
//   snapshot (the engine skips it). IMPORTING is `ready: false`.
// - The root's parent is the section ID in the SDK, null here.
// - `deleted` (the node itself, or a Task node's Task) is the lifecycle that
//   may remove lines from a note; `hidden` (under a deleted ancestor too)
//   only keeps the node out of the visible state.
// - Structural facts (recovery, invalid nodes, collisions, edits retained
//   under a deletion) are the problems that freeze structure. Concurrent
//   field values of Tasks are not: the 0.1 conflict marks show them.
// - A node of a kind this plugin does not know, or without a placement, is
//   left out (it is not projected).

import type { SectionSnapshot as SdkSnapshot } from "@openlfcp/shared-objects/sections";
import { ROOT } from "./base";
import { NODE_KINDS } from "./grammar";
import type { SectionNodeKind } from "./parser";
import type { ModelNode, SectionProblem, SectionSnapshot } from "./port";

const KINDS: readonly string[] = ["task", ...NODE_KINDS];

export function fromSdkSnapshot(s: SdkSnapshot, sectionId: string): SectionSnapshot | undefined {
  if (s.classification === "PROFILE_INVALID") return undefined;
  const parentOf = (p: string) => (p === sectionId ? null : p);
  const nodes: Record<string, ModelNode> = {};
  for (const [id, n] of Object.entries(s.nodes)) {
    if (!KINDS.includes(n.kind) || n.parent === undefined) continue;
    nodes[id] = {
      kind: n.kind as SectionNodeKind,
      parent: parentOf(n.parent),
      lifecycle: n.deleted ? "deleted" : "active",
      ...(n.hidden ? { hidden: true } : {}),
      ...(n.text === undefined ? {} : { text: n.text }),
      ...(n.listStyle === undefined ? {} : { listStyle: n.listStyle }),
    };
  }
  const order: Record<string, string[]> = {};
  for (const e of s.order) {
    if (nodes[e.id] === undefined) continue;
    const key = parentOf(e.parent) ?? ROOT;
    order[key] = [...(order[key] ?? []), e.id];
  }
  const problems: SectionProblem[] = [
    ...s.problems.recovery.map((r) => ({ code: r.code, nodeIds: [r.id] })),
    ...s.problems.invalid.map((r) => ({ code: r.diagnostic, nodeIds: [r.id] })),
    ...s.problems.collisions.map((id) => ({ code: "NODE_ID_COLLISION", nodeIds: [id] })),
    // A field with concurrent values (a Task's title, …): attention, never current (SI07).
    ...s.problems.scalarConflicts.map((c) => ({ code: "SCALAR_CONFLICT", nodeIds: [c.id] })),
    ...s.problems.retainedConcurrentEdits.map((id) => ({
      code: "EDIT_UNDER_DELETED_ANCESTOR",
      nodeIds: [id],
    })),
  ];
  return {
    revision: s.revision,
    title: s.title.value ?? "",
    ready: s.classification !== "IMPORTING",
    nodes,
    order,
    problems,
  };
}
