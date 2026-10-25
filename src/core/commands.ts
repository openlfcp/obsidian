// The plugin's commands (OBSIDIAN-ARCHITECTURE-01 §50), independent of
// Obsidian so another editor adapter can register the same set.
//
// The set is LFCP-065's product UI list plus its conflict hook; the
// handlers are src/core/collab/commands.ts. Names follow §50 ("LFCP: …")
// where it has the command. Obsidian prefixes the plugin name in its
// palette, so the names here omit "LFCP:".

/** A command an editor adapter registers. */
export interface CommandSpec {
  /** Stable command ID, unique within the plugin. */
  readonly id: string;
  /** The palette name. */
  readonly name: string;
  /** The backlog task that implements it. */
  readonly implementedBy: string;
  /**
   * A command of the 0.1 task collaborations (UX-01, UXD-2). "always": it is
   * the way into an older collaboration, so it is registered on every
   * device. "when-data": registered only once the vault holds a Resource of
   * the Shared Objects profile. Absent: not a 0.1 command.
   */
  readonly legacy?: "always" | "when-data";
}

/** The palette command that invites to the shared section at the cursor (UX-02, UXD-4). */
export const INVITE_TO_SECTION: CommandSpec = {
  id: "invite-to-section",
  name: "Invite to this section…",
  implementedBy: "UX-02",
};

/** The notice of "Invite to this section…" with the cursor outside every shared section. */
export const INVITE_CURSOR_NOTICE = "Put the cursor in a shared section to invite someone to it.";

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: "share-task-under-cursor",
    name: "Legacy: Share task under cursor",
    implementedBy: "LFCP-065",
    legacy: "when-data",
  },
  {
    id: "insert-shared-object",
    name: "Legacy: Insert shared object",
    implementedBy: "LFCP-065",
    legacy: "when-data",
  },
  {
    id: "share-selected-tasks",
    name: "Legacy: Share selected tasks",
    implementedBy: "POST-018",
    legacy: "when-data",
  },
  {
    id: "insert-all-tasks",
    name: "Legacy: Insert all tasks from task collaboration",
    implementedBy: "POST-018",
    legacy: "when-data",
  },
  {
    id: "create-collaboration",
    name: "Legacy: Create task collaboration",
    implementedBy: "LFCP-065",
    legacy: "when-data",
  },
  {
    id: "join-collaboration",
    name: "Legacy: Join task collaboration",
    implementedBy: "LFCP-065",
    legacy: "always",
  },
  {
    id: "invite-collaborator",
    name: "Legacy: Invite to task collaboration",
    implementedBy: "LFCP-065",
    legacy: "when-data",
  },
  { id: "resource-status", name: "Resource status", implementedBy: "LFCP-065" },
  { id: "detach-shared-task", name: "Detach shared task", implementedBy: "LFCP-065" },
  {
    id: "resolve-shared-conflict",
    name: "Resolve shared task conflict",
    implementedBy: "LFCP-065",
  },
  {
    id: "toggle-sharing-metadata",
    name: "Show or hide sharing metadata",
    implementedBy: "LFCP-02-048",
  },
];
