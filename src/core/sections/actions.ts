// The section actions (LFCP-03-008, F-C03, F-C08, U03-07): share, import,
// insert, detach, repair and the section card, Obsidian-free. An editor
// adapter supplies the ports of action-ports.ts; this executor decides what
// to ask, checks again before each side effect, and calls the section cores
// (share, create, insert, rules, repair, recovery). Every surface (palette,
// card, editor menu, pane) reaches these methods through one dispatcher
// (actions/dispatcher.ts, LFCP-03-010), so it shares one handler, one
// guard and one reservation per note. The guards are the action
// descriptors' predicates (actions/descriptors.ts), checked again here on
// the facts as they are when the action runs.
//
// An effect whose outcome is unknown (a creation or an insertion that
// threw) does not free its note (owner decision D12): the flow stays
// reserved until a reconcile of the same operation, from its journal,
// finds the result. A repeated start meanwhile runs that check and says
// so; it never allocates a new operation. Once the result is known, a
// later explicit share or insert is a new operation.
//
// After a restart (LFCP-03-017) the journals are read again: a creation
// goes on (resumeCreation); an insertion whose block is in its note
// finishes its registration, and one that wrote nothing is listed as
// unfinished on its note until "Continue" shows its preview again and
// runs the same insertion, or the preview is cancelled. Nothing is ever
// deleted, revoked or detached on the way.
//
// Behaviour is that of 0.4.0's SectionsHost, moved: the texts, the order of
// the dialogs and the checks are unchanged, except where LFCP-03-009 binds
// an action to its captured target (target.ts) instead of a live editor:
// a flow keeps its note when the user switches tabs or notes, reads the
// note through the notes port before each effect, and shares an exact
// eligible selection as it is (UX contract 0.3 §4).

import { fromBase64url, type ResourceId, toBase64url } from "@openlfcp/core";
import type { ActionId } from "../actions/catalog";
import {
  type ActionFacts,
  DESCRIPTORS,
  type HostNeeds,
  hostRefusal,
  hostRefusalNotice,
  INVITE_WAITS,
  sectionFacts,
} from "../actions/descriptors";
import type { ActionRequest, Surface } from "../actions/dispatcher";
import { INVITE_CURSOR_NOTICE } from "../commands";
import { type Flow, InFlight, type Reconciled } from "../in-flight";
import { type NoteTarget, NoteTargets } from "../note-targets";
import { contentHash } from "../projection/guard";
import { scanRefs } from "../refs";
import { REMOVE_CONFIRMATION, type RevokeOutcome, revokeMessage } from "../status/access";
import type { SectionCard } from "../status/card";
import type {
  BaseService,
  CandidateService,
  CardAction,
  CardHandle,
  CardRowActions,
  InsertDestination,
  InsertPlace,
  LostBase,
  ModelService,
  ResourceCommands,
  SectionChoice,
  SectionDialog,
  SectionNotes,
  SectionPrompter,
  SectionServices,
  TaskWait,
} from "./action-ports";
import { looseLines, markdownState, newProjectionId, type StoredBase } from "./base";
import { sectionAtLine, sectionKey } from "./context";
import { type CreationEntry, CreationKeyMismatch, type CreationResult } from "./create";
import { heldPasted, pastedBase, showsModel } from "./engine";
import { type SectionRef, sameSection } from "./grammar";
import {
  type InsertionEntry,
  type InsertPreview,
  type InsertResult,
  insertionFits,
  insertionWritten,
  insertRefusalMessage,
  noSectionMessage,
  renderSection,
} from "./insert";
import { type LegacySource, legacyPreflight } from "./legacy";
import { type ParsedSection, parseSections } from "./parser";
import type { SectionSnapshot } from "./port";
import { modelTaskLine } from "./remote";
import {
  adoptedBase,
  boundaryRepair,
  type ComparedLine,
  compare,
  findRepair,
  keyedRepairs,
  type RepairItem,
  repairItems,
  restoreChange,
  sharedVersionChange,
  withoutNodes,
} from "./repair";
import { detachAt } from "./rules";
import { preflight, revalidate, type SharePreview, type ShareRange } from "./share";
import {
  type CapturedTarget,
  captured,
  captureRefusal,
  invalidation,
  invalidationText,
  type NoteNow,
  REPAIR_OPEN_FOR_EDITING,
  SHARE_WHOLE_SECTION,
  selectionReasonText,
  shareScope,
  type TargetCapture,
} from "./target";
import { comparableView } from "./task-fields";

export interface SectionActionEnv {
  readonly prompter: SectionPrompter;
  readonly notes: SectionNotes;
  readonly services: SectionServices;
}

/** A share, import or insert flow, as the pane lists it (LFCP-03-013). */
export interface ActiveFlow {
  /** The flow's number: "Check the result" names it, so a late click on a closed flow does nothing. */
  readonly generation: number;
  readonly kind: "share" | "insert";
  /** The note the flow holds, where it is now; null once deleted. */
  readonly path: string | null;
  /** Where it stands, in words. */
  readonly stage: string;
  /**
   * Its step, as the pane lists the flow's stages (pane/flows.ts
   * FLOW_STAGES): share "preview" or "creating"; insert "captured",
   * "preview" or "writing".
   */
  readonly step: string;
  /**
   * "unknown": its last effect's result is not known; the note stays
   * reserved until it is. "unfinished": a restart stopped it before its
   * next step, which "Continue" resumes (LFCP-03-017); the note stays reserved.
   */
  readonly outcome: "running" | "unknown" | "unfinished";
  /** A check of the unknown result runs now. */
  readonly checking: boolean;
  /** Why the flow cannot go on as it is, in words (a spoiled Resource, LFCP-03-063); absent: none. */
  readonly problem?: string;
}

/** What a creation came to: its journal's result, or unknown (it threw). */
type CreationOutcome =
  | { readonly kind: "known"; readonly result: CreationResult }
  | { readonly kind: "unknown"; readonly error: unknown };

/** The card's link to the pane (LFCP-03-012). */
export const PANE_LINK = "Open Shared Tasks pane";

/**
 * The confirmation of "Detach this section" (§10; LFCP-03-019): this note
 * only; nothing shared changes, nobody's access included.
 */
export const DETACH_CONFIRMATION =
  "Its text stays in this note as your own and no longer updates. The shared section, your other notes, your collaborators and their access are not changed.";

/** How a surface runs an action by its ID: the dispatcher's `run` (actions/dispatcher.ts). */
export type Dispatch = (id: ActionId, request: ActionRequest, surface: Surface) => Promise<void>;

/** Share and import: a new section is hosted from this device. */
const SHARE_NEEDS: HostNeeds = { writes: true, server: true };
const SHARE_AGAIN = "Share the section again in a moment.";

/**
 * How long a share's creation may run before the user is told it is not
 * answering (LFCP-03-058). A creation is local work plus a hosting request
 * that gives up by itself; one that is quiet for longer is stuck somewhere
 * (a step that never returns), and a share that says nothing is a silent
 * failure. Past it the result is unknown (D12): "Check the result" runs the
 * same operation again, never a new one.
 */
export const CREATION_DEADLINE_MS = 45_000;

/** LFCP-03-063: what a spoiled section Resource is, in words. */
const KEY_MISMATCH_PROBLEM =
  "its encryption key on this device does not match the one the section was created with (most likely two starts of sharing ran at once).";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Review N1: a section twice in the note, each copy holding pasted lines (LFCP-03-047). */
const PASTED_TWICE =
  "This section is in this note twice, and both copies hold pasted lines that differ from the shared version: remove one copy, then repair again.";
/** Review N3: Use the shared version found no base to change (LFCP-03-047). */
const PASTED_GONE =
  "Shared Tasks: your text is kept as a recovery copy on this device, but this copy's state changed meanwhile. Nothing was replaced: open the repair again.";

/** What Keep my version did for a section whose Task cannot be compared (no base guessed). */
const KEPT_WAITING: Record<TaskWait, string> = {
  "task-loading":
    "Shared Tasks: this note's version is kept as it is. A Task in it is still loading; once it has, the section asks again if the two versions differ.",
  "task-unreadable":
    "Shared Tasks: this note's version is kept as it is. A Task in it is not a valid task in the shared version; the choice comes back once the shared version is fixed.",
  "task-deleted":
    "Shared Tasks: this note's version is kept as it is. A Task in it is deleted in the shared version; nothing is sent while it stays deleted. Use the shared version to take that version instead.",
};

export class SectionActions {
  /** Share, import and insert flows, one per note at a time (F-03, F-C04), keyed by its held identity. */
  readonly #flows = new InFlight();
  /** What each running flow is and holds, by generation (the pane's list of flows). */
  readonly #active = new Map<
    number,
    { kind: ActiveFlow["kind"]; target: NoteTarget; step: string }
  >();
  /** The notes those flows act on, followed across renames (LFCP-03-002). */
  readonly #targets = new NoteTargets();
  /** The open details card, redrawn when its section's status changes. */
  #card: { readonly key: string; readonly title: string; readonly handle: CardHandle } | null =
    null;

  /** The dispatcher the card's buttons run through (LFCP-03-010); null: their handlers directly. */
  #dispatch: Dispatch | null = null;

  /** The creations running now, by operation ID: a second call for one joins it (LFCP-03-058). */
  readonly #runs = new Map<string, Promise<CreationOutcome>>();
  /** How long a creation may run before it is reported as not answering (CREATION_DEADLINE_MS). */
  readonly #creationDeadlineMs: number;

  constructor(
    private readonly env: SectionActionEnv,
    options: { readonly creationDeadlineMs?: number } = {},
  ) {
    this.#creationDeadlineMs = options.creationDeadlineMs ?? CREATION_DEADLINE_MS;
  }

  /**
   * The card's buttons run their actions through `dispatch`, as every
   * other surface does (U03-07). The host sets it once its dispatcher exists.
   */
  dispatchThrough(dispatch: Dispatch): void {
    this.#dispatch = dispatch;
  }

  /** The host's "Open Shared Tasks pane" (LFCP-03-012); null: the card has no link to it. */
  #openPane: (() => void) | null = null;

  /** The card links to the pane, which `open` reveals (one pane per workspace). */
  paneEntry(open: () => void): void {
    this.#openPane = open;
  }

  /** A card button's action: through the dispatcher when there is one, else `direct`, its handler. */
  #fromCard(
    id: ActionId,
    request: ActionRequest,
    direct: () => Promise<void> | void,
  ): Promise<void> {
    if (this.#dispatch !== null) return this.#dispatch(id, request, "card");
    return Promise.resolve(direct());
  }

  /** How many notes the flows and the repair hold now (diagnostics and tests). */
  heldNotes(): number {
    return this.#targets.size;
  }

  /** The vault renamed a note (its event, as it happens): a flow on it follows it. */
  noteRenamed(oldPath: string, path: string): void {
    this.#targets.renamed(oldPath, path);
  }

  /** The vault deleted a note: a flow on it writes nothing. */
  noteDeleted(path: string): void {
    this.#targets.deleted(path);
  }

  /**
   * "Share section…" as one flow per note (F-03): the preview, then the
   * creation of what was approved. A second start on the same note while
   * one runs (its preview open, or its section being created) opens no
   * second preview and creates nothing: it brings the open preview forward,
   * or says where the running flow stands (LFCP-03-002). Every entry path
   * (palette, hotkey, and the menu, card and pane entries to come) calls
   * this method, so they share the one reservation.
   *
   * `at` is the note as the action found it (LFCP-03-009): its selection,
   * when exact and eligible, is shared as it is; an ineligible one is
   * refused with its reason, and offers "Share the whole section…" where
   * the contract allows it.
   */
  share(at: TargetCapture): Promise<void> {
    return this.#shareFlow(at, false);
  }

  /**
   * "Share the whole section…" (UX contract §3, S2): the heading section
   * that holds the selection, previewed anew; the explicit fallback for an
   * ineligible selection, chosen on the pane or the menu (LFCP-03-010, 012).
   */
  shareWholeSection(at: TargetCapture): Promise<void> {
    return this.#shareFlow(at, true);
  }

  #shareFlow(at: TargetCapture, whole: boolean): Promise<void> {
    return this.#oneFlow(at.path, "share", async (target, flow) => {
      const approved = await this.#shareSection(captured(at), target, flow, whole);
      if (approved === null) return;
      flow.stage = `section "${approved.preview.title}" is being shared from this note. Its result shows when it is done.`;
      this.#step(flow, "creating");
      await this.#createSection(approved.path, approved.text, approved.preview, target, flow);
    });
  }

  /**
   * The host guard of the action descriptors (hostRefusal), on the host as
   * it is now: says why not and returns true when the host refuses.
   * `starting` is whether the services this action needs are not running yet.
   */
  #refused(needs: HostNeeds, starting: boolean, again?: string): boolean {
    const { prompter, services } = this.env;
    const why = hostRefusal(
      {
        unavailable: services.unavailable(),
        starting,
        readOnly: services.readOnly(),
        server: services.server().trim() !== "",
      },
      needs,
    );
    if (why === null) return false;
    prompter.notice(hostRefusalNotice(why, again));
    return true;
  }

  /** The note at `path` now: its open editor's text, else its file's; null when no file is there. */
  async #now(path: string): Promise<NoteNow | null> {
    const open = this.env.notes.capture(path);
    if (open !== null) return { text: open.text, open: true, composing: open.composing };
    const text = await this.env.notes.read(path);
    return text === null ? null : { text, open: false, composing: false };
  }

  /**
   * Whether a captured target may start a flow (P3): not from Reading view
   * or a composition, and still the note as it is (a surface may act on a
   * capture taken earlier). Says why not, and returns false.
   */
  async #startable(at: CapturedTarget, target: NoteTarget, nothing: string): Promise<boolean> {
    const why =
      captureRefusal(at) ??
      invalidation(at, target.path, target.path === null ? null : await this.#now(target.path));
    if (why === null) return true;
    this.env.prompter.notice(invalidationText(why, nothing));
    return false;
  }

  /**
   * One share, import or insert per note at a time (F-03, F-C04), reserved
   * before any preview or allocation. The key is the note's held identity,
   * so a rename meanwhile keeps the reservation (LFCP-03-002). A repeated
   * start reveals the running flow: its open dialog, else where it stands.
   */
  async #oneFlow(
    path: string,
    kind: "share" | "insert",
    body: (target: NoteTarget, flow: Flow) => Promise<void>,
    busy: (running: Flow) => void = (running) => this.#revealFlow(running),
  ): Promise<void> {
    // Held until the flow closes: an unknown outcome keeps the note, and follows its renames.
    const held = this.#targets.hold(path);
    let generation = 0;
    await this.#flows.run(
      `note:${held.target.id}`,
      (running) => {
        held.release();
        busy(running);
      },
      (flow) => {
        generation = flow.generation;
        this.#active.set(generation, {
          kind,
          target: held.target,
          step: kind === "share" ? "preview" : "captured",
        });
        this.#changed();
        return body(held.target, flow);
      },
      kind === "share"
        ? "a section of this note is being shared."
        : "a section is being inserted into this note.",
      () => {
        this.#active.delete(generation);
        held.release();
        this.#changed();
      },
    );
  }

  /**
   * A repeated start of a running flow: its open dialog brought forward,
   * else where it stands. A flow whose result is unknown is checked again
   * (the same operation, from its journal), never started anew (D12).
   */
  #revealFlow(running: Flow): void {
    void this.#reveal(running);
  }

  /**
   * A flow brought forward: its open dialog, else where it stands; one
   * whose result is unknown is checked, an unfinished one resumed (the
   * same operation, D12).
   */
  async #reveal(flow: Flow): Promise<void> {
    if (flow.reveal()) return;
    const text = `Shared Tasks: ${flow.stage}`;
    this.env.prompter.notice(text);
    this.env.prompter.announce(text);
    if (flow.held) await this.#check(flow);
  }

  /**
   * Checks a flow's unknown result, or resumes an unfinished one (the same
   * operation). A check that gets no answer in its time says so; the
   * result stays unknown and nothing new is started (LFCP-03-017).
   */
  async #check(flow: Flow): Promise<void> {
    this.#changed();
    await flow.check(() => {
      const text =
        "Shared Tasks: the result is still not known. Nothing new was started: check it again later; it is also checked at the next start.";
      this.env.prompter.notice(text);
      this.env.prompter.announce(text);
      this.#changed();
    });
    this.#changed();
  }

  /** The share, import and insert flows running now, or whose result is being reconciled. */
  flows(): ActiveFlow[] {
    const out: ActiveFlow[] = [];
    for (const [, f] of this.#flows.entries()) {
      const a = this.#active.get(f.generation);
      if (a === undefined) continue;
      out.push({
        generation: f.generation,
        kind: a.kind,
        path: a.target.path,
        stage: f.stage,
        step: a.step,
        // An unfinished flow being continued (its preview open) runs again.
        outcome: f.unfinished && !f.checking ? "unfinished" : f.unknown ? "unknown" : "running",
        checking: f.checking,
        ...(f.problem === null ? {} : { problem: f.problem }),
      });
    }
    return out;
  }

  /**
   * "Check the result" (UX contract §3, `check-result`): reconciles the
   * unknown result of flow `generation`, the same operation from its
   * journal. A flow that closed meanwhile (a late click) is left alone:
   * false.
   */
  async checkResult(generation: number): Promise<boolean> {
    const flow = this.#flows.byGeneration(generation);
    if (flow === undefined || !flow.unknown) return false;
    await this.#reveal(flow);
    return true;
  }

  /** Flow `flow` is at step `step` now (the pane's list of its stages). */
  #step(flow: Flow | undefined, step: string): void {
    const a = flow === undefined ? undefined : this.#active.get(flow.generation);
    if (a !== undefined) a.step = step;
    this.#changed();
  }

  /** Who is told when a flow starts, moves to another step or ends (the pane). */
  readonly #flowListeners = new Set<() => void>();

  /**
   * Calls `listener` when a flow starts, moves to another step or ends, and
   * when a repair or a review choice ran (the pane reads its problems
   * again, LFCP-03-018); returns how to stop.
   */
  onFlowsChange(listener: () => void): () => void {
    this.#flowListeners.add(listener);
    return () => this.#flowListeners.delete(listener);
  }

  /** A flow's outcome turns unknown as its body returns: the pane hears of it right after. */
  #unresolvedSoon(): void {
    queueMicrotask(() => this.#changed());
  }

  #changed(): void {
    for (const l of [...this.#flowListeners]) l();
  }

  /** While `dialog` is open, a repeated start of `flow` brings it forward and says so. */
  #showing(
    flow: Flow | undefined,
    dialog: SectionDialog<unknown>,
    what: string,
    step = "preview",
  ): void {
    this.#step(flow, step);
    flow?.showing(() => {
      dialog.bringForward();
      this.env.prompter.announce(`Shared Tasks: ${what} is open. Finish or cancel it first.`);
    });
  }

  /**
   * "Insert shared section…" (LFCP-02-052), "Insert into a note…"
   * (LFCP-03-016): a ready, fully loaded section of this vault, previewed,
   * then written as one complete projection: after the block at the cursor
   * of the note it started on, or at the end of another note the user
   * chooses, or into a new note the user names. `section` (a section key)
   * is the section a surface is about (the pane's joined section): it needs
   * no choice.
   */
  insertSection(
    at: TargetCapture,
    section?: string,
    /** Called once the insertion is journaled (its effect starts), with the section's key. */
    started?: (section: string) => void,
  ): Promise<void> {
    return this.#oneFlow(at.path, "insert", (target, flow) =>
      this.#insertSection(captured(at), target, flow, section, started),
    );
  }

  /**
   * The insertion goes after the block at the captured cursor, in the
   * captured text (LFCP-03-009): the insertion journal places it there when
   * the note is unchanged, at the same anchor line when it changed, or not
   * at all (stale). A note closed meanwhile is written through the file,
   * with the same check, and the result names it. Another destination is
   * held from its choice (a rename moves it, a deletion refuses it) and
   * reserved as this note is while it is written (LFCP-03-016).
   */
  async #insertSection(
    at: CapturedTarget,
    target: NoteTarget,
    flow: Flow,
    section?: string,
    started?: (section: string) => void,
  ): Promise<void> {
    const { prompter, services } = this.env;
    if (!(await this.#startable(at, target, "inserted"))) return;
    const insertion = services.insertion();
    const choices = insertion === null ? null : await services.sectionChoices();
    if (this.#refused({}, insertion === null || choices === null)) return;
    if (insertion === null || choices === null) return;
    if (choices.length === 0) {
      prompter.notice(noSectionMessage((await services.noSectionFacts?.()) ?? null));
      return;
    }
    let choice = section === undefined ? null : namedChoice(choices, section);
    if (choice === null) {
      const pick = prompter.pickSection(choices);
      this.#showing(flow, pick, "the choice of a section to insert", "captured");
      choice = await pick.result;
      flow.showing(null);
      if (choice === null) return;
    }
    const key = choiceKey(choice);
    const start = started === undefined ? undefined : () => started(key);
    const preview = await insertion.preview(choice.resource as ResourceId, choice.sectionId);
    if ("refused" in preview) {
      prompter.notice(insertRefusalMessage(preview.refused));
      return;
    }
    await services.watch(choice.resource as ResourceId);
    // Read at each use: the index may learn of a note while the dialog is open.
    const placementsNow = (): readonly string[] | null =>
      services.placements?.(choice.resource) ?? null;
    // Both change in the preview's place.change (a closure): read through these, not narrowed.
    let destination: InsertDestination = { kind: "here" };
    /** Another existing note chosen: held while the preview is open (renames followed). */
    let other: { readonly target: NoteTarget; release(): void } | null = null;
    const chosenNow = (): InsertDestination => destination;
    const otherNow = (): { readonly target: NoteTarget; release(): void } | null => other;
    try {
      let dialog: SectionDialog<boolean> | null = null;
      let asking: SectionDialog<InsertDestination | null> | null = null;
      const choose = prompter.chooseDestination?.bind(prompter);
      const place: InsertPlace = {
        get where() {
          return destinationText(destination, other?.target.path ?? null);
        },
        get placements() {
          return placementsNow();
        },
        subscribe: (listener) => services.onPlacements?.(listener) ?? (() => undefined),
        change: async () => {
          if (choose === undefined) return;
          // One choice at a time: a second click brings the open one forward.
          if (asking !== null) {
            asking.bringForward();
            return;
          }
          const ask = choose({
            title: preview.title,
            current: target.path,
            placements: placementsNow(),
          });
          asking = ask;
          this.#showing(flow, ask, "the choice of a note to insert into", "captured");
          const chosen = await ask.result;
          asking = null;
          if (dialog !== null) this.#showing(flow, dialog, "the insert preview");
          if (chosen === null) return;
          other?.release();
          other = null;
          // The note the insert started on is "here": after the paragraph at its cursor.
          destination =
            chosen.kind === "note" && chosen.path === target.path ? { kind: "here" } : chosen;
          if (destination.kind === "note") other = this.#targets.hold(destination.path);
        },
      };
      dialog = prompter.insertPreview(preview, place);
      this.#showing(flow, dialog, "the insert preview");
      const approved = await dialog.result;
      flow.showing(null);
      if (!approved) return;
      const chosen = chosenNow();
      if (chosen.kind === "here") {
        await this.#insertHere(at, target, flow, preview, start);
        return;
      }
      if (chosen.kind === "new") {
        // Never over a note already there (the name was free when it was chosen).
        let made: "created" | "exists" | Error | undefined;
        try {
          made = await this.env.notes.create?.(chosen.path);
        } catch (e) {
          made = e instanceof Error ? e : new Error(String(e));
        }
        if (made !== "created") {
          prompter.notice(
            made === "exists"
              ? `Shared Tasks: a note named "${noteName(chosen.path)}" already exists. Nothing was inserted; choose it as an existing note, or another name.`
              : `Shared Tasks: the note "${noteName(chosen.path)}" could not be created${made === undefined ? "" : ` (${made.message})`}. Nothing was inserted.`,
          );
          return;
        }
        other = this.#targets.hold(chosen.path);
      }
      const path = otherNow()?.target.path ?? null;
      if (path === null) {
        prompter.notice(
          "Shared Tasks: the note was deleted while the preview was open. Nothing was inserted.",
        );
        return;
      }
      // The other note is reserved as this one is: one share or insert per note (F-03).
      await this.#oneFlow(path, "insert", (into, intoFlow) =>
        this.#insertAtEnd(into, intoFlow, preview, start),
      );
    } finally {
      otherNow()?.release();
    }
  }

  /** Into the note the insert started on, after the paragraph at its captured cursor. */
  async #insertHere(
    at: CapturedTarget,
    target: NoteTarget,
    flow: Flow,
    preview: InsertPreview,
    started?: () => void,
  ): Promise<void> {
    const { prompter } = this.env;
    const path = target.path;
    const now = path === null ? null : await this.#now(path);
    if (path === null || now === null) {
      prompter.notice(
        "Shared Tasks: the note was deleted while the preview was open. Nothing was inserted.",
      );
      return;
    }
    // The note as checked here; the journal checks its revision again as it writes.
    const why = invalidation(at, path, now, false);
    if (why !== null) {
      prompter.notice(invalidationText(why, "inserted"));
      return;
    }
    if (!insertionFits(at.text, at.cursorLine, preview)) {
      prompter.notice(
        "Shared Tasks: the section cannot go after the paragraph at the cursor (a code block or a comment is not closed there). Nothing was inserted; choose another place.",
      );
      return;
    }
    await this.#write(path, at.text, at.cursorLine, flow, preview, started);
  }

  /** Into another note, at its end, as it is when the preview was approved. */
  async #insertAtEnd(
    target: NoteTarget,
    flow: Flow,
    preview: InsertPreview,
    started?: () => void,
  ): Promise<void> {
    const { prompter } = this.env;
    const path = target.path;
    const now = path === null ? null : await this.#now(path);
    if (path === null || now === null) {
      prompter.notice(
        "Shared Tasks: the note was deleted while the preview was open. Nothing was inserted.",
      );
      return;
    }
    if (now.composing) {
      prompter.notice(invalidationText("composing", "inserted"));
      return;
    }
    const line = Math.max(0, now.text.split("\n").length - 1);
    if (!insertionFits(now.text, line, preview)) {
      prompter.notice(
        `Shared Tasks: the end of "${noteName(path)}" is inside a code block or a comment that is not closed. Nothing was inserted; choose another note.`,
      );
      return;
    }
    await this.#write(path, now.text, line, flow, preview, started);
  }

  /**
   * Journals the insertion of `preview` into `markdown` after the block at
   * `line`, then writes it once. An insertion that throws keeps its flow's
   * note reserved (D12) until a reconcile of the same insertion ID settles it.
   */
  async #write(
    path: string,
    markdown: string,
    line: number,
    flow: Flow,
    preview: InsertPreview,
    started?: () => void,
  ): Promise<void> {
    const { services } = this.env;
    const insertion = services.insertion();
    if (this.#refused({}, insertion === null) || insertion === null) return;
    const entry = await insertion.prepare(path, markdown, line, preview);
    started?.();
    await this.#run(entry, flow);
  }

  /**
   * Writes a journaled insertion once, said with its result. One that
   * throws keeps its flow's note reserved (D12) until a reconcile of the
   * same insertion ID settles it. `again`: a restart interrupted it.
   */
  async #run(entry: InsertionEntry, flow: Flow, again = false): Promise<void> {
    const { prompter, services } = this.env;
    const insertion = services.insertion();
    if (insertion === null) return;
    const preview = entry.preview;
    flow.stage = `section "${preview.title}" is being inserted into this note.`;
    this.#step(flow, "writing");
    let result: InsertResult;
    try {
      result = await insertion.run(entry);
    } catch (e) {
      // D12: whether the block was written is unknown. The note stays reserved; the same insertion is checked.
      prompter.notice(
        `Shared Tasks: inserting section "${preview.title}" stopped (${errorText(e)}); whether it was written is not known yet. Inserting it into this note again checks it and inserts nothing new.`,
      );
      this.#unresolvedSoon();
      flow.unresolved(
        `the result of inserting section "${preview.title}" into this note is being checked. Nothing new is inserted.`,
        () => this.#reconcileInsertion(entry, preview),
      );
      return;
    }
    await this.#inserted(result, entry, preview, again);
  }

  /**
   * An insertion a restart interrupted (LFCP-03-017, U03-13), from its
   * journal: the same insertion ID, its note reserved as a running insert
   * holds it. Its note gone: nothing is written, the insertion ends. Its
   * block already in the note: the insertion finishes (the copy is
   * registered), and no second block is written. Nothing written: the
   * flow is listed as unfinished; "Continue" shows the same preview again
   * and, approved, writes it once; cancelled, it ends and nothing is
   * written. A note already held by a resumed creation keeps the
   * insertion in its journal for the next start.
   */
  resumeInsertion(entry: InsertionEntry): Promise<void> {
    if (entry.phase !== "prepared") return Promise.resolve();
    return this.#oneFlow(
      entry.path,
      "insert",
      async (_target, flow) => {
        const insertion = this.env.services.insertion();
        if (insertion === null) return;
        const now = await this.#now(entry.path);
        const title = entry.preview.title;
        if (now === null) {
          await insertion.cancel(entry);
          this.env.prompter.notice(
            `Shared Tasks: inserting section "${title}" into "${noteName(entry.path)}" had not finished, and the note is no longer there. Nothing was inserted.`,
          );
          return;
        }
        if (insertionWritten(entry, now.text)) {
          await this.#run(entry, flow, true);
          return;
        }
        this.#step(flow, "writing");
        flow.unresolved(
          `inserting section "${title}" into this note did not finish before Obsidian closed; nothing was written yet. Continue shows its preview again.`,
          () => this.#continueInsertion(entry, flow),
          "unfinished",
        );
        this.#unresolvedSoon();
      },
      () => undefined,
    );
  }

  /**
   * "Continue" of an unfinished insertion: its preview again, at the place
   * chosen before; approved, the same insertion runs; cancelled, it ends
   * and writes nothing.
   */
  async #continueInsertion(entry: InsertionEntry, flow: Flow): Promise<Reconciled> {
    const { prompter, services } = this.env;
    const insertion = services.insertion();
    if (insertion === null) return "unknown";
    const current = (await insertion.current(entry.insertionId)) ?? entry;
    if (current.phase !== "prepared") return "settled";
    const title = current.preview.title;
    const dialog = prompter.insertPreview(current.preview, {
      where: `into "${noteName(current.path)}", where it was chosen before`,
      get placements() {
        return services.placements?.(fromBase64url(current.preview.resource)) ?? null;
      },
      subscribe: (listener) => services.onPlacements?.(listener) ?? (() => undefined),
    });
    this.#showing(flow, dialog, "the insert preview");
    const approved = await dialog.result;
    flow.showing(null);
    if (!approved) {
      await insertion.cancel(current);
      prompter.notice(`Shared Tasks: section "${title}" was not inserted. Nothing was written.`);
      return "settled";
    }
    const now = await this.#now(current.path);
    if (now === null) {
      await insertion.cancel(current);
      prompter.notice(
        "Shared Tasks: the note was deleted while the preview was open. Nothing was inserted.",
      );
      return "settled";
    }
    if (now.composing) {
      prompter.notice(invalidationText("composing", "inserted"));
      this.#step(flow, "writing");
      return "unknown";
    }
    await this.#run(current, flow);
    return flow.unknown ? "unknown" : "settled";
  }

  /**
   * What became of an insertion, said with "Open" (LFCP-03-016), and the
   * note indexed and passed when it was written: an open note through its
   * editor, a closed one through its file (the host's guarded read-modify-
   * write), as a share passes it.
   */
  async #inserted(
    result: InsertResult,
    entry: InsertionEntry,
    preview: InsertPreview,
    again = false,
  ): Promise<void> {
    const { notes, prompter, services } = this.env;
    this.#notifyInsertion(result);
    // Nothing was written: the insertion ends (a later insert is a new one).
    if (result.kind === "stale") await services.insertion()?.cancel(result.entry);
    if (result.kind !== "inserted") return;
    const path = entry.path;
    const after = await this.#now(path);
    let line = entry.target.line;
    if (after !== null) {
      services.indexed(path, after.text);
      if (after.open) services.pass(path);
      else services.pass(path, after.text);
      line = headingAfter(after.text, entry, line);
    }
    const text = `Shared Tasks: section "${preview.title}" inserted into "${noteName(path)}".${again ? " Inserting had not finished before." : ""}`;
    prompter.notice(text, { label: "Open", run: () => void notes.goToLine(path, line) });
    prompter.announce(text);
  }

  /**
   * An insertion whose result was unknown, run again from its journal: the
   * same insertion ID, which finds its block if it was written (D12).
   */
  async #reconcileInsertion(entry: InsertionEntry, preview: InsertPreview): Promise<Reconciled> {
    const insertion = this.env.services.insertion();
    if (insertion === null) return "unknown";
    const current = (await insertion.current(entry.insertionId)) ?? entry;
    let result: InsertResult;
    try {
      result = await insertion.run(current);
    } catch (e) {
      this.env.prompter.notice(
        `Shared Tasks: whether section "${preview.title}" was inserted is still not known (${errorText(e)}). Nothing new was inserted.`,
      );
      return "unknown";
    }
    await this.#inserted(result, current, preview);
    return "settled";
  }

  /** What became of an insertion, when there is something to say. */
  #notifyInsertion(r: InsertResult): void {
    if (r.kind === "stale")
      this.env.prompter.notice(
        "Shared Tasks: the note changed where the section would go. Insert it again.",
      );
    else if (r.kind === "inserted" && (r.entry.warnings ?? []).length > 0)
      this.env.prompter.notice(
        "Shared Tasks: section inserted. The private text after it, up to the next heading, stays private but moves with its heading.",
      );
  }

  /**
   * Creates the shared section of an approved preview (LFCP-02-050): the
   * creation is journaled first, then runs; an interrupted one goes on
   * at the next start.
   */
  async #createSection(
    path: string,
    markdown: string,
    preview: SharePreview,
    /** The note held by the flow: a rename before the note is bound is followed (LFCP-03-002). */
    target: NoteTarget,
    flow: Flow,
  ): Promise<void> {
    const creation = this.env.services.creation();
    // The descriptors' guard again, as the effect starts.
    if (this.#refused(SHARE_NEEDS, creation === null, SHARE_AGAIN) || creation === null) return;
    const entry = await creation.prepare(path, markdown, preview);
    await this.#settle(entry, target, flow);
  }

  /**
   * A creation a restart interrupted goes on from its journal (SSP §12.2),
   * its result said. It holds its note like a share does (D12), so a share
   * started meanwhile on that note waits for its result; when the note is
   * already held, it runs as before, unreserved.
   */
  resumeCreation(entry: CreationEntry): Promise<void> {
    return this.#oneFlow(
      entry.path,
      "share",
      async (target, flow) => {
        flow.stage = `section "${entry.preview.title}" is being shared from this note. Its result shows when it is done.`;
        this.#step(flow, "creating");
        await this.#settle(entry, target, flow);
      },
      () => void this.#settle(entry),
    );
  }

  /**
   * Runs a creation and says what became of it. An unknown outcome keeps
   * the flow's note reserved (D12) until a reconcile of the same operation
   * settles it; without a flow it is left to its journal.
   */
  async #settle(
    entry: CreationEntry,
    target?: NoteTarget,
    flow?: Flow,
  ): Promise<"settled" | "unknown"> {
    const running = this.#outcome(entry, target);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((r) => {
      timer = setTimeout(() => r("late"), this.#creationDeadlineMs);
    });
    const first = await Promise.race([running, late]);
    clearTimeout(timer);
    if (first === "late") {
      await this.#notAnswering(entry, running, target, flow);
      return "unknown";
    }
    const out = first;
    if (out.kind === "known") {
      this.#notifyCreation(entry, out.result);
      return "settled";
    }
    const title = entry.preview.title;
    if (out.error instanceof CreationKeyMismatch) {
      // LFCP-03-063: the Resource can never be written; nothing is done until the user chooses.
      if (flow !== undefined)
        flow.problem = `This section cannot be shared: ${KEY_MISMATCH_PROBLEM} Check the result offers to share it again.`;
      this.env.prompter.notice(
        `Shared Tasks: section "${title}" cannot be shared as it is: ${KEY_MISMATCH_PROBLEM} Check the result on this note offers to share it again; nothing changes until you choose.`,
      );
      this.#unresolvedSoon();
      flow?.unresolved(
        `section "${title}" cannot be shared as it is. Check the result offers to share it again.`,
        () => this.#reconcileCreation(entry, target, flow),
      );
      return "unknown";
    }
    this.env.prompter.notice(
      `Shared Tasks: creating section "${title}" stopped (${errorText(out.error)}); its result is not known yet. Share section… on this note checks it again and creates nothing new; it also goes on at the next start.`,
    );
    this.#unresolvedSoon();
    flow?.unresolved(
      `the result of sharing section "${title}" from this note is being checked. Nothing new is created.`,
      () => this.#reconcileCreation(entry, target, flow),
    );
    return "unknown";
  }

  /**
   * A creation that has not returned in its time (LFCP-03-058): said, with
   * the step the journal reached, and held as an unknown outcome. The first
   * run goes on and stays in `#runs`: "Check the result" joins it (never a
   * second run of the operation, which is not re-entrant), within its own
   * deadline, and says it is still running. Its late result is told once,
   * and settles the flow.
   */
  async #notAnswering(
    entry: CreationEntry,
    running: Promise<CreationOutcome>,
    target?: NoteTarget,
    flow?: Flow,
  ): Promise<void> {
    const title = entry.preview.title;
    const creation = this.env.services.creation();
    const at = (await creation?.current(entry.operationId).catch(() => undefined))?.phase;
    let told = false;
    const tell = (out: CreationOutcome): boolean => {
      if (told || out.kind !== "known") return false;
      told = true;
      this.#notifyCreation(entry, out.result);
      return true;
    };
    this.env.prompter.notice(
      `Shared Tasks: creating section "${title}" is taking too long and has not finished${at === undefined ? "" : ` (it stopped at "${at}")`}; its result is not known yet. Share section… on this note checks it again and creates nothing new; it also goes on at the next start.`,
    );
    this.#unresolvedSoon();
    flow?.unresolved(
      `the result of sharing section "${title}" from this note is being checked. Nothing new is created.`,
      async () => {
        if (told) return "settled";
        const out = await this.#joined(
          (await creation?.current(entry.operationId)) ?? entry,
          target,
        );
        if (out.kind === "unknown") {
          this.env.prompter.notice(
            `Shared Tasks: the result of creating section "${title}" is still not known (${out.error === undefined ? "it is still running" : errorText(out.error)}). Nothing new was created.`,
          );
          return "unknown";
        }
        tell(out);
        return "settled";
      },
    );
    void running.then((out) => {
      if (tell(out)) flow?.close();
    });
  }

  /**
   * A run of the creation (started, or the one under way) within the creation
   * deadline; a run still going then answers unknown without an error, and
   * keeps its place in `#runs`.
   */
  async #joined(entry: CreationEntry, target?: NoteTarget): Promise<CreationOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<CreationOutcome>((r) => {
      timer = setTimeout(() => r({ kind: "unknown", error: undefined }), this.#creationDeadlineMs);
    });
    try {
      return await Promise.race([this.#outcome(entry, target), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A creation whose outcome was unknown, run again from its journal: the same operation ID (D12). */
  async #reconcileCreation(
    entry: CreationEntry,
    target?: NoteTarget,
    flow?: Flow,
  ): Promise<Reconciled> {
    const creation = this.env.services.creation();
    if (creation === null) return "unknown";
    const current = (await creation.current(entry.operationId)) ?? entry;
    const out = await this.#joined(current, target);
    if (out.kind === "unknown" && out.error instanceof CreationKeyMismatch)
      return this.#offerShareAgain(current, target, flow);
    if (out.kind === "unknown") {
      this.env.prompter.notice(
        `Shared Tasks: the result of creating section "${entry.preview.title}" is still not known (${out.error === undefined ? "it is still running" : errorText(out.error)}). Nothing new was created.`,
      );
      return "unknown";
    }
    this.#notifyCreation(current, out.result);
    return "settled";
  }

  /**
   * LFCP-03-063: a creation whose Resource can never be written (its epoch key
   * is not its Genesis's), found again by "Check the result". Only for a
   * Resource nobody but this device has, and never by itself: the user
   * chooses "Share again", which journals a new creation of the note's
   * current text under a new operation ID, then discards the unusable
   * Resource on this device. The note's text is not touched until the new
   * creation binds it. Anything else is left as it is.
   */
  async #offerShareAgain(
    entry: CreationEntry,
    target?: NoteTarget,
    flow?: Flow,
  ): Promise<Reconciled> {
    const { prompter, services } = this.env;
    const creation = services.creation();
    if (creation === null) return "unknown";
    const title = entry.preview.title;
    if (!(await creation.canShareAgain(entry))) {
      prompter.notice(
        `Shared Tasks: section "${title}" cannot be shared: its encryption key does not match its section. Nothing was discarded or replaced, because this section may already be shared or its markers may be in the note. Copy the section's text somewhere safe, remove its markers from the note (or detach it), and share it again as a new section; if others use it, ask them first.`,
      );
      return "unknown";
    }
    const ask = prompter.confirm({
      title: "Share again",
      message: `Section "${title}" cannot be shared: ${KEY_MISMATCH_PROBLEM} It was never shared with anyone, so no one else loses anything. Share again throws away that unused copy on this device and shares the section from this note as it is now, as a new section. This note's text is not changed until the new section is created.`,
      action: "Share again",
      destructive: false,
    });
    this.#showing(flow, ask, "the choice to share again", "creating");
    const chosen = await ask.result;
    flow?.showing(null);
    if (!chosen) return "unknown";
    const path = target === undefined ? entry.path : target.path;
    const now = path === null ? null : await this.#now(path);
    if (path === null || now === null) {
      prompter.notice("Shared Tasks: the note is gone. Nothing was shared again.");
      return "unknown";
    }
    if (now.composing) {
      prompter.notice(invalidationText("composing", "shared"));
      return "unknown";
    }
    let again = revalidate(now.text, entry.preview);
    if (again.kind === "changed") {
      if (again.preview === null) {
        prompter.notice("Shared Tasks: the section's heading is gone. Nothing was shared again.");
        return "unknown";
      }
      // Not what was approved: the new range is reviewed first.
      const dialog = prompter.sharePreview(
        again.preview,
        "The note changed since the first share. Review the section again.",
      );
      this.#showing(flow, dialog, `the share preview of "${again.preview.title}"`, "creating");
      const approved = await dialog.result;
      flow?.showing(null);
      if (!approved) return "unknown";
      again = revalidate((await this.#now(path))?.text ?? now.text, again.preview);
      if (again.kind === "changed" || again.preview === null) {
        prompter.notice(
          "Shared Tasks: the note changed while the preview was open. Nothing was shared again.",
        );
        return "unknown";
      }
    }
    const swapped = await creation.shareAgain(entry, now.text, again.preview);
    if (swapped === null) {
      prompter.notice(
        `Shared Tasks: section "${title}" can no longer be shared again (it changed meanwhile). Nothing was replaced.`,
      );
      return "unknown";
    }
    services.registryChanged();
    if (flow !== undefined) flow.problem = null;
    prompter.notice(
      swapped.old.discarded === "kept"
        ? `Shared Tasks: the unusable copy of section "${title}" could not be deleted and stays on this device, hidden and unused; sharing it again. Nothing more is asked about it.`
        : `Shared Tasks: the unusable copy of section "${title}" was discarded on this device; sharing it again.`,
    );
    return this.#settle(swapped.fresh, target, flow);
  }

  /** A creation's typed outcome: hosted, local, stale, failed or cancelled; unknown when it threw. */
  #outcome(entry: CreationEntry, target?: NoteTarget): Promise<CreationOutcome> {
    // LFCP-03-058: one run per operation at a time. A resume at the host's start, a
    // check of an unknown result or the share's own flow join the run under way: two
    // runs of one creation made its Resource at once, and it could never be written.
    const running = this.#runs.get(entry.operationId);
    if (running !== undefined) return running;
    const run = this.#finish(entry, target).then(
      (result): CreationOutcome => ({ kind: "known", result }),
      (error): CreationOutcome => ({ kind: "unknown", error }),
    );
    const started: Promise<CreationOutcome> = run.finally(() => {
      if (this.#runs.get(entry.operationId) === started) this.#runs.delete(entry.operationId);
    });
    this.#runs.set(entry.operationId, started);
    return started;
  }

  /** Runs a creation; with the flow's held note, at that note's path at each write. */
  async #finish(entry: CreationEntry, target?: NoteTarget): Promise<CreationResult> {
    const { notes, services } = this.env;
    const creation = services.creation();
    if (creation === null) throw new Error("the section creation is not running");
    const result = await creation.run(entry, target === undefined ? undefined : () => target.path);
    if (result.kind === "stale") await creation.cancel(result.entry);
    // LFCP-03-011: a Resource created, or discarded with its stale creation.
    services.registryChanged();
    if (result.kind === "hosted" || result.kind === "local") {
      await services.watch(fromKey(entry.resource));
      // Where the creation bound it: the renamed note's path, if it moved.
      const path = result.entry.path;
      const open = notes.capture(path);
      const text = open?.text ?? (await notes.read(path));
      if (text !== null) {
        services.indexed(path, text);
        if (open !== null) services.pass(path);
        else services.pass(path, text);
      }
    }
    return result;
  }

  /**
   * "Share section…" (LFCP-02-049): the heading at or above the cursor
   * proposes the range, or an exact eligible selection is the range
   * (LFCP-03-009); the preview shows exactly what would be shared. An
   * approved preview is revalidated against the note as it is then, read
   * through the notes port at the held note's path (UX02, T3): a changed
   * heading range is shown again; a changed selection is not widened, it
   * is refused. Returns the approved preview with the path and text it was
   * checked on, or null.
   */
  async #shareSection(
    at: CapturedTarget,
    target: NoteTarget,
    flow: Flow,
    whole: boolean,
  ): Promise<{ preview: SharePreview; path: string; text: string } | null> {
    const { prompter, services } = this.env;
    // V3: no new shared section from a device where sections are read-only;
    // none while starting or without a server (the descriptors' guard).
    if (this.#refused(SHARE_NEEDS, services.creation() === null, SHARE_AGAIN)) return null;
    if (!(await this.#startable(at, target, "shared"))) return null;
    const md = at.text;
    const scope = shareScope(md, at.cursorLine, at.selections);
    let range: ShareRange;
    let exact = false;
    if (scope.kind === "no-heading") {
      prompter.notice("Shared Tasks: put the cursor on or under a heading to share its section.");
      return null;
    } else if (scope.kind === "ineligible") {
      // The selection's Tasks are 0.1 shared ones: the explicit import of exactly that range (053).
      if (scope.reason === "legacy-tasks" && scope.range !== null) {
        await this.#importFlow(at, target, scope.range, preflight(md, scope.range).title, flow);
        return null;
      }
      const reason = selectionReasonText(scope.reason, scope.line);
      if (scope.fallback === null) {
        prompter.notice(`Shared Tasks: ${reason}`);
        prompter.announce(`Shared Tasks: ${reason}`);
        return null;
      }
      // S1, S2: never widened by itself; the whole section is the user's explicit choice.
      if (!whole) {
        const ask = prompter.confirm({
          title: "Share section",
          message: `${reason} You can share the whole section under its heading instead; its preview opens first.`,
          action: SHARE_WHOLE_SECTION,
          destructive: false,
        });
        this.#showing(flow, ask, "the choice to share the whole section");
        const chosen = await ask.result;
        flow.showing(null);
        if (!chosen) return null;
      }
      range = scope.fallback;
    } else {
      range = scope.range;
      exact = scope.kind === "exact";
    }
    let preview = preflight(md, range);
    // 0.1 shared Tasks in the range, and nothing else in the way: the explicit import (053).
    if (
      preview.problems.length > 0 &&
      preview.problems.every((p) => p.code === "LEGACY_SHARED_TASKS")
    ) {
      await this.#importFlow(at, target, range, preview.title, flow);
      return null;
    }
    let note: string | undefined;
    for (;;) {
      const dialog = prompter.sharePreview(preview, note);
      this.#showing(flow, dialog, `the share preview of "${preview.title}"`);
      const approved = await dialog.result;
      flow.showing(null);
      if (!approved) return null;
      // The held note, wherever it is now (renamed: its new path); never the active editor's.
      const path = target.path;
      const now = path === null ? null : await this.#now(path);
      if (path === null || now === null) {
        prompter.notice(
          "Shared Tasks: the note was deleted while the preview was open. Nothing was shared.",
        );
        return null;
      }
      const why = invalidation(at, path, now, false);
      if (why !== null) {
        prompter.notice(invalidationText(why, "shared"));
        return null;
      }
      const again = revalidate(now.text, preview);
      if (again.kind !== "changed") return { preview: again.preview, path, text: now.text };
      if (exact) {
        prompter.notice(
          "Shared Tasks: the note changed while the preview was open. Nothing was shared; select the lines and share again.",
        );
        return null;
      }
      if (again.preview === null) {
        prompter.notice("Shared Tasks: the section's heading is gone. Nothing was shared.");
        return null;
      }
      preview = again.preview;
      note = "The note changed while the preview was open. Review the section again.";
    }
  }

  /**
   * Imports a range with 0.1 shared Tasks into a new shared section (053,
   * 054): the preview and the user's choices first, then the journaled
   * creation; the note's refs are replaced only once the copy is durable.
   */
  async #importFlow(
    at: CapturedTarget,
    target: NoteTarget,
    range: ShareRange,
    title: string,
    flow?: Flow,
  ): Promise<void> {
    const { prompter, services } = this.env;
    const creation = services.creation();
    if (this.#refused(SHARE_NEEDS, creation === null) || creation === null) return;
    const md = at.text;
    // The sources as this device holds them now (0.1 collaborations).
    const sources = new Map<string, LegacySource>();
    for (const p of scanRefs(md).projections) {
      if (p.taskLine <= range.headingLine || p.taskLine > range.lastLine) continue;
      const key = `${toBase64url(p.resourceId)}#${p.objectId}`;
      if (sources.has(key)) continue;
      try {
        const found = await services.legacySource(p.resourceId as ResourceId, p.objectId);
        if (found !== undefined) sources.set(key, found);
      } catch {
        // Not on this device, or another profile: the preflight blocks it.
      }
    }
    const source = (resource: string, objectId: string) => sources.get(`${resource}#${objectId}`);
    const preview = legacyPreflight(md, range, source);
    const dialog = prompter.importPreview(title, preview);
    this.#showing(flow, dialog, `the import preview of "${title}"`);
    const chosen = await dialog.result;
    flow?.showing(null);
    if (chosen === null) return;
    const path = target.path;
    const now = path === null ? null : await this.#now(path);
    if (path === null || now === null) {
      prompter.notice(
        "Shared Tasks: the note was deleted while the preview was open. Nothing was imported.",
      );
      return;
    }
    // The range's lines are the captured note's: a changed note is imported from a new preview.
    const why = invalidation(at, path, now);
    if (why !== null) {
      prompter.notice(invalidationText(why, "imported"));
      return;
    }
    if (flow !== undefined) flow.stage = `section "${title}" is being imported from this note.`;
    this.#step(flow, "creating");
    // The descriptors' guard again, as the effect starts.
    if (this.#refused(SHARE_NEEDS, services.creation() === null)) return;
    let entry: CreationEntry;
    try {
      entry = await creation.prepareImport(path, now.text, range, source, chosen);
    } catch (e) {
      prompter.notice(
        `Shared Tasks: the import cannot start (${e instanceof Error ? e.message : String(e)}). Nothing changed.`,
      );
      return;
    }
    await this.#settle(entry, target, flow);
  }

  /**
   * "Restore note before section import" (054): the latest import in this
   * note gets its original view back; edits made on the new section since
   * are kept beside it. The new section itself, and any invitation to it,
   * stay as they are.
   */
  async restoreImport(path: string): Promise<void> {
    const { prompter, services } = this.env;
    const creation = services.creation();
    if (creation === null) return;
    const last = (await creation.imports(path)).at(-1);
    if (last === undefined) {
      prompter.notice("Shared Tasks: no section import to restore in this note.");
      return;
    }
    const out = await creation.rollback(last);
    prompter.notice(
      out.kind === "restored"
        ? "Shared Tasks: the note shows its content from before the import again. The new shared section still exists; to stop sharing it, remove people's access."
        : out.kind === "beside"
          ? "Shared Tasks: the section was edited since the import, so the content from before is added after it for comparison. Nothing was removed."
          : "Shared Tasks: this import cannot be restored here (its section is not in the note).",
    );
  }

  /**
   * "Detach this section" (§10, MS10-detach): after a confirmation, the
   * section under the cursor loses every binding in this note and keeps its
   * text as private text; this note's projection base is dropped. Nothing
   * is published: the shared section, other notes and collaborators are
   * unchanged.
   */
  async detachSectionAt(at: TargetCapture): Promise<void> {
    const why = captureRefusal(at);
    if (why !== null) {
      this.env.prompter.notice(invalidationText(why, "detached"));
      return;
    }
    // The note held while the confirmation is open: a rename is followed, a deletion writes nothing.
    const held = this.#targets.hold(at.path);
    try {
      await this.#detach(at, held.target);
    } finally {
      held.release();
    }
  }

  async #detach(at: TargetCapture, target: NoteTarget): Promise<void> {
    const { prompter, notes, services } = this.env;
    const md = at.text;
    const found = detachAt(md, at.cursorLine);
    if (found === null) {
      prompter.notice("Shared Tasks: put the cursor in a shared section to detach it.");
      return;
    }
    // The descriptor's guard: no detach while the section loads on this device.
    if (!this.#loaded(found.section)) return;
    const ask = prompter.confirm({
      title: `Detach "${found.title}" in this note`,
      message: DETACH_CONFIRMATION,
      action: "Detach",
    });
    if (!(await ask.result)) return;
    const path = target.path;
    if (path === null) {
      prompter.notice("Shared Tasks: the note was deleted. Nothing was detached.");
      return;
    }
    // Checked again as the effect starts: the section may have been unloaded meanwhile.
    if (!this.#loaded(found.section)) return;
    let detached = false;
    await notes.edit(path, (current) => {
      // Only the note the confirmation was asked about.
      if (current !== md) return null;
      detached = true;
      // The one span that differs, so the editor keeps its cursor and scroll elsewhere.
      const next = found.markdown;
      let from = 0;
      while (from < current.length && from < next.length && current[from] === next[from]) from++;
      let tail = 0;
      while (
        tail < current.length - from &&
        tail < next.length - from &&
        current[current.length - 1 - tail] === next[next.length - 1 - tail]
      )
        tail++;
      return [{ from, to: current.length - tail, insert: next.slice(from, next.length - tail) }];
    });
    if (!detached) {
      prompter.notice("Shared Tasks: the note changed meanwhile. Nothing was detached; try again.");
      return;
    }
    // LFCP-03-011: the copy is no longer a placement of the section.
    services.indexed(path, found.markdown);
    const bases = services.bases();
    if (bases !== null)
      for (const id of await bases.projectionsOf(path)) {
        const b = await bases.load(id);
        if (b !== undefined && sameSection(b.locator.section, found.section)) {
          await bases.save(id, null);
          services.forget(sectionKey(found.section), id);
        }
      }
    services.pass(path);
    prompter.notice(
      `Shared Tasks: "${found.title}" is no longer shared in this note. The shared section itself is unchanged.`,
    );
  }

  /**
   * "Repair shared sections in this note" (062): broken boundaries with
   * their candidate lines, problems to locate, and sections whose base is
   * lost, compared. Nothing changes without the user's choice.
   *
   * The note is held while the dialog is open and while a choice it started
   * runs (LFCP-03-018, review of 009 F1): each choice writes, locates and
   * saves its base at the note's path at that moment, following a rename;
   * once the note is deleted it writes nothing.
   */
  async repairNote(at: TargetCapture, focus?: number): Promise<void> {
    const { prompter, services } = this.env;
    const refused = captureRefusal(at);
    if (refused !== null) {
      prompter.notice(invalidationText(refused, "changed"));
      return;
    }
    const model = services.model();
    const bases = services.bases();
    const journal = services.candidates();
    if (this.#refused({}, model === null || bases === null || journal === null)) return;
    if (model === null || bases === null || journal === null) return;
    const held = this.#targets.hold(at.path);
    let open: { dialog: SectionDialog<void>; running: ReadonlySet<Promise<void>> } | null = null;
    try {
      open = await this.#repair(at, held.target, model, bases, journal, focus);
    } finally {
      if (open === null) held.release();
    }
    const { dialog, running } = open;
    // Released once the dialog closed and every choice it started has settled.
    void dialog.result.then(() => Promise.allSettled([...running])).finally(() => held.release());
  }

  /** The repair dialog of `at`, held as `target`, and the choices it started that still run. */
  async #repair(
    at: TargetCapture,
    target: NoteTarget,
    model: ModelService,
    bases: BaseService,
    journal: CandidateService,
    focus: number | undefined,
  ): Promise<{ dialog: SectionDialog<void>; running: ReadonlySet<Promise<void>> }> {
    const { prompter, notes, services } = this.env;
    const md = at.text;
    // The problem a surface named (its line in this text) first; the others after it, as they are.
    const items = repairItems(md, await this.#heldKeys(at.path)).sort(
      (a, b) => Number(b.line === focus) - Number(a.line === focus),
    );
    const known = new Set<string>();
    /** The note's bases in the store's order: the engine matches them to sections in it (LFCP-03-047). */
    const stored: { readonly id: string; readonly base: StoredBase }[] = [];
    for (const id of await bases.projectionsOf(at.path)) {
      const b = await bases.load(id);
      if (b !== undefined) known.add(sectionKey(b.locator.section));
      if (b !== undefined) stored.push({ id, base: b });
    }
    const lost: (LostBase & {
      section: ParsedSection;
      snap: SectionSnapshot;
      block: string | null;
      taskLines: Record<string, string>;
      /** A Task the model cannot be drawn for here yet: no base is guessed for it. */
      /** A Task the model cannot be drawn for here: no base is guessed for it. */
      waiting: TaskWait | null;
      /** A section with a base holding pasted nodes (LFCP-03-047): its projection and the nodes compared. */
      pasted?: { readonly projectionId: string; readonly ids: readonly string[] };
      /** A section with a base whose nodes the note lacks (LFCP-03-057): its projection and the nodes. */
      absent?: { readonly projectionId: string; readonly ids: readonly string[] };
    })[] = [];
    const lines = md.split(/\r?\n/);
    for (const s of parseSections(md).sections) {
      const key = sectionKey(s.ref);
      if (known.has(key)) continue;
      const b64 = toBase64url(s.ref.resourceId);
      const snap = model.snapshot(b64, s.ref.sectionId);
      if (snap === undefined || !snap.ready) continue;
      // The engine's own test (LFCP-03-043): a section it keeps waiting is listed here.
      const tasks = (id: string) => ({ view: model.taskView(b64, id) });
      if (showsModel(md, s, snap, tasks)) continue;
      const block = renderSection(snap, s.ref, s.heading.level, {
        task: (id) => model.task(b64, id),
        placement: services.refPlacement(),
      });
      const local = lines.slice(s.startLine + 1, s.endLine).join("\n");
      const shared = block
        ?.replace(/\r?\n$/, "")
        .split("\n")
        .slice(2, -1)
        .join("\n");
      const taskLines: Record<string, string> = {};
      let waiting: TaskWait | null = null;
      // The reason that lasts longest wins: unreadable, then deleted, then loading.
      const rank: Record<TaskWait, number> = {
        "task-loading": 0,
        "task-deleted": 1,
        "task-unreadable": 2,
      };
      const wait = (why: TaskWait) => {
        if (waiting === null || rank[why] > rank[waiting]) waiting = why;
      };
      const walk = (nodes: ParsedSection["nodes"]): void => {
        for (const n of nodes) {
          if (n.kind === "task" && n.id !== null) {
            // The renderer leaves a line as it is for an object not here: no model line then.
            const view = model.taskView(b64, n.id);
            const line = comparableView(view)
              ? modelTaskLine(md, n.lines.from, n.id, tasks)
              : undefined;
            if (line !== undefined) taskLines[n.id] = line;
            // Not here yet: it loads. Deleted, or not a valid task: it will not by itself.
            else if (view === undefined) wait("task-loading");
            else if (view.status === "ready" && view.task?.lifecycle === "deleted")
              wait("task-deleted");
            else wait("task-unreadable");
          }
          walk(n.children);
        }
      };
      walk(s.nodes);
      lost.push({
        key,
        title: s.heading.title,
        lines: compare(local, shared ?? local),
        // Use the shared version whenever it can be written; Keep guesses no base for a Task it cannot compare.
        ...(shared === undefined ? { sharedUnavailable: true as const } : {}),
        ...(waiting === null ? {} : { taskWait: waiting }),
        section: s,
        snap,
        block,
        taskLines,
        waiting,
      });
    }
    // LFCP-03-047: a section with a base that holds nodes the user pasted,
    // shown otherwise than the model: only those nodes are compared. Each
    // occurrence of a section takes its base as the engine gives it one (the
    // first unused base of that section, in the store's order); one without
    // a base holds nothing. A section twice in the note, each occurrence
    // holding pasted nodes, cannot be told apart by its key: the repair says
    // so (review N1), it does not open empty.
    const used = new Set<string>();
    const holds: {
      s: ParsedSection;
      projectionId: string;
      stored: StoredBase;
      snap: SectionSnapshot;
      ids: string[];
    }[] = [];
    for (const s of parseSections(md).sections) {
      const k = stored.find((x) => !used.has(x.id) && sameSection(x.base.locator.section, s.ref));
      if (k === undefined) continue;
      used.add(k.id);
      if ((k.base.pasted ?? []).length === 0) continue;
      const b64 = toBase64url(s.ref.resourceId);
      const snap = model.snapshot(b64, s.ref.sectionId);
      if (snap === undefined || !snap.ready) continue;
      const ids = heldPasted(k.base, md, s, snap, (id) => ({ view: model.taskView(b64, id) }));
      if (ids.length > 0) holds.push({ s, projectionId: k.id, stored: k.base, snap, ids });
    }
    const twice = (key: string) => holds.filter((h) => sectionKey(h.s.ref) === key).length > 1;
    for (const h of holds)
      if (twice(sectionKey(h.s.ref)))
        items.push({
          kind: "locate",
          line: h.s.heading.line,
          message: PASTED_TWICE,
        });
    for (const { s, projectionId, snap, ids } of holds) {
      const key = sectionKey(s.ref);
      if (twice(key)) continue;
      const b64 = toBase64url(s.ref.resourceId);
      const tasks = (id: string) => ({ view: model.taskView(b64, id) });
      const note = markdownState(md, s).state;
      const local: string[] = [];
      const shared: string[] = [];
      const taskLines: Record<string, string> = {};
      let waiting: TaskWait | null = null;
      const lineOf = (nodes: ParsedSection["nodes"], id: string): number | undefined => {
        for (const n of nodes) {
          if (n.id === id) return n.lines.from;
          const found = lineOf(n.children, id);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      for (const id of ids) {
        const n = note.nodes[id];
        if (n?.kind !== "task") {
          local.push(n?.text ?? "");
          shared.push(snap.nodes[id]?.text ?? "");
          continue;
        }
        local.push(n.line ?? "");
        const view = model.taskView(b64, id);
        const at = lineOf(s.nodes, id);
        const line =
          comparableView(view) && at !== undefined ? modelTaskLine(md, at, id, tasks) : undefined;
        if (line !== undefined) {
          shared.push(line);
          taskLines[id] = line;
          continue;
        }
        // As for a lost base: the reason that lasts longest wins.
        const why: TaskWait =
          view === undefined
            ? "task-loading"
            : view.status === "ready" && view.task?.lifecycle === "deleted"
              ? "task-deleted"
              : "task-unreadable";
        const rank = ["task-loading", "task-deleted", "task-unreadable"];
        if (waiting === null || rank.indexOf(why) > rank.indexOf(waiting)) waiting = why;
      }
      lost.push({
        key,
        title: s.heading.title,
        lines: compare(local.join("\n"), shared.join("\n")),
        ...(waiting === null ? {} : { taskWait: waiting }),
        section: s,
        snap,
        block: null,
        taskLines,
        waiting,
        pasted: { projectionId, ids },
      });
    }
    // LFCP-03-057: a section with a base, lines of which the note lacks while
    // the shared version has them active, and the user did not delete them
    // (the pass would have sent a deletion: it keeps the section blocked as a
    // lost binding instead). A section already listed above keeps that entry.
    const absentUsed = new Set<string>();
    for (const s of parseSections(md).sections) {
      const key = sectionKey(s.ref);
      const k = stored.find(
        (x) => !absentUsed.has(x.id) && sameSection(x.base.locator.section, s.ref),
      );
      if (k === undefined) continue;
      absentUsed.add(k.id);
      if (lost.some((l) => l.key === key)) continue;
      const b64 = toBase64url(s.ref.resourceId);
      const snap = model.snapshot(b64, s.ref.sectionId);
      if (snap === undefined || !snap.ready) continue;
      const noteState = markdownState(md, s);
      const shown = noteState.state.nodes;
      const gone = Object.keys(k.base.state.nodes).filter((id) => {
        const m = snap.nodes[id];
        return shown[id] === undefined && m?.lifecycle === "active" && m.hidden !== true;
      });
      // A marker lost alone leaves the node's content as an unbound line: putting the node
      // back would duplicate it, and no diagnostic names it. Repair goes to that line. Other
      // unbound lines are the user's new text: they neither block nor are named.
      const loose = looseLines(k.base.state, gone, noteState.unbound, (l) => lines[l]);
      for (const u of loose.values())
        items.push({
          kind: "locate",
          line: u.line,
          message:
            "This line has lost its binding to a shared item, and the shared version still has that item. Undo the edit that removed the binding, or delete this line; nothing was deleted for anyone else.",
        });
      const ids = gone.filter((id) => !loose.has(id));
      if (ids.length === 0) continue;
      const missing: ComparedLine[] = ids.map((id) => {
        const n = k.base.state.nodes[id];
        return { kind: "shared", text: (n?.line ?? n?.text ?? "").split("\n")[0] ?? "" };
      });
      lost.push({
        key,
        title: s.heading.title,
        lines: missing,
        missing: true,
        section: s,
        snap,
        block: null,
        taskLines: {},
        waiting: null,
        absent: { projectionId: k.id, ids },
      });
    }
    const running = new Set<Promise<void>>();
    /** A choice of the dialog, on the note where it is now; nothing once it is deleted. */
    const onNote =
      <A extends unknown[]>(run: (path: string, ...args: A) => Promise<void>) =>
      (...args: A): Promise<void> => {
        const path = target.path;
        if (path === null) {
          prompter.notice("Shared Tasks: the note was deleted. Nothing was repaired.");
          return Promise.resolve();
        }
        const p = run(path, ...args);
        running.add(p);
        return p.finally(() => running.delete(p));
      };
    const dialog = prompter.repair(items, lost, {
      boundary: onNote(async (path, item, line) => {
        await notes.edit(path, (current) => {
          // Only on the note the candidates were computed for.
          if (current !== md) return null;
          return [boundaryRepair(current, item, line)];
        });
        services.pass(path);
        // The pane reads the note and its facts again: what the repair left is shown, not assumed.
        this.#changed();
      }),
      restore: onNote((path, item) => this.#restoreMarker(path, md, item)),
      // The repaired note, where it is now: never whichever note the tab shows.
      locate: (line) => {
        void onNote(async (path) => {
          await notes.goToLine(path, line);
        })();
      },
      shareMine: onNote(async (path, key) => {
        const l = lost.find((x) => x.key === key);
        if (l === undefined) return;
        if (l.waiting !== null) {
          // A Task whose shared version cannot be compared here: a base
          // without its line would let the model's fields replace the
          // note's once it can (review round 2). The note's text stays as it
          // is, kept by the engine; the comparison is offered again then.
          services.pass(path);
          prompter.notice(KEPT_WAITING[l.waiting]);
          this.#changed();
          return;
        }
        if (l.pasted !== undefined) {
          // Only the pasted nodes: the model's content is their base, so the
          // note's goes out as an edit (LFCP-03-047).
          // The model as compared when the dialog opened, never as it is
          // now: a collaborator's change since stays theirs (review F1).
          const { projectionId, ids } = l.pasted;
          const stored = await bases.load(projectionId);
          if (stored !== undefined)
            await bases.save(
              projectionId,
              pastedBase(stored, md, l.section, l.snap, "mine", ids, l.taskLines),
            );
          await journal.resolveCandidate(`pasted:${projectionId}`);
        } else
          await bases.save(
            newProjectionId(),
            adoptedBase(path, l.section.ref, l.snap, l.taskLines),
          );
        services.pass(path);
        // F2: no promise that the held edits go out; the pane and the card show what the next pass did.
        prompter.notice(
          "Shared Tasks: this note's version is kept as this copy's base. Whether its edits are sent shows in the pane and on the section card.",
        );
        this.#changed();
      }),
      // The nodes' lines are the engine's to write: a base that does not know them
      // has them as a collaborator's new nodes, rendered where the shared version has
      // them (LFCP-03-057). Nothing is sent: the note's other text is not touched.
      putBack: onNote(async (path, key) => {
        const l = lost.find((x) => x.key === key);
        if (l?.absent === undefined) return;
        const { projectionId, ids } = l.absent;
        const same = async () => (notes.capture(path)?.text ?? (await notes.read(path))) === md;
        if (!(await same())) {
          prompter.notice(
            "Shared Tasks: the note changed meanwhile. Nothing was put back; open the repair again.",
          );
          return;
        }
        const current = await bases.load(projectionId);
        if (current === undefined) {
          prompter.notice(
            "Shared Tasks: this copy's state changed meanwhile. Nothing was put back; open the repair again.",
          );
          return;
        }
        // Again right before the base is saved: the awaits above let the note change.
        if (!(await same())) {
          prompter.notice(
            "Shared Tasks: the note changed meanwhile. Nothing was put back; open the repair again.",
          );
          return;
        }
        await bases.save(projectionId, withoutNodes(current, ids));
        services.pass(path);
        this.#changed();
        prompter.notice(
          `Shared Tasks: ${ids.length === 1 ? "the missing line is" : "the missing lines are"} being put back from the shared version.`,
        );
      }),
      useShared: onNote(async (path, key) => {
        const l = lost.find((x) => x.key === key);
        if (l === undefined) return;
        if (l.pasted !== undefined) {
          // The pasted nodes as the note shows them are their base: the next
          // pass renders the model over them. The note's text is kept first,
          // and only the note the comparison was made on (LFCP-03-047).
          const changed = async () => {
            if ((notes.capture(path)?.text ?? (await notes.read(path))) === md) return false;
            prompter.notice(
              "Shared Tasks: the note changed meanwhile. Nothing was replaced; open the repair again.",
            );
            return true;
          };
          if (await changed()) return;
          await journal.putCandidate({
            candidateId: `repair:${crypto.randomUUID()}`,
            projectionId: `repair:${path}`,
            sectionKey: sectionKey(l.section.ref),
            reason: "base-unknown",
            sourceText: lines.slice(l.section.heading.line, l.section.endLine + 1).join("\n"),
          });
          const { projectionId, ids } = l.pasted;
          const stored = await bases.load(projectionId);
          if (stored === undefined) {
            prompter.notice(PASTED_GONE);
            return;
          }
          // Again right before the base is saved: the awaits above let the
          // note change, and a base of its older text would send the newer
          // as an edit (review F3).
          if (await changed()) return;
          await bases.save(projectionId, pastedBase(stored, md, l.section, l.snap, "shared", ids));
          await journal.resolveCandidate(`pasted:${projectionId}`);
          services.pass(path);
          this.#changed();
          prompter.notice(
            "Shared Tasks: this section shows the shared version now. Your previous text is kept as a recovery copy on this device.",
          );
          return;
        }
        const block = l.block;
        if (block === null) {
          prompter.notice(
            "Shared Tasks: the shared version cannot be written here yet. Nothing was replaced.",
          );
          return;
        }
        // The note's text first, as a recovery copy kept on this device.
        await journal.putCandidate({
          candidateId: `repair:${crypto.randomUUID()}`,
          projectionId: `repair:${path}`,
          sectionKey: sectionKey(l.section.ref),
          reason: "base-unknown",
          sourceText: lines.slice(l.section.heading.line, l.section.endLine + 1).join("\n"),
        });
        let replaced = false;
        await notes.edit(path, (current) => {
          if (current !== md) return null;
          replaced = true;
          return [sharedVersionChange(current, l.section, block)];
        });
        if (!replaced) {
          prompter.notice(
            "Shared Tasks: the note changed meanwhile. Nothing was replaced; open the repair again.",
          );
          return;
        }
        // No base is stored here: the next pass seeds one once the note shows
        // the model (CM11). A base saved now could meet the editor's old text
        // and send the very edit the user chose to drop.
        services.pass(path);
        this.#changed();
        prompter.notice(
          "Shared Tasks: this section shows the shared version now. Your previous text is kept as a recovery copy on this device.",
        );
      }),
    });
    return { dialog, running };
  }

  /**
   * The details card of a section (LFCP-02-059), opened from its badge or
   * the palette. Its actions run on the section's Resource after checking
   * it is still here (stable ref, revalidated).
   */
  async openCard(key: string, title: string): Promise<void> {
    const { prompter, notes, services } = this.env;
    if (this.#refused({}, false)) return;
    const content = await services.cardContent(key, title);
    if (content === null) {
      prompter.notice("Shared Tasks: this section is still loading. Try again in a moment.");
      return;
    }
    const R = fromKey(key.slice(0, key.indexOf("#")));
    const section = { key, title };
    const still = (run: (c: ResourceCommands) => Promise<void>) => () => {
      const commands = services.commands();
      if (!services.known(key) || commands === null) {
        prompter.notice("Shared Tasks: this section is no longer on this device.");
        return;
      }
      void run(commands);
    };
    const conflicts = services.recoveryItems(key);
    const kept = await this.#keptCopies(key);
    const held = content.held[0];
    // Inviting is offered by the validated access (060), never by default:
    // the descriptor the pane reads decides, on the card's own facts
    // (LFCP-03-013). Blocked, it is shown with its reason (A5, D10).
    const invite = DESCRIPTORS.invite.availability(this.#cardFacts(key, title, content));
    const actions: CardAction[] = [
      // Conflicts are resolved one by one, by the user (061).
      ...(conflicts.length > 0
        ? [
            {
              label: "Review conflicts…",
              run: () =>
                void this.#fromCard("review-conflicts", { section }, () =>
                  this.reviewConflicts(key, title),
                ),
            },
          ]
        : []),
      ...(invite.kind === "hidden"
        ? []
        : [
            {
              label: "Invite collaborator…",
              ...(invite.kind === "disabled" ? { disabled: invite.reason } : {}),
              run: still((c) => this.#fromCard("invite", { section }, () => c.inviteTo(R))),
            },
          ]),
      // F-04: where edits are held, and the repair of that note.
      ...(held === undefined
        ? []
        : [
            {
              label: `Go to line ${held.line + 1}`,
              run: () =>
                void this.#fromCard(
                  "go-to-problem",
                  { section, at: { path: held.path, line: held.line } },
                  () => this.goToLine(held.path, held.line),
                ),
            },
            ...(["unsupported", "binding", "boundary", "base-unknown"].includes(held.cause)
              ? [
                  {
                    label: "Repair shared sections in this note",
                    run: () =>
                      void this.#fromCard(
                        "repair-sections",
                        { section, at: { path: held.path, line: held.line } },
                        () => this.repairAt(held.path),
                      ),
                  },
                ]
              : []),
          ]),
      {
        label: "Resource status",
        run: () =>
          void this.#fromCard("resource-status", { section }, () => this.resourceStatus(key)),
      },
      // LFCP-03-012: the card is one of the pane's entries.
      ...(this.#openPane === null ? [] : [{ label: PANE_LINK, run: this.#openPane }]),
      // Text kept on this device after a refusal (a local copy, never applied by itself).
      ...(kept.length > 0
        ? [
            {
              label: `Discard ${kept.length === 1 ? "the local copy" : `${kept.length} local copies`}…`,
              run: () =>
                void this.#fromCard("discard-local-copy", { section }, () =>
                  this.discardLocalCopies(key, title),
                ),
            },
          ]
        : []),
    ];
    this.#card?.handle.close();
    let handle: CardHandle | null = null;
    const rows: CardRowActions = {
      // A local alias: a label of this device for an identity, never sent.
      alias: (id, label) => {
        void prompter.alias(label.startsWith("Member ") ? "" : label).then(async (name) => {
          if (name === null || !(await services.setAlias(id, name))) return;
          const fresh = await services.cardContent(key, title);
          if (fresh !== null) handle?.update(fresh);
        });
      },
      // 060: confirmed first; queued is pending until the server commits it.
      // V3: no access change from a device where sections are read-only.
      ...(this.#mayNot({ writes: true })
        ? {}
        : {
            remove: (principal: string, label: string) => {
              const ask = prompter.confirm({
                title: `Remove access: ${label}`,
                message: REMOVE_CONFIRMATION,
                action: "Remove access",
              });
              void ask.result.then(async (yes) => {
                if (!yes) return;
                let outcome: RevokeOutcome | null | undefined;
                try {
                  outcome = await services.revokeAccess(R, principal);
                } catch {
                  // Outcome unknown: the access list says whether a change is pending.
                  outcome = undefined;
                }
                if (outcome === null) return;
                const aliases = await services.aliases();
                const message =
                  outcome === undefined
                    ? "Removing access failed. The access list shows whether a change is pending."
                    : revokeMessage(
                        outcome,
                        (hex) => aliases[hex.slice(0, 8)] ?? `Member ${hex.slice(0, 8)}`,
                      );
                prompter.notice(`Shared Tasks: ${message}`);
                const fresh = await services.cardContent(key, title);
                if (fresh !== null && handle !== null && this.#card?.handle === handle)
                  handle.update(fresh);
              });
            },
          }),
    };
    handle = prompter.card(
      content,
      actions,
      () => {
        if (this.#card !== null && this.#card.handle === handle) this.#card = null;
      },
      rows,
    );
    this.#card = { key, title, handle };
  }

  /** The open card, redrawn with its section's facts now (its status changed). */
  async refreshCard(): Promise<void> {
    const card = this.#card;
    if (card === null) return;
    const content = await this.env.services.cardContent(card.key, card.title);
    if (content !== null) card.handle.update(content);
  }

  /**
   * Why "Invite collaborator…" is not offered for section `key` now, or null
   * when it is (I4, LFCP-03-041): the invite descriptor on the card's own
   * facts (the access list read now, the status of the last status pass),
   * as the pane and the card read it. The executor asks before the role
   * dialog, so the palette offers no invitation the pane would not. A
   * section whose status is not known yet waits.
   */
  async inviteRefusal(key: string): Promise<string | null> {
    const content = await this.env.services.cardContent(key, "");
    if (content === null) return INVITE_WAITS;
    const invite = DESCRIPTORS.invite.availability(this.#cardFacts(key, "", content));
    if (invite.kind === "disabled") return invite.reason;
    return invite.kind === "enabled" ? null : INVITE_WAITS;
  }

  /** The card's facts as the action descriptors read them: the pane's, for this section alone. */
  #cardFacts(key: string, title: string, content: SectionCard): ActionFacts {
    const { services } = this.env;
    return sectionFacts(
      {
        key,
        sharedTitle: title,
        localAlias: null,
        placements: null,
        view: content.view,
        canInvite: content.access?.invite ?? null,
        // Removing access: the access list's guard, as the pane reads it (LFCP-03-019).
        ...(content.access === undefined
          ? {}
          : { canRemove: content.access.remove, removeNote: content.access.removeNote }),
        ...(content.hosting === undefined ? {} : { hosting: content.hosting }),
      },
      {
        unavailable: services.unavailable(),
        starting: false,
        readOnly: services.readOnly(),
        server: services.server().trim() !== "",
      },
    );
  }

  /** "Go to line N" of a held copy (the card, F-04): note `path` opened at `line`. */
  async goToLine(path: string, line: number): Promise<void> {
    await this.env.notes.goToLine(path, line);
  }

  /**
   * "Go to the problem" of section `key` (UX §3, `go-to-problem`): the
   * line of the copy that holds the most edits, in its note, as the card
   * offers it. False when no copy holds edits (the host then goes to the
   * next problem in the note).
   */
  async goToHeld(key: string, prefer?: string): Promise<boolean> {
    // The copy in the note the surface is on first, then the one holding the most edits.
    const held = [...this.env.services.held(key)].sort(
      (a, b) =>
        Number(b.path === prefer) - Number(a.path === prefer) || (b.count ?? 1) - (a.count ?? 1),
    )[0];
    if (held === undefined) return false;
    await this.env.notes.goToLine(held.path, held.line);
    return true;
  }

  /** "Resource status" of section `key` (technical details): its Resource, still on this device. */
  async resourceStatus(key: string): Promise<void> {
    const { prompter, services } = this.env;
    const commands = services.commands();
    if (!services.known(key) || commands === null) {
      prompter.notice("Shared Tasks: this section is no longer on this device.");
      return;
    }
    await commands.resourceStatusOf(fromKey(key.slice(0, key.indexOf("#"))));
  }

  /**
   * "Continue" (UX §3, `continue-flow`): flow `generation` brought forward,
   * its open dialog or where it stands; one whose result is unknown is
   * checked (the same operation, D12). A flow that closed meanwhile (a late
   * click) is left alone: false.
   */
  async continueFlow(generation: number): Promise<boolean> {
    const flow = this.#flows.byGeneration(generation);
    if (flow === undefined) return false;
    await this.#reveal(flow);
    return true;
  }

  /** "Open shared section details" (064): the card of the section under the cursor. */
  openCardAt(target: TargetCapture): void {
    const at = sectionAtLine(target.text, target.cursorLine);
    if (at === null) {
      this.env.prompter.notice(
        "Shared Tasks: put the cursor in a shared section to see its details.",
      );
      return;
    }
    void this.openCard(at.key, at.title);
  }

  /**
   * "Invite to this section…" (UX-02): the section under the cursor of
   * `target` is invited to by `invite`, the flow the pane's "Invite
   * collaborator…" runs. Outside every section: one notice, no picker.
   */
  async inviteAt(target: TargetCapture, invite: (key: string) => Promise<void>): Promise<void> {
    const at = sectionAtLine(target.text, target.cursorLine);
    if (at === null) {
      this.env.prompter.notice(`Shared Tasks: ${INVITE_CURSOR_NOTICE}`);
      return;
    }
    await invite(at.key);
  }

  /**
   * "Resolve shared task conflict" with the cursor in a shared section
   * (F-05): that section's "Review conflicts…", as its card opens it.
   */
  reviewConflictsAt(text: string, line: number): void {
    if (this.#refused({}, false)) return;
    const at = sectionAtLine(text, line);
    if (at === null) {
      this.env.prompter.notice(
        "Shared Tasks: put the cursor in a shared section to review its conflicts.",
      );
      return;
    }
    this.reviewConflicts(at.key, at.title);
  }

  /**
   * "Review conflicts…" of section `key` (the card's button, the pane's),
   * once it has loaded. `focus` (a pane's problem row, LFCP-03-018) is the
   * RecoveryItem.key to open on: the items are read again, and an item no
   * longer there (resolved meanwhile) opens nothing.
   */
  reviewConflicts(key: string, title: string, focus?: string): void {
    const { prompter, services } = this.env;
    if (this.#refused({}, false)) return;
    if (services.model() === null || !services.known(key)) {
      prompter.notice("Shared Tasks: this section is still loading. Try again in a moment.");
      return;
    }
    this.#openRecovery(key, title, focus);
  }

  /**
   * Whether section `ref` has loaded on this device (watched, its model
   * ready): the executor's side of the descriptors' "loading" guard on
   * detach. Says so and returns false when not.
   */
  #loaded(ref: SectionRef): boolean {
    const { prompter, services } = this.env;
    const snap = services.model()?.snapshot(toBase64url(ref.resourceId), ref.sectionId);
    if (services.known(sectionKey(ref)) && snap?.ready === true) return true;
    prompter.notice("Shared Tasks: this section is still loading. Try again in a moment.");
    return false;
  }

  /** Whether the host guard refuses `needs` now, without saying so (an entry not offered). */
  #mayNot(needs: HostNeeds): boolean {
    const { services } = this.env;
    return (
      hostRefusal(
        {
          unavailable: services.unavailable(),
          starting: false,
          readOnly: services.readOnly(),
          server: services.server().trim() !== "",
        },
        needs,
      ) !== null
    );
  }

  /** "Review conflicts…" (061): each conflict, its alternatives, one choice at a time. */
  #openRecovery(key: string, title: string, focus?: string): void {
    const { prompter, services } = this.env;
    if (services.model() === null) return;
    const items = services.recoveryItems(key);
    const item = focus === undefined ? undefined : items.find((i) => i.key === focus);
    if (focus !== undefined && item === undefined) {
      prompter.notice(
        "Shared Tasks: this conflict is no longer there; nothing needs a choice for it now.",
      );
      this.#changed();
      return;
    }
    prompter.review(
      title,
      item === undefined ? items : [item, ...items.filter((i) => i !== item)],
      async (chosen, choice) => {
        const r = await services.resolveRecovery(key, chosen, choice);
        // The pane reads the items and the facts again: a choice never hides a row by itself.
        this.#changed();
        return r;
      },
    );
  }

  /**
   * "Repair shared sections in this note" on note `path`, from a surface
   * that names a note rather than an editor (the card's held copy, F-04):
   * the note opened first.
   */
  async repairAt(path: string): Promise<void> {
    const { notes } = this.env;
    const at = await notes.goToLine(path, notes.capture(path)?.cursorLine ?? 0);
    if (at !== null) await this.repairNote(at);
    // Shown only in Reading view: not open for editing (T4). A note gone was said by goToLine.
    else if ((await notes.read(path)) !== null) this.env.prompter.notice(REPAIR_OPEN_FOR_EDITING);
  }

  /**
   * A repair problem of the pane (LFCP-03-018): an item of note `p.path`,
   * by its line key, as the note was at `p.revision`. The note is parsed
   * again first and the item found by its key (the nearest to its old line):
   * a line number alone is never trusted after an edit. Gone, nothing
   * opens and nothing is written. A problem to locate goes to its line now;
   * a boundary opens the repair on it. Nothing is written without a choice
   * in the repair dialog, which checks the note again.
   */
  async repairProblem(p: {
    readonly path: string;
    readonly key: string;
    readonly line: number;
    readonly revision: string;
  }): Promise<void> {
    const { prompter, notes } = this.env;
    const now = await this.#now(p.path);
    if (now === null) {
      prompter.notice("Shared Tasks: the note is gone. Nothing was repaired.");
      this.#changed();
      return;
    }
    const keyed = keyedRepairs(now.text, await this.#heldKeys(p.path));
    // At the same revision the line is exact; else the key finds where the item is now.
    const found =
      contentHash(now.text) === p.revision
        ? keyed.find((k) => k.key === p.key && k.item.line === p.line)
        : findRepair(keyed, p.key, p.line);
    if (found === undefined) {
      prompter.notice(
        "Shared Tasks: this problem is no longer in the note (it changed meanwhile). Nothing was changed.",
      );
      this.#changed();
      return;
    }
    if (found.item.kind === "restore") {
      if (now.composing) {
        prompter.notice(invalidationText("composing", "restored"));
        return;
      }
      await this.#restoreMarker(p.path, now.text, found.item);
      return;
    }
    const at = await notes.goToLine(p.path, found.item.line);
    if (found.item.kind === "locate") return;
    if (at !== null) await this.repairNote(at, found.item.line);
    // Reading view: not open for editing (T4). A note gone was said by goToLine.
    else if ((await notes.read(p.path)) !== null) prompter.notice(REPAIR_OPEN_FOR_EDITING);
  }

  /**
   * The keys of the sections this device holds: those with a loaded model
   * and those with a base in note `path` (a damaged copy keeps its base).
   */
  async #heldKeys(path: string): Promise<string[]> {
    const { services } = this.env;
    const keys = new Set<string>();
    for (const c of (await services.sectionChoices()) ?? [])
      keys.add(`${toBase64url(c.resource)}#${c.sectionId}`);
    const bases = services.bases();
    if (bases !== null)
      for (const id of await bases.projectionsOf(path)) {
        const b = await bases.load(id);
        if (b !== undefined) keys.add(sectionKey(b.locator.section));
      }
    return [...keys];
  }

  /**
   * Rewrites a damaged marker line of note `path` as it was: that line only,
   * through the note-write path, and only on the text it was computed for
   * (`md`): a note that changed meanwhile is left as it is.
   */
  async #restoreMarker(
    path: string,
    md: string,
    item: Extract<RepairItem, { kind: "restore" }>,
  ): Promise<void> {
    const { prompter, notes, services } = this.env;
    let written = false;
    await notes.edit(path, (current) => {
      if (current !== md) return null;
      written = true;
      return [restoreChange(current, item)];
    });
    if (!written) {
      prompter.notice("Shared Tasks: the note changed meanwhile. Nothing was restored; try again.");
      this.#changed();
      return;
    }
    services.pass(path);
    prompter.notice(
      `Shared Tasks: the ${item.boundary} line of ${item.title === null ? "the section" : `"${item.title}"`} was restored.`,
    );
    this.#changed();
  }

  /**
   * The copies of section `key`'s text kept on this device (not shared): by
   * the section key a candidate carries (LFCP-03-048), whatever became of its
   * projection, base or note. A record that has none yet (before the startup
   * backfill, or one it could not place) is found as it was before: by the
   * base of its projection, or the key in a provisional projection's ID.
   */
  async #keptCopies(key: string): Promise<string[]> {
    const { services } = this.env;
    const journal = services.candidates();
    if (journal === null) return [];
    const ids = new Set<string>();
    for (const c of (await journal.candidatesOfSection?.(key)) ?? []) ids.add(c.candidateId);
    for (const c of await journal.allCandidates()) {
      if (c.sectionKey !== undefined) {
        // Keyed: the index above found it, or it belongs to another section.
        if (c.sectionKey === key) ids.add(c.candidateId);
        continue;
      }
      const base = await services.bases()?.load(c.projectionId);
      const section = base === undefined ? undefined : sectionKey(base.locator.section);
      if (section === key || c.projectionId.includes(`#${key}#`)) ids.add(c.candidateId);
    }
    return [...ids];
  }

  /**
   * "Discard the local copy…" (UX §3): the copies of section `key`'s text
   * kept on this device after a refusal, discarded after asking; the note
   * and the section stay.
   */
  async discardLocalCopies(key: string, title: string): Promise<void> {
    const { prompter, services } = this.env;
    const ids = await this.#keptCopies(key);
    if (ids.length === 0) {
      prompter.notice(`Shared Tasks: no local copy of "${title}" is kept on this device.`);
      return;
    }
    const one = ids.length === 1;
    const ask = prompter.confirm({
      title: `Local copies of "${title}"`,
      message: `${one ? "One copy" : `${ids.length} copies`} of this section's text ${one ? "was" : "were"} kept on this device when the sync server refused ${one ? "it" : "them"}. ${one ? "It is" : "They are"} not shared. Discard ${one ? "it" : "them"}? Your note and the shared section are not changed.`,
      action: "Discard",
    });
    if (!(await ask.result)) return;
    for (const id of ids) await services.candidates()?.resolveCandidate(id);
    prompter.notice(
      `Shared Tasks: ${one ? "the local copy was" : `${ids.length} local copies were`} discarded.`,
    );
    services.scheduleStatus();
  }

  /** What each share from this device came to in this session, by section key (LFCP-03-014). */
  readonly #shared = new Map<string, { kind: "hosted" | "local"; reason: string | null }>();

  /**
   * What this device's share of section `key` came to in this session:
   * created on this device only ("local", with why it is not hosted yet), or
   * on its server ("hosted"). The pane says which (I4: a local-only share
   * is not ready to invite); whether it is hosted now is the access list's.
   */
  shareResult(key: string): { kind: "hosted" | "local"; reason: string | null } | undefined {
    return this.#shared.get(key);
  }

  /** What became of a creation, in a notice (UX §3). */
  #notifyCreation(entry: CreationEntry, r: CreationResult): void {
    if (r.kind === "hosted" || r.kind === "local") {
      this.#shared.set(`${entry.resource}#${entry.sectionId}`, {
        kind: r.kind,
        reason: r.kind === "local" ? r.reason : null,
      });
      this.#changed();
    }
    const notice = (m: string) => this.env.prompter.notice(m);
    const title = entry.preview.title;
    if (r.kind === "hosted") notice(`Shared Tasks: section "${title}" is shared.`);
    else if (r.kind === "local")
      notice(
        `Shared Tasks: section "${title}" was created on this device; invitation is not ready yet. ${r.reason}`,
      );
    else if (r.kind === "stale")
      notice(
        `Shared Tasks: section "${title}" changed since the preview. Nothing was bound; share it again.`,
      );
    else if (r.kind === "failed")
      notice(`Shared Tasks: section "${title}" could not be created (${r.reason}).`);
  }
}

const fromKey = (b64: string): ResourceId => fromBase64url(b64) as ResourceId;

/** A note's name as the user sees it: its file name without ".md". */
const noteName = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

/** A section choice's key ("<resource base64url>#<section>"), as surfaces name a section. */
const choiceKey = (c: SectionChoice): string => `${toBase64url(c.resource)}#${c.sectionId}`;

/**
 * The choice a surface named by `key`: its full key, or, for a section
 * joined a moment ago whose model has not named it yet (the pane's row,
 * keyed by its Resource), the one choice of that Resource. Null when none
 * or several match: the user then picks.
 */
function namedChoice(choices: readonly SectionChoice[], key: string): SectionChoice | null {
  const exact = choices.find((c) => choiceKey(c) === key);
  if (exact !== undefined) return exact;
  if (key.includes("#")) return null;
  const same = choices.filter((c) => toBase64url(c.resource) === key);
  return same.length === 1 ? (same[0] ?? null) : null;
}

/** Where an insertion's lines go, as its preview says it ("These lines go …"). */
function destinationText(d: InsertDestination, other: string | null): string {
  switch (d.kind) {
    case "here":
      return "into this note after the paragraph at the cursor";
    case "note":
      return other === null
        ? "into a note that was deleted: choose another"
        : `at the end of "${noteName(other)}"`;
    case "new":
      return `into a new note "${noteName(d.path)}"`;
  }
}

/** The heading line of the copy an insertion wrote: the first copy of its section at or after its line. */
function headingAfter(text: string, entry: InsertionEntry, line: number): number {
  const ref = {
    resourceId: fromBase64url(entry.preview.resource),
    sectionId: entry.preview.sectionId,
  };
  const copies = parseSections(text).sections.filter((s) => sameSection(s.ref, ref));
  return (copies.find((s) => s.heading.line >= line) ?? copies.at(-1))?.heading.line ?? line;
}
