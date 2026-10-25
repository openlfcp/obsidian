// The action catalogue of the MVP 0.3 pane (docs/architecture/ux-contract-0.3.md
// §3): one stable ID and one label per action, the same on the pane, the
// card, the editor menu and the palette's handler. The fixtures
// (test/fixtures/ux-0.3/states.json) hold the same list; a test keeps them
// equal. Pure: no Obsidian.

export const ACTION_IDS = [
  "share-section",
  "share-whole-section",
  "invite",
  "join-with-link",
  "insert-into-note",
  "open-details",
  "sync-details",
  "review-local-changes",
  "review-conflicts",
  "repair-sections",
  "restore-marker",
  "go-to-problem",
  "check-result",
  "continue-flow",
  "open-for-editing",
  "open-settings",
  "copy-readable",
  "copy-shared-section",
  "remove-access",
  "discard-local-copy",
  "detach-section",
  "resource-status",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export interface ActionSpec {
  readonly id: ActionId;
  readonly label: string;
  /** A destructive action is never primary (A1): it sits in the menu, with its confirmation. */
  readonly destructive: boolean;
}

const spec = (id: ActionId, label: string, destructive = false): ActionSpec => ({
  id,
  label,
  destructive,
});

export const ACTIONS: Readonly<Record<ActionId, ActionSpec>> = {
  "share-section": spec("share-section", "Share section…"),
  "share-whole-section": spec("share-whole-section", "Share the whole section…"),
  invite: spec("invite", "Invite collaborator…"),
  "join-with-link": spec("join-with-link", "Join with a link…"),
  "insert-into-note": spec("insert-into-note", "Insert into a note…"),
  "open-details": spec("open-details", "Open details"),
  "sync-details": spec("sync-details", "Sync details"),
  "review-local-changes": spec("review-local-changes", "Review local changes"),
  "review-conflicts": spec("review-conflicts", "Review conflicts…"),
  "repair-sections": spec("repair-sections", "Repair shared sections…"),
  "restore-marker": spec("restore-marker", "Restore"),
  "go-to-problem": spec("go-to-problem", "Go to the problem"),
  "check-result": spec("check-result", "Check the result"),
  "continue-flow": spec("continue-flow", "Continue"),
  "open-for-editing": spec("open-for-editing", "Open for editing"),
  "open-settings": spec("open-settings", "Open settings"),
  "copy-readable": spec("copy-readable", "Copy readable text"),
  "copy-shared-section": spec("copy-shared-section", "Copy shared section"),
  "remove-access": spec("remove-access", "Remove access…", true),
  "discard-local-copy": spec("discard-local-copy", "Discard the local copy…", true),
  "detach-section": spec("detach-section", "Detach this section", true),
  "resource-status": spec("resource-status", "Resource status"),
};

/** Actions that change the note's source: in Reading view they offer "Open for editing" (T4). */
export const SOURCE_CHANGING: ReadonlySet<ActionId> = new Set<ActionId>([
  "share-section",
  "share-whole-section",
  "repair-sections",
  "restore-marker",
  "detach-section",
]);
