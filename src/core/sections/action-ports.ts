// The ports of the section actions (LFCP-03-008, F-C03, F-C08): what the
// executor in actions.ts asks of an editor adapter. The executor decides
// what to ask and in which order, and calls the section cores (share,
// create, insert, rules, repair, recovery); the adapter shows the dialogs
// and notices (SectionPrompter), reads and writes notes (SectionNotes) and
// hands over the host's running state (SectionServices). None of these
// ports imports Obsidian, so the palette, the section card and the surfaces
// to come (menu, pane) share one executor, and a recording mock tests it.
//
// The collaboration commands use the same pattern (core/collab/commands.ts:
// Prompter, NoteAccess, CommandEnv).

import type { ResourceId } from "@openlfcp/core";
import type { Task, TaskView } from "@openlfcp/shared-objects";
import type { RefPlacement } from "../settings";
import type { RevokeOutcome } from "../status/access";
import type { SectionCard } from "../status/card";
import type { HeldEdits } from "../status/held";
import type { StoredBase } from "./base";
import type { CreationEntry, CreationResult } from "./create";
import type { InsertionEntry, InsertPreview, InsertRefusal, InsertResult } from "./insert";
import type { PendingCandidate } from "./journal";
import type { ImportChoices, LegacyPreview, LegacySource } from "./legacy";
import type { SectionSnapshot } from "./port";
import type { RecoveryChoice, RecoveryItem } from "./recovery";
import type { ComparedLine, RepairItem } from "./repair";
import type { SharePreview, ShareRange } from "./share";
import type { TargetCapture } from "./target";

/** An open dialog: its answer, and a way to bring it in front again (a repeated start of its flow). */
export interface SectionDialog<T> {
  readonly result: Promise<T>;
  /** In front of any other dialog, focused as a whole (never on its confirming button). */
  bringForward(): void;
}

/**
 * Where "Insert into a note…" writes (LFCP-03-016): the note it started on,
 * after the paragraph at its cursor; another existing note, at its end; or
 * a new note the user names, created empty first and never over a note
 * that is already there.
 */
export type InsertDestination =
  | { readonly kind: "here" }
  | { readonly kind: "note"; readonly path: string }
  | { readonly kind: "new"; readonly path: string };

/** The destination as the insert preview shows it, and how to choose another. */
export interface InsertPlace {
  /** Where the lines go, in words ("into this note, after the paragraph at the cursor"). */
  readonly where: string;
  /** The notes that already hold a copy of the section; null while the notes are still being read. */
  readonly placements: readonly string[] | null;
  /**
   * Opens the choice of another destination; settles once it is chosen or
   * cancelled. Absent: the place is fixed (an insertion resumed after a restart).
   */
  change?(): Promise<void>;
}

/** What the destination choice offers. */
export interface DestinationChoice {
  /** The section's shared title. */
  readonly title: string;
  /** The note the insert started on, if any. */
  readonly current: string | null;
  /** The notes that already hold a copy of the section; null while the notes are still being read. */
  readonly placements: readonly string[] | null;
}

/** A button a notice carries ("Open" after an insertion). */
export interface NoticeAction {
  readonly label: string;
  readonly run: () => void;
}

/** A section of this vault offered by "Insert shared section…". */
export interface SectionChoice {
  readonly resource: Uint8Array;
  readonly sectionId: string;
  /** The shared title (UX contract N1). */
  readonly title: string;
  /** The name given on this device, if any (N2); shown only where it differs from the title. */
  readonly alias?: string | null;
}

/** A section of a note whose base is lost: the note's lines against the shared ones. */
export interface LostBase {
  readonly key: string;
  readonly title: string;
  readonly lines: readonly ComparedLine[];
  /**
   * The shared version cannot be written here yet (a Task in it is not
   * here or not a valid Task, a model problem): only this note's version
   * can be kept; `lines` are the note's.
   */
  readonly sharedUnavailable?: true;
}

/** What the repair dialog can do; each runs on the note the repair was computed for. */
export interface RepairActions {
  /** Places a missing marker after (end) or under (start) the chosen line. */
  boundary(
    item: Extract<RepairItem, { kind: "missing-end" | "missing-start" }>,
    line: number,
  ): Promise<void>;
  /** Moves the cursor to a line. */
  locate(line: number): void;
  /** Keeps the note's version: its differences are sent as this vault's edits. */
  shareMine(key: string): Promise<void>;
  /** Takes the shared version; the note's text is kept as a recovery copy first. */
  useShared(key: string): Promise<void>;
}

/** A button of the section card. */
export interface CardAction {
  readonly label: string;
  /**
   * Why it cannot run now, in words, when it applies but is blocked (A5,
   * D10): shown disabled with this reason; absent when it can run.
   */
  readonly disabled?: string;
  /** Runs after the card closes; the executor revalidates the section first. */
  readonly run: () => void;
}

/** What the card offers per identity of its access list. */
export interface CardRowActions {
  /** Sets this identity's local alias (a label of this device only). */
  readonly alias?: (id: string, label: string) => void;
  /** Removes this identity's access (060), after a confirmation. */
  readonly remove?: (principal: string, label: string) => void;
}

/** The open section card: redrawn with new facts, closed when another opens. */
export interface CardHandle {
  update(card: SectionCard): void;
  close(): void;
}

/** What applying one review choice returns: the items as they are then, and a note. */
export interface ReviewResult {
  readonly items: readonly RecoveryItem[];
  readonly note: string | null;
}

/** Dialogs and notices of the section actions (Obsidian: the section modals, Notice). */
export interface SectionPrompter {
  /** A notice; with `action`, it carries that button (an insertion's "Open"). */
  notice(message: string, action?: NoticeAction): void;
  /** Says a short text once through the live region (064). */
  announce(text: string): void;
  /** The share preview (049); `note` is a line above it. True when approved. */
  sharePreview(preview: SharePreview, note?: string): SectionDialog<boolean>;
  /** The import preview of a range with 0.1 shared Tasks (053): the choices, or null. */
  importPreview(title: string, preview: LegacyPreview): SectionDialog<ImportChoices | null>;
  /** Which section to insert (052), or null. */
  pickSection(choices: readonly SectionChoice[]): SectionDialog<SectionChoice | null>;
  /**
   * The insert preview (052). True when approved. `place` says where the
   * lines go and offers another destination (LFCP-03-016).
   */
  insertPreview(preview: InsertPreview, place?: InsertPlace): SectionDialog<boolean>;
  /**
   * The destination of an insertion (LFCP-03-016): another existing note or
   * a new one; null when cancelled. Absent: the insert goes into its note.
   */
  chooseDestination?(choice: DestinationChoice): SectionDialog<InsertDestination | null>;
  /**
   * A confirmation; `action` labels the confirming button. It is styled as
   * a warning unless `destructive` is false (a choice such as "Share the
   * whole section…", which opens its own preview).
   */
  confirm(options: {
    readonly title: string;
    readonly message: string;
    readonly action: string;
    readonly destructive?: boolean;
  }): SectionDialog<boolean>;
  /** A local alias for an identity, or null when cancelled. */
  alias(current: string): Promise<string | null>;
  /**
   * "Repair shared sections in this note" (062): its result settles when the
   * dialog closes (the executor holds the note until then, LFCP-03-018).
   */
  repair(
    items: readonly RepairItem[],
    lost: readonly LostBase[],
    actions: RepairActions,
  ): SectionDialog<void>;
  /** "Review conflicts…" (061): `apply` re-reads the model before each choice. */
  review(
    title: string,
    items: readonly RecoveryItem[],
    apply: (item: RecoveryItem, choice: RecoveryChoice) => Promise<ReviewResult>,
  ): void;
  /** The section card (059), open; `onClosed` runs when it closes. */
  card(
    content: SectionCard,
    actions: readonly CardAction[],
    onClosed: () => void,
    rows: CardRowActions,
  ): CardHandle;
}

/** One change of a note's text, in UTF-16 offsets. */
export interface TextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/**
 * The notes of the vault, as the section actions need them. An action gets
 * its note as a TargetCapture taken when it starts (LFCP-03-009); it never
 * holds a live editor, so switching notes in a tab cannot redirect it.
 */
export interface SectionNotes {
  /**
   * The note's open editor read now (Reading view is not open for editing),
   * else null.
   */
  capture(path: string): TargetCapture | null;
  /** The note's file text, or null when no file is at `path`. */
  read(path: string): Promise<string | null>;
  /**
   * The changes `fn` computes, on the open editor's text, else on the
   * file's, marked as the plugin's own edit. `fn` returns null to write nothing.
   */
  edit(path: string, fn: (current: string) => readonly TextChange[] | null): Promise<void>;
  /** The note opened in an editor with `line` revealed, read then; null (said) when it is gone. */
  goToLine(path: string, line: number): Promise<TargetCapture | null>;
  /**
   * A new empty note at `path` (LFCP-03-016): "exists" when a file is
   * already there, which is never overwritten. Absent: no new note.
   */
  create?(path: string): Promise<"created" | "exists">;
}

/** The section creation journal, as the actions run it (SectionCreation). */
export interface CreationService {
  prepare(path: string, markdown: string, preview: SharePreview): Promise<CreationEntry>;
  prepareImport(
    path: string,
    markdown: string,
    range: ShareRange,
    source: (resource: string, objectId: string) => LegacySource | undefined,
    chosen: ImportChoices,
  ): Promise<CreationEntry>;
  run(entry: CreationEntry, at?: () => string | null): Promise<CreationResult>;
  /** The creation as its journal holds it now (a reconcile resumes from there), if journaled. */
  current(operationId: string): Promise<CreationEntry | undefined>;
  cancel(entry: CreationEntry): Promise<CreationEntry>;
  imports(path?: string): Promise<CreationEntry[]>;
  rollback(
    entry: CreationEntry,
  ): Promise<{ readonly kind: "restored" | "beside" | "none"; readonly entry: CreationEntry }>;
}

/** The section insertion journal, as the actions run it (SectionInsertion). */
export interface InsertionService {
  preview(
    resource: ResourceId,
    sectionId: string,
  ): Promise<InsertPreview | { readonly refused: InsertRefusal }>;
  prepare(
    path: string,
    markdown: string,
    line: number,
    preview: InsertPreview,
  ): Promise<InsertionEntry>;
  run(entry: InsertionEntry): Promise<InsertResult>;
  /** The insertion as its journal holds it now (a reconcile resumes from there), if journaled. */
  current(insertionId: string): Promise<InsertionEntry | undefined>;
  /** Ends an insertion that wrote nothing (it is no longer resumed). */
  cancel(entry: InsertionEntry): Promise<InsertionEntry>;
}

/** The projection bases of notes (SectionBaseStore). */
export interface BaseService {
  load(projectionId: string): Promise<StoredBase | undefined>;
  save(projectionId: string, base: StoredBase | null): Promise<void>;
  projectionsOf(path: string): Promise<string[]>;
}

/** Text kept on this device (SectionJournalStore candidates). */
export interface CandidateService {
  putCandidate(candidate: PendingCandidate): Promise<void>;
  allCandidates(): Promise<PendingCandidate[]>;
  resolveCandidate(candidateId: string): Promise<void>;
}

/** The loaded section models (SdkSectionPort). */
export interface ModelService {
  snapshot(resource: string, sectionId: string): SectionSnapshot | undefined;
  task(resource: string, taskId: string): Task | undefined;
  /** A section Task with its conflict metadata (what the engine compares a seed with). */
  taskView(resource: string, taskId: string): TaskView | undefined;
}

/** The collaboration commands for one Resource (the card's Invite and Resource status). */
export interface ResourceCommands {
  inviteTo(resource: ResourceId): Promise<void>;
  resourceStatusOf(resource: ResourceId): Promise<void>;
}

/**
 * The host's running state, as the actions need it. A getter returns null
 * while the runtime has not started: the action says "still starting".
 */
export interface SectionServices {
  creation(): CreationService | null;
  insertion(): InsertionService | null;
  bases(): BaseService | null;
  candidates(): CandidateService | null;
  model(): ModelService | null;
  /** V3: sections are read-only on this device (no new section, no access change). */
  readOnly(): boolean;
  /** The server a new section is hosted on (the default server setting). */
  server(): string;
  /** The binding placement setting for new Task refs (§4.1). */
  refPlacement(): RefPlacement;
  /** The sections of this vault with a loaded model, or null while starting. */
  sectionChoices(): Promise<SectionChoice[] | null>;
  /**
   * The notes that hold a copy of a section Resource (the placement index),
   * or null while the notes are still being read. Absent: not known.
   */
  placements?(resource: Uint8Array): readonly string[] | null;
  /** A 0.1 shared Task as this device holds it now; undefined when it is not here. */
  legacySource(resource: ResourceId, objectId: string): Promise<LegacySource | undefined>;
  /** Watches a section Resource: its model changes start passes, its status is shown. */
  watch(resource: ResourceId): Promise<void>;
  /** A note's text holds these sections now (the host's note index). */
  indexed(path: string, text: string): void;
  /** A pass of a note: on the open editor's text, else on `text` (the file's). */
  pass(path: string, text?: string): void;
  /** A projection detached from a note: its facts are dropped. */
  forget(key: string, projectionId: string): void;
  /** A section Resource came or went (a creation ran): the registry view reads it again. */
  registryChanged(): void;
  /** Recomputes the sections' statuses soon. */
  scheduleStatus(): void;
  /** Why the plugin cannot run here (another instance holds the data), or null. */
  unavailable(): string | null;
  /** Whether section `key` has a status, i.e. is watched on this device. */
  known(key: string): boolean;
  /** What the card of `key` says now, or null while its status is unknown. */
  cardContent(key: string, title: string): Promise<SectionCard | null>;
  /** Where section `key`'s copies hold edits not sent (its StatusView.held); empty when unknown. */
  held(key: string): readonly HeldEdits[];
  /** The review items of section `key`: kept own work, the model's conflicts, reappeared nodes. */
  recoveryItems(key: string): RecoveryItem[];
  /** Applies one review choice of section `key`. */
  resolveRecovery(key: string, item: RecoveryItem, choice: RecoveryChoice): Promise<ReviewResult>;
  /** The collaboration commands, or null before the runtime runs. */
  commands(): ResourceCommands | null;
  /** The local aliases of identities (Principal ID prefix → label). */
  aliases(): Promise<Record<string, string>>;
  /** Sets (or, with "", clears) the local alias of identity `id`; false while not running. */
  setAlias(id: string, name: string): Promise<boolean>;
  /**
   * Removes an identity (Principal ID hex) from a section Resource (060):
   * null while not running; throws when the outcome is unknown.
   */
  revokeAccess(resource: ResourceId, principal: string): Promise<RevokeOutcome | null>;
}
