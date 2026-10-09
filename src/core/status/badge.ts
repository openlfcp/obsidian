// What the editor shows of a section's sync status (LFCP-02-058,
// OBSIDIAN-SYNC-INDICATORS-01 §6–§8, decision M8). Pure.
//
// - The double tick (the project mark) means "shared". It stays after the
//   section's heading whatever the sync state: it is not a success check.
// - The sync state has its own small icon beside it, and none when quiet
//   (current, or read-only and current).
// - Rows inside a section are quiet when healthy; a row with pending work
//   or a problem gets a cue, and a folded row carries the cues of what it
//   hides, once.

import { STATE_LABEL, type StatusState, type StatusView } from "./reducer";

/** The sync icons, each a distinct shape (never color alone, §7). */
export type SyncIcon =
  | "loading"
  | "editing"
  | "pending"
  | "receiving"
  | "offline"
  | "unknown"
  | "attention"
  | "error";

export const SYNC_ICON: Readonly<Record<StatusState, SyncIcon | null>> = {
  LOADING: "loading",
  LOCAL_EDIT: "editing",
  LOCAL_DURABLE: "pending",
  SENDING: "pending",
  ACCEPTED_CATCHING_UP: "receiving",
  CURRENT: null,
  OFFLINE: "offline",
  EVIDENCE_UNKNOWN: "unknown",
  ATTENTION: "attention",
  LOCAL_SAVE_FAILED: "error",
  READ_ONLY_CURRENT: null,
};

export interface HeadingBadge {
  readonly state: StatusState;
  /** The sync icon beside the shared mark; null when quiet. */
  readonly icon: SyncIcon | null;
  /** The tooltip (§6). */
  readonly tooltip: string;
  /** The control's accessible name (§8): title, the main fact, the action. */
  readonly accessibleName: string;
}

/** The badge after a section's heading. */
export function headingBadge(title: string, view: StatusView): HeadingBadge {
  const facts: string[] = [];
  if (view.pendingBatches > 0)
    facts.push(
      !view.pendingCounted
        ? "pending changes"
        : `${view.pendingBatches} local ${view.pendingBatches === 1 ? "update" : "updates"} waiting`,
    );
  else if (SYNC_ICON[view.state] !== null) facts.push(STATE_LABEL[view.state].toLowerCase());
  if (view.readOnly) facts.push("read-only");
  return {
    state: view.state,
    icon: SYNC_ICON[view.state],
    tooltip: view.label,
    accessibleName: [`Shared section ${title}`, ...facts, "open details"].join(", "),
  };
}

export type RowCue = "pending" | "attention";

export interface RowNode {
  readonly id: string;
  /** 0-based line the row starts on. */
  readonly line: number;
  readonly children: readonly RowNode[];
}

/**
 * The cue of each line that shows one: a pending or problem row, or the
 * visible line a fold hides it under (`foldedAt` gives it for a hidden
 * line). Attention outranks pending; healthy rows get nothing.
 */
export function rowCues(
  view: StatusView,
  nodes: readonly RowNode[],
  foldedAt: (line: number) => number | null = () => null,
): ReadonlyMap<number, RowCue> {
  const attention = new Set(
    view.conditions.flatMap((c) =>
      c.kind === "structural-conflict" || c.kind === "scalar-conflict" ? c.nodeIds : [],
    ),
  );
  const out = new Map<number, RowCue>();
  const mark = (line: number, cue: RowCue) => {
    const at = foldedAt(line) ?? line;
    if (out.get(at) !== "attention") out.set(at, cue);
  };
  const walk = (ns: readonly RowNode[]) => {
    for (const n of ns) {
      if (attention.has(n.id)) mark(n.line, "attention");
      else if (view.pendingNodeIds.has(n.id)) mark(n.line, "pending");
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
