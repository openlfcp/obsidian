// The one dispatcher of the MVP 0.3 actions (LFCP-03-010, U03-07; UX
// contract §3): every surface (the command palette, the section card, the
// editor menu, the pane) runs an action by its stable ID through here, and
// reaches the same handler with the same guards and the same reservation.
// A surface supplies only what it found: the note as it captured it, the
// section it is about, or the flow it drew. The palette command IDs stay as
// they are; they map to these action IDs.
//
// Reservations (OBSIDIAN-UX-ARCHITECTURE-03 §4), held by the handlers:
//   share, import   the note (SectionActions, one flow per note identity)
//   insert          the target note (the same reservation)
//   join            one join flow per workspace (CollabCommands#joining):
//                   the Resource is known only once the link is parsed
//   invite          the existing invitation lock (CollabCommands#oneInvitation)
// A repeated start of a running flow reveals it; one whose result is
// unknown is checked again, never started as a new operation (D12).
//
// Pure: no Obsidian.

import { fromBase64url, type ResourceId } from "@openlfcp/core";
import type { SectionActions } from "../sections/actions";
import type { TargetCapture } from "../sections/target";
import type { ActionId } from "./catalog";

/** What a surface hands an action: only what it found, never a live editor. */
export interface ActionRequest {
  /** The note as the surface captured it (palette and menu: the editor; pane: its context's note). */
  readonly target?: TargetCapture;
  /** The section the surface is about (the card, a pane row): its key and shared title. */
  readonly section?: { readonly key: string; readonly title: string };
  /** The flow a "Check the result" was drawn for (ActiveFlow.generation). */
  readonly flow?: number;
}

/** A surface an action is run from; it changes nothing about the handler (U03-07). */
export type Surface = "palette" | "card" | "menu" | "pane";

export type ActionHandler = (request: ActionRequest) => Promise<void>;

/** The collaboration commands the dispatcher reaches (CollabCommands). */
export interface CollabEntry {
  joinCollaboration(): Promise<void>;
  /** "Invite collaborator" with a choice of Resource (the palette). */
  inviteCollaborator(): Promise<void>;
  /** "Invite collaborator" for one Resource (the card, the pane). */
  inviteTo(resource: ResourceId): Promise<void>;
}

/** The palette command each action runs as (its ID unchanged since 0.4.0, UX contract §3). */
export const PALETTE_COMMAND: Readonly<Partial<Record<ActionId, string>>> = {
  "share-section": "share-section",
  invite: "invite-collaborator",
  "join-with-link": "join-collaboration",
  "insert-into-note": "insert-section",
  "open-details": "open-section-details",
  "repair-sections": "repair-shared-sections",
  "go-to-problem": "next-section-problem",
  "copy-readable": "copy-readable-text",
  "detach-section": "detach-section",
};

export class ActionDispatcher {
  constructor(private readonly handlers: Readonly<Partial<Record<ActionId, ActionHandler>>>) {}

  /** Whether `id` has a handler here (an action this host can run now). */
  handles(id: ActionId): boolean {
    return this.handlers[id] !== undefined;
  }

  /**
   * Runs action `id` from `surface`: the one handler of that action. An
   * action without a handler here does nothing. The handler checks its
   * guards again before any effect.
   */
  run(id: ActionId, request: ActionRequest = {}, _surface: Surface = "palette"): Promise<void> {
    const handler = this.handlers[id];
    return handler === undefined ? Promise.resolve() : handler(request);
  }
}

/** A section key's Resource ("<resource base64url>#<section>"). */
const resourceOf = (key: string): ResourceId =>
  fromBase64url(key.slice(0, key.indexOf("#"))) as ResourceId;

/**
 * The handlers of the section and collaboration actions. `sections` is
 * null while shared sections are off on this device: their actions do
 * nothing. Actions only the host can run (go to the problem, copy, open
 * settings, open for editing) are added by the host.
 */
export function coreHandlers(env: {
  readonly sections: () => SectionActions | null;
  readonly collab: CollabEntry;
}): Partial<Record<ActionId, ActionHandler>> {
  const withTarget =
    (run: (a: SectionActions, at: TargetCapture) => Promise<void> | void): ActionHandler =>
    async (r) => {
      const a = env.sections();
      if (a !== null && r.target !== undefined) await run(a, r.target);
    };
  return {
    "share-section": withTarget((a, at) => a.share(at)),
    "share-whole-section": withTarget((a, at) => a.shareWholeSection(at)),
    "insert-into-note": withTarget((a, at) => a.insertSection(at)),
    "repair-sections": withTarget((a, at) => a.repairNote(at)),
    "detach-section": withTarget((a, at) => a.detachSectionAt(at)),
    "open-details": async (r) => {
      const a = env.sections();
      if (a === null) return;
      if (r.section !== undefined) await a.openCard(r.section.key, r.section.title);
      else if (r.target !== undefined) a.openCardAt(r.target);
    },
    "review-conflicts": async (r) => {
      const a = env.sections();
      if (a === null) return;
      if (r.section !== undefined) a.reviewConflicts(r.section.key, r.section.title);
      else if (r.target !== undefined) a.reviewConflictsAt(r.target.text, r.target.cursorLine);
    },
    "check-result": async (r) => {
      const a = env.sections();
      if (a !== null && r.flow !== undefined) await a.checkResult(r.flow);
    },
    "join-with-link": () => env.collab.joinCollaboration(),
    invite: (r) =>
      r.section === undefined
        ? env.collab.inviteCollaborator()
        : env.collab.inviteTo(resourceOf(r.section.key)),
  };
}
