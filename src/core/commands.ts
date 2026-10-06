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
}

export const COMMANDS: readonly CommandSpec[] = [
  { id: "share-task-under-cursor", name: "Share task under cursor", implementedBy: "LFCP-065" },
  { id: "insert-shared-object", name: "Insert shared object", implementedBy: "LFCP-065" },
  { id: "share-selected-tasks", name: "Share selected tasks", implementedBy: "POST-018" },
  {
    id: "insert-all-tasks",
    name: "Insert all tasks from collaboration",
    implementedBy: "POST-018",
  },
  { id: "create-collaboration", name: "Create collaboration", implementedBy: "LFCP-065" },
  { id: "join-collaboration", name: "Join collaboration", implementedBy: "LFCP-065" },
  { id: "invite-collaborator", name: "Invite collaborator", implementedBy: "LFCP-065" },
  { id: "resource-status", name: "Resource status", implementedBy: "LFCP-065" },
  { id: "detach-shared-task", name: "Detach shared task", implementedBy: "LFCP-065" },
  {
    id: "resolve-shared-conflict",
    name: "Resolve shared task conflict",
    implementedBy: "LFCP-065",
  },
];
