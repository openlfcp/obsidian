// Recovery of a shared section's conflicts (LFCP-02-061,
// OBSIDIAN-SHARED-SECTIONS-UX-01 §9; SHARED-SECTIONS-PROFILE-01 §7–§9).
// Pure. Every known alternative is shown, nothing is chosen for the user,
// and a choice becomes fresh causal intents. Before a choice is applied the
// model is read again: a choice made on a comparison that changed meanwhile
// is not applied, the new comparison is shown instead. Authors and times are
// not shown: the model does not carry them.
//
// No "server wins" and no "fix all": each item is resolved on its own.

import type { SectionSnapshot, SectionTree } from "@openlfcp/shared-objects/sections";
import type { SectionIntent } from "./port";
import { disagrees } from "./sdk-snapshot";

export type RecoveryItem =
  /**
   * Own offline work a Key Epoch cut off and that could not be re-applied
   * as it was (its node changed meanwhile, or it was refused): send it again,
   * or discard it (stale-work.ts). The host applies it.
   */
  | {
      readonly kind: "stale-work";
      readonly key: string;
      readonly operationId: string;
      readonly label: string;
    }
  /** The section's title has concurrent values. */
  | { readonly kind: "title"; readonly key: string; readonly values: readonly string[] }
  /** A Task field with concurrent values (SOP §44–§47). */
  | {
      readonly kind: "field";
      readonly key: string;
      readonly nodeId: string;
      readonly label: string;
      readonly field: string;
      readonly values: readonly string[];
    }
  /**
   * A node placed in two places at once (§7.2): which place, a parent and
   * the shown sibling it follows (null: first), labelled by that position.
   */
  | {
      readonly kind: "placement";
      readonly key: string;
      readonly nodeId: string;
      readonly label: string;
      readonly choices: readonly {
        readonly parent: string;
        readonly after?: string | null;
        readonly label: string;
      }[];
    }
  /** Nodes whose parents form a cycle (§7.4): which one moves out, to the section's top level. */
  | {
      readonly kind: "cycle";
      readonly key: string;
      readonly members: readonly { readonly nodeId: string; readonly label: string }[];
    }
  /**
   * Deleted and restored concurrently (§7.6, §9): keep it or delete it.
   * Deleted (or restored) twice at once is no conflict: the values agree.
   */
  | {
      readonly kind: "lifecycle";
      readonly key: string;
      readonly nodeId: string;
      readonly label: string;
    }
  /**
   * Deleted in the model, yet shown again in a note (not a paste of this
   * session's cut): restore it where the note shows it, or remove it from
   * the note. The note's, not the model's: the host applies it.
   */
  | {
      readonly kind: "reappeared";
      readonly key: string;
      readonly nodeId: string;
      readonly label: string;
    }
  /**
   * Changed or moved while it or an ancestor was deleted (§9,
   * EDIT_UNDER_DELETED_ANCESTOR): restore the nearest deleted one to see it,
   * or delete again every deleted one on its path (`deleted`, nearest first),
   * after the change, to keep it deleted.
   */
  | {
      readonly kind: "retained";
      readonly key: string;
      readonly nodeId: string;
      readonly label: string;
      readonly ancestor: string;
      readonly ancestorLabel: string;
      readonly deleted: readonly string[];
    };

/** What the model holds, as one read (the same revision for both). */
export interface RecoveryModel {
  readonly sectionId: string;
  readonly tree: Pick<
    SectionTree,
    "recovery" | "candidates" | "scalarConflicts" | "retainedConcurrentEdits"
  >;
  readonly snapshot: Pick<SectionSnapshot, "nodes" | "title"> &
    Partial<Pick<SectionSnapshot, "order">>;
  /** A Task's title as the model holds it, for labels. */
  readonly taskTitle: (taskId: string) => string | undefined;
  /**
   * The section's document as JSON (SectionReplica.toJSON): where in its
   * parent's children each candidate placement is. Without it a placement
   * is named by its parent only.
   */
  readonly document?: () => unknown;
}

/** What of the document's JSON the placements' positions are read from (§3, §4). */
interface DocumentShape {
  readonly section?: { readonly children?: readonly string[] };
  readonly nodes?: Readonly<
    Record<string, { readonly children?: readonly string[]; readonly placement?: string }>
  >;
  readonly placements?: Readonly<Record<string, { readonly node_id?: string }>>;
}

const KIND_WORD: Readonly<Record<string, string>> = {
  task: "Task",
  paragraph: "Paragraph",
  item: "List item",
  raw: "Block",
};

const clip = (text: string) => (text.length > 48 ? `${text.slice(0, 47)}…` : text);

/** A node in words, enough to tell equal titles apart by their place. */
function labelOf(m: RecoveryModel, id: string, withParent = true): string {
  const n = m.snapshot.nodes[id];
  if (n === undefined) return "An item";
  const text = n.kind === "task" ? m.taskTitle(id) : n.text?.split("\n")[0];
  const own = `${KIND_WORD[n.kind] ?? "Item"} "${clip(text ?? "")}"`;
  const parent = n.parent;
  if (!withParent || parent === undefined || parent === m.sectionId) return own;
  const p = m.snapshot.nodes[parent];
  const ptext = p?.kind === "task" ? m.taskTitle(parent) : p?.text?.split("\n")[0];
  return `${own} under "${clip(ptext ?? "")}"`;
}

const parentLabel = (m: RecoveryModel, parent: string) =>
  parent === m.sectionId ? "The section's top level" : `Under ${labelOf(m, parent)}`;

/**
 * Where a candidate placement of `nodeId` is: the nearest shown siblings
 * before and after its entry in its parent's merged children list (§7: the
 * list's order, not IDs or times). Another node's entry counts only when it
 * is that node's selected placement and the node is shown under the parent.
 */
function positionOf(
  m: RecoveryModel,
  doc: DocumentShape,
  nodeId: string,
  c: { readonly placement: string; readonly parent: string },
): { readonly after: string | null; readonly before: string | null } {
  const list =
    (c.parent === m.sectionId ? doc.section?.children : doc.nodes?.[c.parent]?.children) ?? [];
  const shown = new Set(
    (m.snapshot.order ?? []).filter((e) => e.parent === c.parent).map((e) => e.id),
  );
  const sibling = (entry: string | undefined) => {
    const n = entry === undefined ? undefined : doc.placements?.[entry]?.node_id;
    return n !== undefined && n !== nodeId && shown.has(n) && doc.nodes?.[n]?.placement === entry
      ? n
      : undefined;
  };
  const at = list.indexOf(c.placement);
  let after: string | null = null;
  for (let k = at - 1; at >= 0 && k >= 0 && after === null; k--) after = sibling(list[k]) ?? null;
  let before: string | null = null;
  for (let k = at + 1; at >= 0 && k < list.length && before === null; k++)
    before = sibling(list[k]) ?? null;
  return { after, before };
}

/**
 * The candidates of a placement conflict, each named by its position: "First
 * in the section", 'After Task "First task"', under a parent its path. Two
 * that read the same add the sibling they precede, then their order.
 */
function placementChoices(
  m: RecoveryModel,
  nodeId: string,
  candidates: readonly { readonly placement: string; readonly parent: string }[],
): { parent: string; after?: string | null; label: string }[] {
  const doc = m.document?.() as DocumentShape | undefined;
  if (doc === undefined)
    return candidates.map((c) => ({ parent: c.parent, label: parentLabel(m, c.parent) }));
  const name = (id: string) => labelOf(m, id, false);
  const out = candidates.map((c) => {
    const { after, before } = positionOf(m, doc, nodeId, c);
    const top = c.parent === m.sectionId;
    const where =
      after === null
        ? top
          ? "First in the section"
          : `First under ${labelOf(m, c.parent)}`
        : top
          ? `After ${name(after)}`
          : `Under ${labelOf(m, c.parent)}, after ${name(after)}`;
    const end = before === null ? "last" : `before ${name(before)}`;
    return { parent: c.parent, after, where, end };
  });
  const count = (f: (o: (typeof out)[number]) => string, o: (typeof out)[number]) =>
    out.filter((x) => f(x) === f(o)).length;
  return out.map((o, k) => {
    const label =
      count((x) => x.where, o) === 1
        ? o.where
        : count((x) => `${x.where}, ${x.end}`, o) === 1
          ? `${o.where}, ${o.end}`
          : `${o.where}, ${o.end} (${k + 1})`;
    return { parent: o.parent, after: o.after, label };
  });
}

/** The recovery items of a section, in a stable order (by node ID, for presentation only). */
export function recoveryItems(m: RecoveryModel): RecoveryItem[] {
  const out: RecoveryItem[] = [];
  const titles = m.snapshot.title.conflicts;
  if (titles.length > 0)
    out.push({
      kind: "title",
      key: "title",
      values: [...new Set([m.snapshot.title.value ?? "", ...titles])].sort(),
    });
  // Equal values agree (sdk-snapshot.ts): nothing to choose between.
  const scalars = m.tree.scalarConflicts.filter(disagrees);
  for (const c of scalars)
    if (c.field !== "lifecycle")
      out.push({
        kind: "field",
        key: `field:${c.id}:${c.field}`,
        nodeId: c.id,
        label: labelOf(m, c.id),
        field: c.field,
        values: c.values,
      });
  const cycle: { nodeId: string; label: string }[] = [];
  for (const r of m.tree.recovery) {
    if (r.code === "PLACEMENT_CONFLICT")
      out.push({
        kind: "placement",
        key: `placement:${r.id}`,
        nodeId: r.id,
        // Its parent is what is in question: no provisional one in its label.
        label: labelOf(m, r.id, false),
        choices: placementChoices(m, r.id, m.tree.candidates.get(r.id) ?? []),
      });
    else if (r.code === "PARENT_CYCLE") cycle.push({ nodeId: r.id, label: labelOf(m, r.id) });
    else if (r.code === "LIFECYCLE_CONFLICT")
      out.push({
        kind: "lifecycle",
        key: `lifecycle:${r.id}`,
        nodeId: r.id,
        label: labelOf(m, r.id),
      });
  }
  // A lifecycle with different values the tree did not report (§7.6): the same question.
  for (const c of scalars)
    if (c.field === "lifecycle" && !out.some((i) => i.key === `lifecycle:${c.id}`))
      out.push({
        kind: "lifecycle",
        key: `lifecycle:${c.id}`,
        nodeId: c.id,
        label: labelOf(m, c.id),
      });
  if (cycle.length > 0)
    out.push({
      kind: "cycle",
      key: `cycle:${cycle.map((c) => c.nodeId).join(",")}`,
      members: cycle,
    });
  for (const id of m.tree.retainedConcurrentEdits) {
    // The deleted nodes from it up to the section: restoring the nearest
    // shows the retained change; deleting them all again keeps it deleted.
    const deleted: string[] = [];
    const seen = new Set<string>();
    for (
      let at: string | undefined = id;
      at !== undefined && at !== m.sectionId && !seen.has(at);
      at = m.snapshot.nodes[at]?.parent
    ) {
      seen.add(at);
      if (m.snapshot.nodes[at]?.deleted === true) deleted.push(at);
    }
    const ancestor = deleted[0];
    if (ancestor === undefined) continue;
    out.push({
      kind: "retained",
      key: `retained:${id}`,
      nodeId: id,
      label: labelOf(m, id),
      ancestor,
      ancestorLabel: labelOf(m, ancestor),
      deleted,
    });
  }
  return out;
}

/** The items of nodes deleted in the model that notes show again (`ids`, from the passes). */
export function reappearedItems(m: RecoveryModel, ids: Iterable<string>): RecoveryItem[] {
  return [...new Set(ids)]
    .filter((id) => m.snapshot.nodes[id]?.deleted === true)
    .sort()
    .map((id) => ({
      kind: "reappeared",
      key: `reappeared:${id}`,
      nodeId: id,
      label: labelOf(m, id),
    }));
}

/** A choice for an item: a value, a parent, a cycle member, keep/delete, or restore. */
export type RecoveryChoice =
  | { readonly value: string }
  | { readonly parent: string; readonly after?: string | null }
  | { readonly move: string }
  | { readonly keep: boolean }
  | { readonly restore: true };

/** The fresh causal intents of a choice (§8, §9; SOP task.resolve_field_conflict). */
export function resolution(
  item: RecoveryItem,
  choice: RecoveryChoice,
  sectionId: string,
): SectionIntent[] {
  switch (item.kind) {
    case "title":
      if ("value" in choice) return [{ intent: "section.set_title", title: choice.value }];
      break;
    case "field":
      if ("value" in choice)
        return [
          {
            intent: "task.resolve_field_conflict",
            id: item.nodeId,
            field: item.field,
            value: choice.value,
          } as unknown as SectionIntent,
        ];
      break;
    case "placement": {
      // A choice by parent alone takes that parent's first candidate's place.
      const c =
        "parent" in choice
          ? item.choices.find(
              (c) =>
                c.parent === choice.parent &&
                (choice.after === undefined || (c.after ?? null) === choice.after),
            )
          : undefined;
      if (c !== undefined)
        return [
          {
            intent: "node.resolve_placement",
            id: item.nodeId,
            parent: c.parent,
            after: c.after ?? null,
          },
        ];
      break;
    }
    case "cycle":
      if ("move" in choice && item.members.some((m) => m.nodeId === choice.move))
        return [
          {
            intent: "structure.resolve",
            moves: [{ id: choice.move, parent: sectionId, after: null }],
          },
        ];
      break;
    case "lifecycle":
      if ("keep" in choice)
        return [{ intent: choice.keep ? "node.restore" : "node.delete", id: item.nodeId }];
      break;
    case "retained":
      if ("restore" in choice) return [{ intent: "node.restore", id: item.ancestor }];
      // A fresh deletion after the change: the change no longer needs attention (§9).
      if ("keep" in choice && !choice.keep)
        return item.deleted.map((id) => ({ intent: "node.delete", id }));
      break;
    case "reappeared":
      // Restored by the next pass of the note that shows it, where it shows it.
      break;
    case "stale-work":
      // Re-applied or discarded by the host (stale-work.ts).
      break;
  }
  throw new Error(`the choice does not fit this ${item.kind} item`);
}

/**
 * The item as the model shows it now: "same" (apply the choice), "changed"
 * (show the new comparison, apply nothing), or "gone" (resolved meanwhile).
 */
export function revalidate(
  item: RecoveryItem,
  now: readonly RecoveryItem[],
):
  | { readonly kind: "same" }
  | { readonly kind: "changed"; readonly item: RecoveryItem }
  | { readonly kind: "gone" } {
  const current = now.find((x) => x.key === item.key);
  if (current === undefined) return { kind: "gone" };
  return JSON.stringify(current) === JSON.stringify(item)
    ? { kind: "same" }
    : { kind: "changed", item: current };
}

/** What applying a choice needs: the model, write access and the commit (SectionPort). */
export interface RecoveryPort {
  recoveryModel(resource: string, sectionId: string): RecoveryModel | undefined;
  canWrite(resource: string): Promise<{ readonly allowed: boolean }>;
  commit(
    resource: string,
    intents: readonly SectionIntent[],
    options: { readonly operationId: string },
  ): Promise<unknown>;
}

/**
 * Applies a choice after reading access and the model again (UX §9): a
 * changed or resolved item, or no write access, applies nothing. Returns the
 * items as they are then, and what to tell the user.
 */
export async function applyRecovery(
  port: RecoveryPort,
  resource: string,
  sectionId: string,
  item: RecoveryItem,
  choice: RecoveryChoice,
  operationId: string,
): Promise<{
  readonly items: readonly RecoveryItem[];
  readonly note: string;
  readonly applied: boolean;
}> {
  const items = () => {
    const m = port.recoveryModel(resource, sectionId);
    return m === undefined ? [] : recoveryItems(m);
  };
  if (!(await port.canWrite(resource)).allowed)
    return {
      items: items(),
      note: "You can't change this section now: nothing was applied.",
      applied: false,
    };
  const check = revalidate(item, items());
  if (check.kind === "gone")
    return { items: items(), note: "That one was resolved meanwhile.", applied: false };
  if (check.kind === "changed")
    return {
      items: items(),
      note: "Something changed while you were choosing: review it again. Nothing was applied.",
      applied: false,
    };
  try {
    await port.commit(resource, resolution(item, choice, sectionId), { operationId });
  } catch (e) {
    return {
      items: items(),
      note: `It could not be applied (${e instanceof Error ? e.message : String(e)}).`,
      applied: false,
    };
  }
  return { items: items(), note: "Applied.", applied: true };
}
