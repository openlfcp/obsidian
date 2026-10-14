// Flows as the pane shows them (UX contract §5 P2; OBSIDIAN-UX-ARCHITECTURE-03
// §6): a view over the existing creation, claim and insertion journals, not
// a second journal. Each kind has its stages in order; a stage either waits
// for the user (a preview, a choice, a dialog of its own) or for an effect
// (a local write or the server). While an effect runs the pane offers no
// next step, only its progress. Pure: no Obsidian.

import type { ActionId } from "./actions";

export type FlowKind = "share" | "invite" | "join" | "insert" | "repair";
export type FlowOutcome = "running" | "unknown" | "unfinished";

export interface FlowStage {
  readonly id: string;
  /** The step as the pane lists it. */
  readonly label: string;
  /** "user": the next step is the user's; "effect": a write or the server is under way. */
  readonly waits: "user" | "effect";
}

const user = (id: string, label: string): FlowStage => ({ id, label, waits: "user" });
const effect = (id: string, label: string): FlowStage => ({ id, label, waits: "effect" });

/**
 * The stages of each flow, in order (UX §5, §6). The IDs are the ones the
 * journals report where one exists ("captured", "projected", "claiming
 * capability"); the others name the pane's own steps before an effect.
 */
export const FLOW_STAGES: Readonly<Record<FlowKind, readonly FlowStage[]>> = {
  share: [
    user("preview", "Check what is shared"),
    effect("creating", "Create the shared section on this device"),
    effect("hosting", "Put it on the sync server"),
  ],
  invite: [
    user("role", "Choose Read or Read + write"),
    effect("creating", "Create the invitation link"),
    user("link", "Show or copy the link"),
  ],
  join: [
    // Pasting the link and choosing Join in the pane's field is the explicit Join (UX §6, I5).
    user("link", "Paste the invitation link and choose Join"),
    effect("claiming capability", "Claim the invitation with the server"),
    effect("loading", "Load the section"),
    user("choose-place", "Choose a note to insert it into"),
  ],
  insert: [
    user("captured", "Choose a note and a place"),
    user("preview", "Check the readable text"),
    effect("writing", "Write the section into the note"),
    effect("projected", "Register the copy in the note"),
  ],
  repair: [
    user("compare", "Compare with the shared version"),
    effect("applying", "Apply the repair"),
  ],
};

/** The pane action that is a flow's next step at a stage that waits for the user. */
export function flowAction(kind: FlowKind, stage: string): ActionId {
  switch (kind) {
    case "share":
      return "share-section";
    case "invite":
      return "invite";
    case "join":
      return stage === "choose-place" ? "insert-into-note" : "join-with-link";
    case "insert":
      return "insert-into-note";
    case "repair":
      return "repair-sections";
  }
}

export const FLOW_TITLE: Readonly<Record<FlowKind, string>> = {
  share: "Sharing a section",
  invite: "Inviting a collaborator",
  join: "Joining with a link",
  insert: "Inserting a shared section",
  repair: "Repairing a shared section",
};

/** A flow's stage; an unknown ID (a newer journal) waits for the user, never a guessed effect. */
export function stageOf(kind: FlowKind, stage: string): FlowStage {
  return FLOW_STAGES[kind].find((s) => s.id === stage) ?? user(stage, stage);
}
