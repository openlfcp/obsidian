// The join flow (LFCP-03-015; U03-10, U03-11; UX contract §9; package
// OBSIDIAN-CONTEXTUAL-UX-03 §6): one join at a time on this workspace, as
// the Shared Tasks pane shows it. Obsidian-free.
//
//   link → explicit Join → claim → access → load → choose a place
//
// - The link comes only from the user: the pane's masked field or the
//   palette's masked dialog. Nothing reads the clipboard; no OS handler.
// - The link is never kept here. The state holds the Resource the link
//   names, the facts confirmed so far, and why the last attempt stopped.
// - The claim, its journal and its resume are the SDK's and service.ts's
//   (LFCP-02-110): a claim whose answer was lost stays "unknown", and
//   "Check the result" settles that same claim from its journal. It is
//   never sent again as a new join.
// - A Resource this vault already holds is not claimed again: the flow
//   leads to the section and its next step.
// - Naming is optional (N5): the pane asks for no name; an empty one shows
//   the section's shared title.
// - Once joined, the section is the pane's subject (D9) and its next step
//   is "Insert into a note…" (task 016 does the insertion). "Later" ends
//   the flow; the section stays listed as not inserted yet.
//
// One lock for every surface (F-C04): the palette's join holds it from its
// first dialog, the pane's from its Join button; a second start meanwhile
// claims nothing.

import type { ResourceId } from "@openlfcp/core";
import { toHex } from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { parseInviteUri } from "@openlfcp/wire";
import { NEEDS_NEWER_VERSION } from "../lfcp/runtime";
import { codeOf, plainCode, plainError, REMOVED_REJOIN } from "./messages";
import type { Collaboration, JoinOutcome, JoinStage } from "./service";

/** What the join flow needs of the collaboration flows (service.ts). */
export type JoinCollab = Pick<Collaboration, "join" | "list" | "resumeJoin" | "abandonJoin">;

/** The flow's stages (pane/flows.ts FLOW_STAGES.join). */
export type JoinFlowStage = "link" | "claiming capability" | "access" | "loading" | "choose-place";

/** Why a join stopped, told apart by its real cause (I6). */
export type JoinProblem =
  | "malformed"
  | "used"
  | "removed"
  | "needs-newer-version"
  | "refused"
  | "offline"
  | "not-claimed"
  | "busy"
  | "not-ready"
  | "error";

export interface JoinFlowState {
  /** This flow's number: a late click drawn for an ended one does nothing. */
  readonly generation: number;
  readonly stage: JoinFlowStage;
  /** "unknown": the claim was sent and its answer was lost; it is kept on this device. */
  readonly outcome: "running" | "unknown";
  /** The Resource the link names, once read; never the link. */
  readonly resource: ResourceId | null;
  /** What is confirmed so far, in words, in order: each stage's evidence. */
  readonly facts: readonly string[];
  /** Why the last attempt stopped, in words; null when it did not. */
  readonly problem: string | null;
  readonly problemKind: JoinProblem | null;
  /** "Check the result" runs now. */
  readonly checking: boolean;
}

export interface JoinFlowEnv {
  /** The collaboration flows, or null while OpenLFCP is not ready. */
  readonly collab: () => JoinCollab | null;
  /** A short message once a join ends where the pane shows no more of it (a 0.1 collaboration). */
  readonly notice: (text: string) => void;
  /** A shared section was joined, or found already joined: the pane is about it now (D9). */
  readonly joined?: (resource: ResourceId) => void;
}

export const JOIN_TEXT = {
  malformed: "This is not an invitation link. Paste the whole lfcp://join/… link.",
  busy: "A join is in progress. Finish it first.",
  notReady: "Shared Tasks is still starting. Join again in a moment.",
  used: "The server refused the claim: this link was already used, or it no longer grants access. Ask the person who invited you for a new link.",
  notClaimed:
    "The claim did not reach the server, and the invitation was not used. Paste the same link again to join.",
  claimed: "The server accepted the claim.",
  already: "This vault had already joined this section. No new claim was made.",
  loaded: "Loaded on this device.",
  loading: "Not fully loaded on this device yet: insert it once it has loaded.",
  stopped: "Shared Tasks: stopped joining. Your notes are unchanged.",
} as const;

/** The pane's step for a stage the service reports (service.ts JoinStage). */
const STEP: Readonly<Record<JoinStage, JoinFlowStage>> = {
  connecting: "claiming capability",
  "validating invitation": "claiming capability",
  "retrieving key": "claiming capability",
  "claiming capability": "claiming capability",
  synchronizing: "access",
  "loading section": "loading",
};

const accessText = (abilities: readonly string[]): string =>
  abilities.includes("data/write") ? "Access: read and write." : "Access: read only.";

/** A refusal in words: the claim refused for good is a used (or no longer valid) link (I6). */
function refusedText(code: string): { kind: JoinProblem; text: string } {
  if (code === "AUTHORIZATION_FAILED") return { kind: "used", text: JOIN_TEXT.used };
  return { kind: "refused", text: `The server refused the claim. ${plainCode(code)}` };
}

export class JoinFlow {
  readonly #env: JoinFlowEnv;
  #state: JoinFlowState | null = null;
  #generation = 0;
  /** A join is being asked for or run: its dialog is open, or its claim is under way. */
  #held = false;
  readonly #listeners = new Set<() => void>();

  constructor(env: JoinFlowEnv) {
    this.#env = env;
  }

  /** The join as the pane shows it now, or null when none is open. */
  state(): JoinFlowState | null {
    return this.#state;
  }

  /** Calls `listener` when the join starts, moves to another stage or ends; returns how to stop. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** A join holds the lock, or waits for the answer to a claim it sent. */
  busy(): boolean {
    return this.#held || this.#state?.outcome === "unknown";
  }

  /**
   * Takes the one join lock (the palette's dialogs, F-C04); null when a join
   * is under way or its claim's answer is unknown. Release it when done.
   */
  hold(): (() => void) | null {
    if (this.busy()) return null;
    this.#held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held = false;
      this.#changed();
    };
  }

  /**
   * The pane's "Join with a link…": the field for a pasted link (I5). Opens
   * nothing else and sends nothing. A join already open is left as it is
   * (A4), except one that only waits for a place: a new link replaces it.
   */
  open(): void {
    const s = this.#state;
    if (s !== null && s.stage !== "choose-place") return;
    if (this.busy()) return;
    this.#set({
      generation: ++this.#generation,
      stage: "link",
      outcome: "running",
      resource: null,
      facts: [],
      problem: null,
      problemKind: null,
      checking: false,
    });
  }

  /**
   * The pane's Join button: claims the pasted `link` (the explicit Join).
   * Every result is kept in the state, never thrown: the pane shows it
   * until the next step. `name` is optional (N5).
   */
  async submit(link: string, name = ""): Promise<void> {
    const at = this.#state;
    if (at === null || at.stage !== "link" || at.outcome !== "running") return;
    if (!isInvitation(link)) {
      this.#problem("malformed", JOIN_TEXT.malformed);
      return;
    }
    if (this.#env.collab() === null) {
      this.#problem("not-ready", JOIN_TEXT.notReady);
      return;
    }
    const release = this.hold();
    if (release === null) {
      this.#problem("busy", JOIN_TEXT.busy);
      return;
    }
    try {
      await this.run(link, { name, from: "pane" });
    } catch (e) {
      const code = codeOf(e);
      if (code === "INVALID_INVITATION" || code === "INVALID_INVITE_URI")
        this.#problem("malformed", JOIN_TEXT.malformed);
      else this.#problem("error", plainError(e));
    } finally {
      release();
    }
  }

  /**
   * Runs the join of `link` while the lock is held (the pane's Join, the
   * palette's dialog), the state following each stage. Returns the
   * service's outcome; throws what the service throws (a malformed link).
   */
  async run(
    link: string,
    options: {
      readonly name: string;
      readonly from: "pane" | "palette";
      readonly onStage?: (stage: JoinStage) => void;
    },
  ): Promise<JoinOutcome> {
    const collab = this.#env.collab();
    if (collab === null) throw new Error(JOIN_TEXT.notReady);
    const generation = options.from === "pane" ? this.#generation : ++this.#generation;
    let resource: ResourceId | null = null;
    try {
      resource = parseInviteUri(link.trim()).resourceId as ResourceId;
    } catch {
      // The service reports it as it always did.
    }
    this.#set({
      generation,
      stage: "claiming capability",
      outcome: "running",
      resource,
      facts: [],
      problem: null,
      problemKind: null,
      checking: false,
    });
    let outcome: JoinOutcome;
    try {
      outcome = await collab.join(link, {
        name: options.name,
        onStage: (stage) => {
          options.onStage?.(stage);
          this.#stage(generation, stage);
        },
      });
    } catch (e) {
      // The palette says it in a notice; the pane keeps it in its field (submit).
      if (options.from === "palette") this.#end(generation);
      throw e;
    }
    await this.#settle(generation, outcome, options.from, collab);
    return outcome;
  }

  /**
   * "Check the result" of a claim whose answer was lost (D12, I7): the same
   * claim, from its journal, never a new one. A late click for another
   * flow does nothing.
   */
  async checkResult(generation: number): Promise<void> {
    const s = this.#state;
    if (s === null || s.generation !== generation || s.outcome !== "unknown" || s.checking) return;
    const R = s.resource;
    const collab = this.#env.collab();
    if (R === null || collab === null) return;
    this.#set({ ...s, checking: true });
    let out: Awaited<ReturnType<JoinCollab["resumeJoin"]>>;
    try {
      out = await collab.resumeJoin(R);
    } catch (e) {
      if (this.#state?.generation === generation)
        this.#set({ ...s, checking: false, problem: plainError(e), problemKind: "error" });
      return;
    }
    if (this.#state?.generation !== generation) return;
    if (out.kind === "not-claimed") {
      this.#set({
        ...s,
        stage: "link",
        outcome: "running",
        checking: false,
        problem: JOIN_TEXT.notClaimed,
        problemKind: "not-claimed",
      });
      return;
    }
    await this.#settle(generation, out, "pane", collab);
  }

  /**
   * The flow's own way out, by stage: "Cancel" before the claim (nothing
   * was sent), "Later" once joined (the section stays listed as not
   * inserted yet), "Give up" a claim whose answer was lost (its journal is
   * dropped; nothing joined is kept). Nothing while the claim runs.
   */
  async dismiss(generation: number): Promise<void> {
    const s = this.#state;
    if (s === null || s.generation !== generation || s.checking) return;
    if (s.outcome === "unknown") {
      const collab = this.#env.collab();
      if (s.resource !== null && collab !== null) await collab.abandonJoin(s.resource);
      this.#end(generation);
      this.#env.notice(JOIN_TEXT.stopped);
      return;
    }
    if (s.stage === "link" || s.stage === "choose-place") this.#end(generation);
  }

  /**
   * The joined section's next step was taken (its insertion journaled): the
   * flow ends. With `resource`, only when it is that join's Resource.
   */
  placed(resource?: ResourceId): void {
    const s = this.#state;
    if (s?.stage !== "choose-place") return;
    if (resource !== undefined && (s.resource === null || toHex(s.resource) !== toHex(resource)))
      return;
    this.#end(s.generation);
  }

  #stage(generation: number, stage: JoinStage): void {
    const s = this.#state;
    if (s === null || s.generation !== generation) return;
    const step = STEP[stage];
    // The claim was acknowledged and stored: the access it grants is this vault's now.
    const facts =
      step === "access" && !s.facts.includes(JOIN_TEXT.claimed)
        ? [...s.facts, JOIN_TEXT.claimed]
        : s.facts;
    if (step !== s.stage || facts !== s.facts) this.#set({ ...s, stage: step, facts });
  }

  /** What an outcome comes to: the next step, a problem in the field, or an unknown claim. */
  async #settle(
    generation: number,
    outcome: JoinOutcome,
    from: "pane" | "palette",
    collab: JoinCollab,
  ): Promise<void> {
    const s = this.#state;
    if (s === null || s.generation !== generation) return;
    switch (outcome.kind) {
      case "joined": {
        if (outcome.section === undefined) {
          // A 0.1 collaboration: no section to place; the palette says it as it always did.
          if (from === "pane")
            this.#env.notice(
              `Shared Tasks: joined (${outcome.abilities.includes("data/write") ? "read and write" : "read only"}).`,
            );
          this.#end(generation);
          return;
        }
        const facts = [
          ...(s.facts.includes(JOIN_TEXT.claimed) ? s.facts : [...s.facts, JOIN_TEXT.claimed]),
          accessText(outcome.abilities),
          outcome.section.loaded ? JOIN_TEXT.loaded : JOIN_TEXT.loading,
        ];
        this.#joined(generation, outcome.resourceId, facts);
        return;
      }
      case "already-member": {
        const R = outcome.resourceId;
        const entry = (await collab.list().catch(() => [])).find(
          (e) => toHex(e.resourceId) === toHex(R),
        );
        if (entry?.profile !== SECTIONS_PROFILE_ID) {
          if (from === "pane")
            this.#env.notice("Shared Tasks: this device is already in that collaboration.");
          this.#end(generation);
          return;
        }
        this.#joined(generation, R, [JOIN_TEXT.already]);
        return;
      }
      case "removed":
        this.#stopped(generation, from, "removed", REMOVED_REJOIN);
        return;
      case "needs-newer-version":
        this.#stopped(
          generation,
          from,
          "needs-newer-version",
          `${NEEDS_NEWER_VERSION}, then join again with the same link: it has not been used.`,
        );
        return;
      case "refused": {
        const r = refusedText(outcome.code);
        this.#stopped(generation, from, r.kind, r.text);
        return;
      }
      case "unavailable":
        if (outcome.claimSent === true) {
          // The claim is journaled (LFCP-02-110): kept, and checked, never sent anew.
          this.#set({
            ...s,
            stage: "claiming capability",
            outcome: "unknown",
            resource: outcome.resourceId ?? s.resource,
            checking: false,
            problem: s.outcome === "unknown" ? outcome.message : null,
            problemKind: null,
          });
          return;
        }
        this.#stopped(generation, from, "offline", outcome.message);
        return;
    }
  }

  #joined(generation: number, R: ResourceId, facts: readonly string[]): void {
    this.#set({
      generation,
      stage: "choose-place",
      outcome: "running",
      resource: R,
      facts,
      problem: null,
      problemKind: null,
      checking: false,
    });
    this.#env.joined?.(R);
  }

  /** A join that stopped with a known cause: back to the field with it (the pane); the palette says it. */
  #stopped(generation: number, from: "pane" | "palette", kind: JoinProblem, text: string): void {
    if (from === "palette") {
      this.#end(generation);
      return;
    }
    const s = this.#state;
    if (s === null || s.generation !== generation) return;
    this.#set({
      ...s,
      stage: "link",
      outcome: "running",
      facts: [],
      checking: false,
      problem: text,
      problemKind: kind,
    });
  }

  #problem(kind: JoinProblem, text: string): void {
    const s = this.#state;
    if (s === null) return;
    this.#set({
      ...s,
      stage: "link",
      outcome: "running",
      checking: false,
      problem: text,
      problemKind: kind,
    });
  }

  #end(generation: number): void {
    if (this.#state?.generation !== generation) return;
    this.#set(null);
  }

  #set(next: JoinFlowState | null): void {
    this.#state = next;
    this.#changed();
  }

  #changed(): void {
    for (const l of [...this.#listeners]) l();
  }
}

/** A link the user may mean as an invitation: parsed, never shown or kept. */
function isInvitation(link: string): boolean {
  try {
    parseInviteUri(link.trim());
    return true;
  } catch {
    return false;
  }
}
