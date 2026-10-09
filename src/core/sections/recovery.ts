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

export type RecoveryItem =
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
  /** A node placed in two places at once (§7.2): which parent. */
  | {
      readonly kind: "placement";
      readonly key: string;
      readonly nodeId: string;
      readonly label: string;
      readonly choices: readonly { readonly parent: string; readonly label: string }[];
    }
  /** Nodes whose parents form a cycle (§7.4): which one moves out, to the section's top level. */
  | {
      readonly kind: "cycle";
      readonly key: string;
      readonly members: readonly { readonly nodeId: string; readonly label: string }[];
    }
  /** Deleted and restored concurrently (§7.6, §9): keep it or delete it. */
  | {
      readonly kind: "lifecycle";
      readonly key: string;
      readonly nodeId: string;
      readonly label: string;
    }
  /** Changed while an ancestor was deleted (§9, EDIT_UNDER_DELETED_ANCESTOR): restore the ancestor to see it. */
  | {
      readonly kind: "retained";
      readonly key: string;
      readonly nodeId: string;
      readonly label: string;
      readonly ancestor: string;
      readonly ancestorLabel: string;
    };

/** What the model holds, as one read (the same revision for both). */
export interface RecoveryModel {
  readonly sectionId: string;
  readonly tree: Pick<
    SectionTree,
    "recovery" | "candidates" | "scalarConflicts" | "retainedConcurrentEdits"
  >;
  readonly snapshot: Pick<SectionSnapshot, "nodes" | "title">;
  /** A Task's title as the model holds it, for labels. */
  readonly taskTitle: (taskId: string) => string | undefined;
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
  for (const c of m.tree.scalarConflicts)
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
        choices: (m.tree.candidates.get(r.id) ?? []).map((c) => ({
          parent: c.parent,
          label: parentLabel(m, c.parent),
        })),
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
  if (cycle.length > 0)
    out.push({
      kind: "cycle",
      key: `cycle:${cycle.map((c) => c.nodeId).join(",")}`,
      members: cycle,
    });
  for (const id of m.tree.retainedConcurrentEdits) {
    // The nearest ancestor deleted itself: restoring it shows the retained edit.
    let at = m.snapshot.nodes[id]?.parent;
    let ancestor = m.snapshot.nodes[id]?.deleted === true ? id : undefined;
    while (ancestor === undefined && at !== undefined && at !== m.sectionId) {
      if (m.snapshot.nodes[at]?.deleted === true) ancestor = at;
      at = m.snapshot.nodes[at]?.parent;
    }
    if (ancestor === undefined) continue;
    out.push({
      kind: "retained",
      key: `retained:${id}`,
      nodeId: id,
      label: labelOf(m, id),
      ancestor,
      ancestorLabel: labelOf(m, ancestor),
    });
  }
  return out;
}

/** A choice for an item: a value, a parent, a cycle member, keep/delete, or restore. */
export type RecoveryChoice =
  | { readonly value: string }
  | { readonly parent: string }
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
    case "placement":
      if ("parent" in choice && item.choices.some((c) => c.parent === choice.parent))
        return [
          { intent: "node.resolve_placement", id: item.nodeId, parent: choice.parent, after: null },
        ];
      break;
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
