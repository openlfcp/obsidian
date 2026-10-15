// The one dispatcher of the MVP 0.3 actions (LFCP-03-010, U03-07; UX
// contract §3): every surface (the command palette, the section card, the
// editor menu, the pane) runs an action by its stable ID through here, and
// reaches the same handler with the same guards and the same reservation.
// A surface supplies only what it found: the note as it captured it, the
// section it is about, the flow it drew, or a place it points at. Every
// button of the card comes here (SectionActions.dispatchThrough, A7), and
// every action of the catalogue has its handler (LFCP-03-013): those that
// end in Obsidian (the editor, the clipboard, the settings) through the
// host's HostEntry. The palette command IDs stay as they are; they map to
// these action IDs.
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
  /** The flow a "Check the result" or "Continue" was drawn for (ActiveFlow.generation). */
  readonly flow?: number;
  /** A place the surface points at (the card's held copy): a note and its 0-based line. */
  readonly at?: { readonly path: string; readonly line: number };
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
  /** "Resource status" with a choice of Resource (the palette). */
  resourceStatus(): Promise<void>;
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
  "resource-status": "resource-status",
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

/** What only the host can do, for the handlers that end there (Obsidian's editor, clipboard, settings). */
export interface HostEntry {
  /** "Go to next shared section problem" in the note of `at` (the palette's command). */
  nextProblem(at: TargetCapture): void;
  /** The note of `at`, out of Reading view into an editor (T4). */
  openForEditing(at: TargetCapture): Promise<void>;
  /** The plugin's settings, opened. */
  openSettings(): void;
  /** "Copy readable text": the selection of `at`, else its section, without sharing metadata. */
  copyReadable(at: TargetCapture): Promise<void>;
}

/**
 * The handlers of the section and collaboration actions. `sections` is
 * null while shared sections are off on this device: their actions do
 * nothing. Actions that end in the host (the editor, the clipboard, the
 * settings) go through `host`, which the plugin gives.
 */
export function coreHandlers(env: {
  readonly sections: () => SectionActions | null;
  readonly collab: CollabEntry;
  readonly host?: HostEntry;
}): Partial<Record<ActionId, ActionHandler>> {
  // A flow's next step drawn for that flow (the pane, T2) goes back to it, on its own note.
  const withTarget =
    (run: (a: SectionActions, at: TargetCapture) => Promise<void> | void): ActionHandler =>
    async (r) => {
      const a = env.sections();
      if (a === null) return;
      if (r.target !== undefined) await run(a, r.target);
      else if (r.flow !== undefined) await a.continueFlow(r.flow);
    };
  /** The section's details card: where its sync facts, held edits and access list are. */
  const card: ActionHandler = async (r) => {
    const a = env.sections();
    if (a === null) return;
    if (r.section !== undefined) await a.openCard(r.section.key, r.section.title);
    else if (r.target !== undefined) a.openCardAt(r.target);
  };
  const host = env.host;
  return {
    "share-section": withTarget((a, at) => a.share(at)),
    "share-whole-section": withTarget((a, at) => a.shareWholeSection(at)),
    "insert-into-note": withTarget((a, at) => a.insertSection(at)),
    // On the note captured, else on the note a surface names (the card's held copy).
    "repair-sections": async (r) => {
      const a = env.sections();
      if (a === null) return;
      if (r.target !== undefined) await a.repairNote(r.target);
      else if (r.at !== undefined) await a.repairAt(r.at.path);
      else if (r.flow !== undefined) await a.continueFlow(r.flow);
    },
    "detach-section": withTarget((a, at) => a.detachSectionAt(at)),
    "open-details": card,
    // UX §3: the card, at its sync facts, its held edits, its access list (where removal is asked).
    "sync-details": card,
    "review-local-changes": card,
    "remove-access": card,
    "discard-local-copy": async (r) => {
      const a = env.sections();
      if (a !== null && r.section !== undefined)
        await a.discardLocalCopies(r.section.key, r.section.title);
    },
    // A place named (the card's held copy), else the section's held copy, else the note's next problem.
    "go-to-problem": async (r) => {
      const a = env.sections();
      if (a === null) return;
      if (r.at !== undefined) return a.goToLine(r.at.path, r.at.line);
      if (r.section !== undefined && (await a.goToHeld(r.section.key, r.target?.path))) return;
      if (r.target !== undefined) host?.nextProblem(r.target);
    },
    "continue-flow": async (r) => {
      const a = env.sections();
      if (a !== null && r.flow !== undefined) await a.continueFlow(r.flow);
    },
    "resource-status": async (r) => {
      const a = env.sections();
      if (r.section === undefined) await env.collab.resourceStatus();
      else if (a !== null) await a.resourceStatus(r.section.key);
    },
    ...(host === undefined
      ? {}
      : {
          "open-for-editing": async (r: ActionRequest) => {
            if (r.target !== undefined) await host.openForEditing(r.target);
          },
          "open-settings": async () => host.openSettings(),
          "copy-readable": async (r: ActionRequest) => {
            if (r.target !== undefined) await host.copyReadable(r.target);
          },
        }),
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
