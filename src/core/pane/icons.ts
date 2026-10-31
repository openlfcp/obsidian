// The icon of every action (UXD-11, mock pane-toolbar.html's icon table):
// the header's buttons and the "…" menu's items draw these. Lucide names,
// the set Obsidian ships, so `setIcon` finds each of them. Pure: no Obsidian.

import type { ActionId } from "../actions/catalog";

export const ACTION_ICONS: Readonly<Record<ActionId, string>> = {
  "share-section": "share-2",
  "share-whole-section": "layers",
  invite: "user-plus",
  "join-with-link": "link",
  "insert-into-note": "file-input",
  "open-details": "info",
  "sync-details": "refresh-cw",
  "review-local-changes": "file-diff",
  "review-conflicts": "git-merge",
  "repair-sections": "wrench",
  "restore-marker": "undo-2",
  "go-to-problem": "crosshair",
  "check-result": "search",
  "continue-flow": "play",
  "open-for-editing": "pencil",
  "open-settings": "settings",
  "copy-readable": "copy",
  "copy-shared-section": "clipboard-copy",
  "remove-access": "user-x",
  "discard-local-copy": "trash-2",
  "detach-section": "unlink",
  "resource-status": "activity",
};

/** The "More actions" button's icon. */
export const MORE_ICON = "more-horizontal";

/**
 * The icon of a status (the state card and the section list's rows), by what
 * it says: synced, a problem, work under way, offline, read-only, nothing to
 * do yet, not known. Lucide names, as above.
 */
export const STATUS_ICONS = {
  synced: "check-check",
  problem: "triangle-alert",
  busy: "loader",
  offline: "cloud-off",
  "read-only": "eye",
  idle: "circle-dashed",
  unknown: "circle-help",
} as const;
