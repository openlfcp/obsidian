// Shared sections in the plugin (MVP 0.2; on in every 0.4 build): the
// editor extension, the engine on the real SDK (the runtime's sessions, its
// install database), the notes that hold sections, and the events that
// start passes.
//
// The sync status comes from the SDK's status stream (026) and what the
// plugin observes of the session and the model (core/status/facts.ts).

import type { EditorView } from "@codemirror/view";
import type { Flushed } from "@openlfcp/client";
import {
  dataUnitId,
  fromBase64url,
  fromHex,
  generateObjectId,
  generateResourceId,
  hash32,
  type PrincipalId,
  type ResourceId,
  toBase64url,
  toHex,
} from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import type { LfcpStorage } from "@openlfcp/storage";
import { type App, type Editor, MarkdownView, type Modal, Notice, TFile } from "obsidian";
import { type Collaboration, expectHosting } from "../core/collab/service";
import type { KeptCandidate, SectionFacts } from "../core/diagnostics";
import { keptCandidates, saveFailedConditions } from "../core/diagnostics-collect";
import { type Flow, InFlight } from "../core/in-flight";
import { type LfcpRuntime, SECTIONS_READ_ONLY } from "../core/lfcp/runtime";
import { portRefusal, SdkSectionPort } from "../core/lfcp/section-port";
import { type NoteTarget, NoteTargets } from "../core/note-targets";
import { scanRefs } from "../core/refs";
import { splitLines } from "../core/refs/lines";
import { markdownState, newProjectionId } from "../core/sections/base";
import { type CreationEntry, type CreationResult, SectionCreation } from "../core/sections/create";
import {
  applyChanges,
  type NotePass,
  SectionEngine,
  sameState,
  sharedState,
} from "../core/sections/engine";
import { type SectionRef, sameSection } from "../core/sections/grammar";
import {
  type InsertResult,
  insertRefusalMessage,
  renderSection,
  SectionInsertion,
} from "../core/sections/insert";
import { abandonOnce } from "../core/sections/journal";
import { type LegacySource, legacyPreflight } from "../core/sections/legacy";
import { type ParsedSection, parseSections, type SectionScan } from "../core/sections/parser";
import { PassErrorNotices } from "../core/sections/pass-errors";
import { noteSections, PlacementIndex } from "../core/sections/placement-index";
import { CommitRefused, type ModelNode, type SectionSnapshot } from "../core/sections/port";
import {
  applyRecovery,
  type RecoveryItem,
  reappearedItems,
  recoveryItems,
} from "../core/sections/recovery";
import {
  adoptedBase,
  boundaryRepair,
  compare,
  repairItems,
  sharedVersionChange,
} from "../core/sections/repair";
import {
  bindsOwnNode,
  detachAt,
  type PastedBinding,
  removeNodeLines,
} from "../core/sections/rules";
import {
  preflight,
  proposeRange,
  revalidate,
  type SharePreview,
  type ShareRange,
} from "../core/sections/share";
import {
  KeyValueStaleWorkStore,
  StaleWorkController,
  staleLabel,
} from "../core/sections/stale-work";
import { KeyValueSectionBaseStore, KeyValueSectionJournalStore } from "../core/sections/stores";
import { newSectionTask } from "../core/sections/task-fields";
import type { RefPlacement, SectionComments } from "../core/settings";
import { Announcer } from "../core/status/a11y";
import { accessView, REMOVE_CONFIRMATION, revokeMessage } from "../core/status/access";
import { type SectionCard, sectionCard } from "../core/status/card";
import { collectStatuses } from "../core/status/collect";
import { observedFacts } from "../core/status/facts";
import {
  damagedHeld,
  HELD_CAUSE,
  type HeldCause,
  type HeldEdits,
  type HeldPersistence,
  heldEdits,
} from "../core/status/held";
import { HeldChecks } from "../core/status/held-checks";
import { LagNudges, ProjectionFactsStore } from "../core/status/projections";
import {
  type AccessFacts,
  type ConnectionQualifier,
  type StatusFacts,
  type StatusView,
  type SyncFacts,
  statusView,
} from "../core/status/reducer";
import { runtimeStatusSource, SdkStatusTracker } from "../core/status/sdk-tracker";
import { type VaultSyncSummary, vaultSyncSummary } from "../core/status/summary";
import type { VaultChange } from "../core/vault/changes";
import { pluginEdit, sectionEditorExtension } from "./section-editor";
import {
  goToNextProblem,
  ReadingBadges,
  revealLine,
  sectionAtLine,
  sectionKey,
  sectionStatusExtension,
  setSectionStatuses,
} from "./section-status";
import { ImportSectionModal } from "./ui/import-section";
import { InsertSectionModal, PickSectionModal, type SectionChoice } from "./ui/insert-section";
import { RecoveryModal } from "./ui/recovery";
import { type LostBase, RepairModal } from "./ui/repair";
import { AliasModal, ConfirmModal, SectionCardModal } from "./ui/section-card";
import { ShareSectionModal } from "./ui/share-section";

/** The text a note with a shared section always contains. */
const SECTION_MARK = "lfcp-section:";

/** The nodes deleted in the model that one note shows again, in one section. */
interface ReappearedInNote {
  readonly section: SectionRef;
  readonly ids: readonly string[];
}

export class SectionsHost {
  #engine: SectionEngine | null = null;
  #creation: SectionCreation | null = null;
  #insertion: SectionInsertion | null = null;
  #runtime: LfcpRuntime | null = null;
  /** Section Resources whose model changes start passes (hex of the ID). */
  readonly #watched = new Set<string>();
  /** Share, import and insert flows, one per note at a time (F-03, F-C04), keyed by its held identity. */
  readonly #flows = new InFlight();
  /**
   * Notes with sections not checked for held edits since the start
   * (LFCP-03-003): until a note is checked, its sections are never shown
   * as current; a failed pass leaves them unknown, not "being checked".
   */
  readonly #heldChecks = new HeldChecks();
  /** The notes those flows act on, followed across renames (LFCP-03-002). */
  readonly #targets = new NoteTargets();
  #bases: KeyValueSectionBaseStore | null = null;
  /** Notes that hold a copy of each section Resource, and whether every note was read (011). */
  readonly #placements = new PlacementIndex();
  readonly editor: ReturnType<typeof sectionEditorExtension>;
  /** Section status badges (LFCP-02-058): in editors, and in Reading view. */
  readonly status = sectionStatusExtension(
    () => this.#statuses,
    (key, title) => void this.openCard(key, title),
    (title) => this.#readOnlyTyping(title),
  );
  /** When a read-only section last said it stopped typing (F-04): once per few seconds. */
  #readOnlySaid = 0;

  /** Typing into a read-only section is stopped (F-04): said, at most every 5 s. */
  #readOnlyTyping(title: string): void {
    const now = Date.now();
    if (now - this.#readOnlySaid < 5000) return;
    this.#readOnlySaid = now;
    const text = `Shared Tasks: "${title}" is read-only for you. Your typing was not applied; ask the section's owner for write access.`;
    new Notice(text);
    this.announce(text);
  }
  readonly reading = new ReadingBadges(
    (key) => this.#statuses.get(key),
    (key, title) => void this.openCard(key, title),
  );
  /** The open details card, redrawn when its section's status changes. */
  #card: { readonly key: string; readonly title: string; readonly modal: SectionCardModal } | null =
    null;
  #statuses: ReadonlyMap<string, StatusView> = new Map();
  /** A new blocking condition is announced once (064). */
  readonly #announcer = new Announcer();
  #statusDue: number | null = null;
  #port: SdkSectionPort | null = null;
  #journal: KeyValueSectionJournalStore | null = null;
  /** Own offline work a Key Epoch cut off (stale-work.ts): guarded, re-applied, reviewed. */
  #stale: StaleWorkController | null = null;
  /** The SDK's status of each section Resource (hex): batches, acceptance, access (026). */
  readonly #sdk = new SdkStatusTracker(
    runtimeStatusSource({
      runtime: () => this.#runtime,
      watched: (R) => this.#watched.has(toKey(R)),
      changed: () => this.scheduleStatus(),
    }),
  );
  /** Section Resources whose session was LIVE in this run (hex). */
  readonly #wasLive = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly onError: (path: string, error: unknown) => void,
    /** The binding placement setting for new Task refs (§4.1). */
    private readonly refPlacement: () => RefPlacement,
    /** The section comments setting (§4.5). */
    private readonly sectionComments: () => SectionComments,
    /** The collaboration flows (hosting), null before the runtime runs. */
    private readonly collab: () => Collaboration | null,
    /** The server a new section is hosted on (the default server setting). */
    private readonly server: () => string,
    /** The collaboration commands for one Resource (the card's actions). */
    private readonly commands: () => {
      inviteTo(R: ResourceId): Promise<void>;
      resourceStatusOf(R: ResourceId): Promise<void>;
    } | null = () => null,
    /** Says a short text once through the plugin's live region (064). */
    private readonly announce: (text: string) => void = () => undefined,
  ) {
    this.editor = sectionEditorExtension({
      engine: () => this.#engine,
      files: {
        rewrite: async (path, fn) => {
          const file = this.app.vault.getFileByPath(path);
          return file === null ? null : this.app.vault.process(file, fn);
        },
        read: async (path) => {
          const file = this.app.vault.getFileByPath(path);
          return file === null ? null : this.app.vault.read(file);
        },
      },
      // D1: a failing note says so once, until it passes again.
      onError: (path, error) => {
        // LFCP-03-003: its held edits are unknown until a pass succeeds.
        if (this.#heldChecks.failed(path)) this.scheduleStatus();
        if (
          this.#passErrors.shouldShow(path, error instanceof Error ? error.message : String(error))
        )
          onError(path, error);
      },
      restore: () => this.#restoreHere,
      keepPasted: (b, into) => this.#keepPasted(b, into),
      // SI12, SI16: each projection's pass result reaches its section's badge.
      onPass: (path, pass) => {
        this.#passErrors.passed(path);
        let changed = false;
        for (const r of pass.sections) {
          if (this.#projectionFacts.note(sectionKey(r.section), r)) changed = true;
          this.#noteReappeared(path, r.section, r.reappeared ?? []);
          if (r.local?.kind === "committed")
            for (const i of r.local.entry.intents ?? [])
              if (i.intent === "node.restore") this.#restoreHere.delete(i.id);
          // A drifted node heals once its Text is the same at two passes: one more, soon.
          if (r.base?.drifted !== undefined) this.#passSoon(path);
          if ((r.restored?.length ?? 0) > 0) {
            const title = this.#port?.snapshot(
              toBase64url(r.section.resourceId),
              r.section.sectionId,
            )?.title;
            new Notice(
              `Shared Tasks: after a sync error, the shared text of "${title ?? "a shared section"}" was put back into this note. Check the section; your earlier text is kept as a local copy.`,
              12_000,
            );
          }
        }
        // C17: a copy whose boundary is damaged yields no section result; it is still a problem.
        const scan = parseSections(pass.source);
        const damaged = new Set(scan.damaged.map((d) => sectionKey(d.ref)));
        const damagedLines = new Map(
          scan.damaged.map((d) => [sectionKey(d.ref), d.heading?.line ?? d.startLine]),
        );
        if (this.#projectionFacts.damaged(path, damaged, damagedLines)) changed = true;
        if (changed) this.scheduleStatus();
        // F-04: what each copy holds back, counted against its base.
        void this.#noteHeld(path, pass, scan).catch((e) => {
          if (this.#heldChecks.failed(path)) this.scheduleStatus();
          this.#bookkeepingFailed(e);
        });
      },
    });
  }

  /**
   * F-04: each section result of a pass of `path` as the edits it holds
   * back (counted against its base), into its projection's facts; a copy
   * newly held says so once.
   */
  async #noteHeld(path: string, pass: NotePass, scan: SectionScan): Promise<void> {
    let changed = false;
    const passed = new Set<string>();
    const seen = new Map<string, number>();
    // LFCP-03-003: held text is only in the note; whether that is saved to
    // disk, read once and only when something is held.
    let persistence: HeldPersistence | undefined;
    const persisted = async () => {
      persistence ??= await this.#persistence(path);
      return persistence;
    };
    for (const r of pass.sections) {
      const key = sectionKey(r.section);
      // The k-th result of a section is its k-th copy in the note.
      const k = seen.get(key) ?? 0;
      seen.set(key, k + 1);
      const section = scan.sections.filter((s) => sectionKey(s.ref) === key)[k];
      if (section === undefined) continue;
      passed.add(r.projectionId);
      const base = (await this.#bases?.load(r.projectionId))?.state;
      const found = heldEdits({ path, markdown: pass.source, scan, section, result: r, base });
      const h = found === null ? null : { ...found, persistence: await persisted() };
      if (this.#projectionFacts.held(key, r.projectionId, h)) changed = true;
      this.#heldNotice(key, r.projectionId, section.heading.title, h);
    }
    if (this.#projectionFacts.heldPassed(path, passed)) changed = true;
    // A damaged copy's entry (damaged()) gets it too.
    if (
      this.#projectionFacts.holds(path) &&
      this.#projectionFacts.persisted(path, await persisted())
    )
      changed = true;
    // Checked, but for a section whose model is not loaded yet (compared at its
    // next pass); a stale source passes again.
    if (
      pass.stale !== true &&
      this.#heldChecks.passed(
        path,
        new Set(
          pass.sections
            .filter((r) => r.skipped === "importing" || r.skipped === "no-snapshot")
            .map((r) => toKey(r.section.resourceId)),
        ),
      )
    )
      changed = true;
    for (const d of scan.damaged)
      this.#heldNotice(
        sectionKey(d.ref),
        `damaged:${path}`,
        d.heading?.title ?? "",
        damagedHeld(path, `damaged:${path}`, d.heading?.line ?? d.startLine),
      );
    if (changed) this.scheduleStatus();
  }

  /**
   * Whether note `path` is saved to disk as it is shown (LFCP-03-003): a
   * closed note is its file; an open one is saved when its file has the
   * editor's text. `disk`: the file's text, when just read.
   */
  async #persistence(path: string, disk?: string): Promise<HeldPersistence> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) return "unknown";
    const editor = this.#openEditor(path);
    if (editor === null) return "saved";
    try {
      return editor.getValue() === (disk ?? (await this.app.vault.cachedRead(file)))
        ? "saved"
        : "unsaved";
    } catch {
      return "unknown";
    }
  }

  /** Projections whose held edits were announced, with their cause (once until they clear). */
  readonly #heldSaid = new Map<string, HeldCause>();

  /** A copy newly holding edits back says so once (F-04: no notice before). */
  #heldNotice(key: string, projectionId: string, title: string, h: HeldEdits | null): void {
    const id = `${key}|${projectionId}`;
    if (h === null) {
      this.#heldSaid.delete(id);
      return;
    }
    if (this.#heldSaid.get(id) === h.cause) return;
    this.#heldSaid.set(id, h.cause);
    // Read-only typing is blocked and says so where it happens (section-status.ts).
    if (h.cause === "read-only" && h.count === 0) return;
    const what =
      h.count === null || h.count === 0
        ? "Edits"
        : `${h.count} ${h.count === 1 ? "edit" : "edits"}`;
    new Notice(
      `Shared Tasks: ${what} in "${title}" not sent: ${HELD_CAUSE[h.cause]} (line ${h.line + 1}). Open the section's details to fix it.`,
      10_000,
    );
  }

  /** The note side of each section's status: projection facts and failed saves (SI12, SI16). */
  readonly #projectionFacts = new ProjectionFactsStore();
  /** C14: a lag no event resolves gets one pass per revision. */
  readonly #lags = new LagNudges();
  readonly #passErrors = new PassErrorNotices();
  /** D1: each watched Resource's last section key, for its status when its model throws. */
  readonly #statusKeys = new Map<string, string>();
  /** Nodes deleted in the model that notes show again, by section key and note (Review conflicts). */
  readonly #reappeared = new Map<string, Map<string, ReappearedInNote>>();
  /** Nodes the user chose to restore where a note shows them; the next pass of that note does. */
  readonly #restoreHere = new Set<string>();

  /** §10: whether a pasted binding binds its own node where it lands (rules.ts bindsOwnNode). */
  #keepPasted(b: PastedBinding, into: SectionRef | null): boolean {
    return bindsOwnNode(
      b,
      into,
      (s) => this.#port?.snapshot(toBase64url(s.resourceId), s.sectionId)?.nodes,
      (r) => this.#runtime?.sectionProfile(fromBase64url(r) as ResourceId) !== undefined,
    );
  }

  #noteReappeared(path: string, section: SectionRef, ids: readonly string[]): void {
    const key = sectionKey(section);
    const notes = this.#reappeared.get(key) ?? new Map<string, ReappearedInNote>();
    if (ids.length > 0) notes.set(path, { section, ids });
    else notes.delete(path);
    if (notes.size > 0) this.#reappeared.set(key, notes);
    else this.#reappeared.delete(key);
  }

  /** The stale-work controller's view of a Resource (base64url): diagnostics and the native harness. */
  staleDiagnostics(resource: string): Record<string, unknown> | null {
    return this.#stale?.diagnostics(resource) ?? null;
  }

  /** The review items of section `key`: the model's conflicts, then nodes notes show again. */
  #recoveryItems(key: string): RecoveryItem[] {
    const b64 = key.slice(0, key.indexOf("#"));
    const sectionId = key.slice(key.indexOf("#") + 1);
    const m = this.#port?.recoveryModel(b64, sectionId);
    if (m === undefined) return [];
    const shown = [...(this.#reappeared.get(key)?.values() ?? [])].flatMap((n) => n.ids);
    const stale: RecoveryItem[] = (this.#stale?.review(b64) ?? []).map((op) => ({
      kind: "stale-work",
      key: `stale:${op.operationId}`,
      operationId: op.operationId,
      label: staleLabel(op),
    }));
    return [...stale, ...recoveryItems(m), ...reappearedItems(m, shown)];
  }

  /**
   * A node deleted in the model, shown again in notes: restored where a note
   * shows it (its next pass), or removed from every note that shows it.
   */
  async #resolveReappeared(key: string, nodeId: string, restore: boolean): Promise<string> {
    const notes = [...(this.#reappeared.get(key)?.entries() ?? [])].filter(([, n]) =>
      n.ids.includes(nodeId),
    );
    if (restore) {
      this.#restoreHere.add(nodeId);
      for (const [path] of notes.slice(0, 1)) {
        const file = this.app.vault.getFileByPath(path);
        if (this.#openEditor(path) !== null) this.editor.remoteChanged(path);
        else if (file !== null) this.editor.remoteChanged(path, await this.app.vault.read(file));
      }
      return "Restoring it where your note shows it.";
    }
    for (const [path, n] of notes)
      await this.#edit(path, (current) =>
        removeNodeLines(current, n.section, nodeId, new Set(n.ids)),
      );
    return "Removed from your note.";
  }

  /** The runtime is ready: the engine on the real SDK, section Resources opened, their notes reconciled. */
  async start(runtime: LfcpRuntime, principal: PrincipalId): Promise<void> {
    const storage = runtime.storage as LfcpStorage;
    const journal = new KeyValueSectionJournalStore(runtime.localState);
    this.#journal = journal;
    const staleStore = new KeyValueStaleWorkStore(runtime.localState);
    const port = new SdkSectionPort(
      {
        profile: (r) => runtime.sectionProfile(r),
        commit: (r, intents, o) => runtime.commitSection(r, intents, o),
        storage,
        // Contract §6: from the validated Control state; a denied edit stays a candidate.
        canWrite: (r) => runtime.canWriteSection(r),
        // §19.1: each own operation is recorded, to be re-applied if a Key Epoch cuts it off.
        ownWork: {
          recordOwn: (op) => this.#stale?.ownWork.recordOwn(op) ?? staleStore.recordOwn(op),
        },
        now: () => Date.now(),
        // A release may race an ACK's report (soak #1): the batch is checked in storage.
        released: (r, op) => void this.#sdk.confirm(r, op),
      },
      // Typing coalescing (025): a burst of typing is one unit, not one per key.
      {
        now: () => Date.now(),
        // Alone, after the tick that flushed it, never inside a pass that also
        // resumes the same operation; a failure is never left unhandled.
        onFlushed: (r, f) =>
          void port
            .exclusive(r, () => this.#flushed(journal, f))
            .catch((error) => this.#bookkeepingFailed(error)),
      },
    );
    this.#bases = new KeyValueSectionBaseStore(runtime.localState);
    this.#engine = new SectionEngine({
      port,
      journal,
      bases: this.#bases,
      newNodeId: () => generateObjectId(),
      newOperationId: () => crypto.randomUUID(),
      createdBy: principal,
      newProjectionId,
      // Section Tasks render and send their fields like 0.1's (SectionReplica.task).
      tasks: (r, taskId) => ({ view: port.taskView(r, taskId) }),
      newTask: (line, id) => newSectionTask(line, principal, id),
      refPlacement: this.refPlacement,
      sectionComments: this.sectionComments,
      // §19.1: never project a rebuilt model over a note whose own work waits to be re-applied.
      staleWork: (r) => this.#stale?.check(r) ?? false,
    });
    this.#runtime = runtime;
    this.#port = port;
    this.#stale = new StaleWorkController({
      store: staleStore,
      port,
      unit: async (u) => ({
        quarantined:
          (await storage.dataUnits.get(dataUnitId(fromHex(u))))?.status === "quarantined",
        queued: (await storage.outbound.get(hash32(fromHex(u)))) !== undefined,
      }),
      quarantined: async (r) =>
        (await storage.dataUnits.withStatus(fromBase64url(r) as ResourceId, "quarantined")).map(
          (x) => toHex(x.unitId),
        ),
      queued: async (r) =>
        (await storage.outbound.list(fromBase64url(r) as ResourceId))
          .filter((i) => i.kind === "data-unit")
          .map((i) => toHex(i.itemId)),
      changed: (r) => {
        this.scheduleStatus();
        void this.#remote(fromBase64url(r) as ResourceId).catch((e) => this.#bookkeepingFailed(e));
      },
      failed: (e) => this.#bookkeepingFailed(e),
      settle: (units) => runtime.discardStaleUnits(units),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      ready: async (r) => {
        const R = fromBase64url(r) as ResourceId;
        if (runtime.phase(R) !== "LIVE") return false;
        const snap = await runtime.sectionStatusSnapshot(R).catch(() => undefined);
        return snap?.catchUp?.state === "current-at-checkpoint";
      },
    });
    runtime.on((e) => {
      if (e.type === "status") this.#sdk.event(e.resourceId, e.event);
      if (e.type === "epoch-reconciled") {
        const units = [
          ...e.applied.excluded.map((x) => toHex(x.unitId)),
          ...e.outbound.map((x) => toHex(x.itemId)),
        ];
        // At once, before any pass of the rebuilt model (the controller's guard).
        if (runtime.sectionProfile(e.resourceId) !== undefined)
          this.#stale?.epochReconciled(toBase64url(e.resourceId), units);
      }
      // Re-applying waits for write access: anything on the Resource lets it try again.
      const rid = (e as { readonly resourceId?: ResourceId }).resourceId;
      if (rid !== undefined && e.type !== "epoch-reconciled") this.#stale?.live(toBase64url(rid));
      this.scheduleStatus();
    });
    this.#creation = new SectionCreation({
      host: {
        createSectionResource: async (o) => {
          // Its first RESOURCE_OPEN comes before RESOURCE_HOST: a refusal then is expected.
          await expectHosting(runtime.localState, o.resourceId);
          return runtime.createSectionResource(o);
        },
        openSection: (R) => runtime.openSection(R),
        discard: (R) => runtime.discardUnhosted(R),
        host: async (R) => {
          const flows = this.collab();
          if (flows === null)
            return { kind: "pending", reason: "Shared Tasks is not running yet." };
          const h = await flows.host(R);
          return h.kind === "hosted" ? { kind: "hosted" } : h;
        },
      },
      port,
      edit: (path, fn) => this.#edit(path, fn),
      bound: (path, text) => this.editor.seed(path, text),
      journal: runtime.localState,
      createdBy: principal,
      server: this.server,
      newResourceId: () => generateResourceId(),
      newNodeId: () => generateObjectId(),
      newOperationId: () => crypto.randomUUID(),
      newTask: (line, id) => newSectionTask(line, principal, id),
      refPlacement: this.refPlacement,
    });
    this.#insertion = new SectionInsertion({
      port,
      bases: this.#bases,
      journal: runtime.localState,
      loaded: (r) => (runtime.sectionProfile(fromKey(r))?.heldUnits().length ?? 1) === 0,
      task: (r, taskId) => port.task(r, taskId),
      edit: (path, fn) => this.#edit(path, fn),
      newInsertionId: newProjectionId,
      refPlacement: this.refPlacement,
    });
    // A discard a crash cut (LFCP-03-002): finished before any Resource is opened,
    // so the given-up Resource is neither listed nor opened again.
    await this.#creation.settleCancelled().catch((error) => this.#bookkeepingFailed(error));
    // LFCP-03-003: until every note with a section is found and checked, none is current.
    this.#heldChecks.begin();
    // LFCP-03-011: "not inserted anywhere" only once every note was read.
    this.#placements.begin();
    let indexFailure: string | undefined = "the notes were not all read";
    try {
      await this.#startNotes(runtime);
      indexFailure = undefined;
    } finally {
      this.#heldChecks.end();
      this.#placements.end(indexFailure);
      this.scheduleStatus();
    }
    // Creations a restart interrupted go on from their journal (SSP §12.2).
    for (const entry of await this.#creation.unfinished())
      void this.#finish(entry).then((r) => notifyCreation(entry, r), notifyFailure(entry));
  }

  /** The section Resources watched, their stale work scanned, and every note with a section passed. */
  async #startNotes(runtime: LfcpRuntime): Promise<void> {
    for (const entry of await runtime.registry())
      if (entry.profile === SECTIONS_PROFILE_ID) await this.#watch(entry.resourceId);
    // §19.1 after a restart: own units found quarantined (a cut not handled
    // before the restart) are cut now; open stale work goes on or waits.
    for (const entry of await runtime.registry())
      if (entry.profile === SECTIONS_PROFILE_ID)
        await this.#stale
          ?.scan(toBase64url(entry.resourceId))
          .catch((error) => this.#bookkeepingFailed(error));
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(file);
      if (!text.includes(SECTION_MARK)) continue;
      this.#index(file.path, text);
      this.#heldChecks.found(
        file.path,
        parseSections(text).sections.map((s) => toKey(s.ref.resourceId)),
      );
      this.editor.remoteChanged(file.path, text);
    }
  }

  /**
   * Creates the shared section of an approved preview (LFCP-02-050): the
   * creation is journaled first, then runs; an interrupted one goes on
   * at the next start.
   */
  /**
   * "Share section…" as one flow per note (F-03): the preview, then the
   * creation of what was approved. A second start on the same note while
   * one runs (its preview open, or its section being created) opens no
   * second preview and creates nothing: it brings the open preview forward,
   * or says where the running flow stands (LFCP-03-002). Every entry path
   * (palette, hotkey, and the menu, card and pane entries to come) calls
   * this method, so they share the one reservation.
   */
  share(editor: Editor, path: string): Promise<void> {
    return this.#oneFlow(path, "share", async (target, flow) => {
      const approved = await this.shareSection(editor, path, flow, target);
      if (approved === null) return;
      // The note as it is now: renamed meanwhile, its new path; deleted, nothing.
      if (target.path === null) {
        new Notice(
          "Shared Tasks: the note was deleted while the preview was open. Nothing was shared.",
        );
        return;
      }
      flow.stage = `section "${approved.title}" is being shared from this note. Its result shows when it is done.`;
      await this.createSection(target.path, editor.getValue(), approved, target);
    });
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
  ): Promise<void> {
    const held = this.#targets.hold(path);
    try {
      await this.#flows.run(
        `note:${held.target.id}`,
        (running) => this.#revealFlow(running),
        (flow) => body(held.target, flow),
        kind === "share"
          ? "a section of this note is being shared."
          : "a section is being inserted into this note.",
      );
    } finally {
      held.release();
    }
  }

  /** A repeated start of a running flow: its open dialog brought forward, else where it stands. */
  #revealFlow(running: Flow): void {
    if (running.reveal()) return;
    const text = `Shared Tasks: ${running.stage}`;
    new Notice(text);
    this.announce(text);
  }

  /** While `modal` is open, a repeated start of `flow` brings it forward and says so. */
  #showing(flow: Flow | undefined, modal: Modal, what: string): void {
    flow?.showing(() => {
      bringForward(modal);
      this.announce(`Shared Tasks: ${what} is open. Finish or cancel it first.`);
    });
  }

  /** The vault renamed a note (its event, as it happens): a flow on it follows it. */
  noteRenamed(oldPath: string, path: string): void {
    this.#targets.renamed(oldPath, path);
  }

  /** The vault deleted a note: a flow on it writes nothing. */
  noteDeleted(path: string): void {
    this.#targets.deleted(path);
  }

  async createSection(
    path: string,
    markdown: string,
    preview: SharePreview,
    /** The note held by the flow: a rename before the note is bound is followed (LFCP-03-002). */
    target?: NoteTarget,
  ): Promise<void> {
    const creation = this.#creation;
    if (creation === null) {
      new Notice("Shared Tasks: still starting. Share the section again in a moment.");
      return;
    }
    if (this.server().trim() === "") {
      new Notice("Shared Tasks: set a default sync server in the settings to share a section.");
      return;
    }
    const entry = await creation.prepare(path, markdown, preview);
    await this.#finish(entry, target).then((r) => notifyCreation(entry, r), notifyFailure(entry));
  }

  /**
   * "Insert shared section…" (LFCP-02-052): a ready, fully loaded section
   * of this vault, previewed, then written after the block at the cursor
   * as one complete projection.
   */
  insertSection(editor: Editor, path: string): Promise<void> {
    return this.#oneFlow(path, "insert", (target, flow) =>
      this.#insertSection(editor, target, flow),
    );
  }

  async #insertSection(editor: Editor, target: NoteTarget, flow: Flow): Promise<void> {
    const runtime = this.#runtime;
    const insertion = this.#insertion;
    if (runtime === null || insertion === null) {
      new Notice("Shared Tasks: still starting. Try again in a moment.");
      return;
    }
    const choices: SectionChoice[] = [];
    for (const entry of await runtime.registry()) {
      if (entry.profile !== SECTIONS_PROFILE_ID) continue;
      const replica = runtime.sectionProfile(entry.resourceId)?.replica;
      const snap = replica?.snapshot();
      const sectionId = (replica?.toJSON() as { section?: { id?: unknown } } | undefined)?.section
        ?.id;
      if (snap === undefined || typeof sectionId !== "string") continue;
      choices.push({ resource: entry.resourceId, sectionId, title: snap.title.value ?? "" });
    }
    if (choices.length === 0) {
      new Notice("Shared Tasks: no shared section on this device yet.");
      return;
    }
    const pick = new PickSectionModal(this.app, choices);
    pick.open();
    this.#showing(flow, pick, "the choice of a section to insert");
    const choice = await pick.result;
    flow.showing(null);
    if (choice === null) return;
    const preview = await insertion.preview(choice.resource as ResourceId, choice.sectionId);
    if ("refused" in preview) {
      new Notice(insertRefusalMessage(preview.refused));
      return;
    }
    await this.#watch(choice.resource as ResourceId);
    const modal = new InsertSectionModal(this.app, preview);
    modal.open();
    this.#showing(flow, modal, "the insert preview");
    const approved = await modal.result;
    flow.showing(null);
    if (!approved) return;
    const path = target.path;
    if (path === null) {
      new Notice(
        "Shared Tasks: the note was deleted while the preview was open. Nothing was inserted.",
      );
      return;
    }
    const entry = await insertion.prepare(
      path,
      editor.getValue(),
      editor.getCursor().line,
      preview,
    );
    const result = await insertion.run(entry);
    notifyInsertion(result);
    if (result.kind === "inserted") {
      this.#index(path, editor.getValue());
      this.editor.remoteChanged(path);
    }
  }

  /** Runs a creation; with the flow's held note, at that note's path at each write. */
  async #finish(entry: CreationEntry, target?: NoteTarget): Promise<CreationResult> {
    const creation = this.#creation as SectionCreation;
    const result = await creation.run(entry, target === undefined ? undefined : () => target.path);
    if (result.kind === "stale") await creation.cancel(result.entry);
    if (result.kind === "hosted" || result.kind === "local") {
      await this.#watch(fromKey(entry.resource));
      // Where the creation bound it: the renamed note's path, if it moved.
      const path = result.entry.path;
      const file = this.app.vault.getFileByPath(path);
      const open = this.#openEditor(path);
      const text = open?.getValue() ?? (file === null ? null : await this.app.vault.read(file));
      if (text !== null) {
        this.#index(path, text);
        if (open !== null) this.editor.remoteChanged(path);
        else this.editor.remoteChanged(path, text);
      }
    }
    return result;
  }

  async #watch(resource: ResourceId): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === null || this.#watched.has(toKey(resource))) return;
    this.#watched.add(toKey(resource));
    const profile = await runtime.openSection(resource);
    profile.onNodesChanged(() => {
      void this.#remote(resource);
      this.scheduleStatus();
    });
    await this.#statusSnapshot(resource);
  }

  /** The SDK's status snapshot of a Resource: at the start, and after a skipped revision. */
  #statusSnapshot(R: ResourceId): Promise<void> {
    return this.#sdk.snapshot(R);
  }

  /**
   * The details card of a section (LFCP-02-059), opened from its badge.
   * Its actions run on the section's Resource after checking it is still
   * here (stable ref, revalidated).
   */
  /**
   * The plugin cannot run here (another instance holds this vault's data):
   * the cards say so, and what to do, instead of "still loading".
   */
  unavailable(message: string | null): void {
    this.#unavailable = message;
  }
  #unavailable: string | null = null;

  async openCard(key: string, title: string): Promise<void> {
    if (this.#unavailable !== null) {
      new Notice(this.#unavailable);
      return;
    }
    const content = await this.#cardContent(key, title);
    if (content === null) {
      new Notice("Shared Tasks: this section is still loading. Try again in a moment.");
      return;
    }
    const R = fromBase64url(key.slice(0, key.indexOf("#"))) as ResourceId;
    const still =
      (run: (c: NonNullable<ReturnType<typeof this.commands>>) => Promise<void>) => () => {
        const commands = this.commands();
        if (!this.#statuses.has(key) || commands === null) {
          new Notice("Shared Tasks: this section is no longer on this device.");
          return;
        }
        void run(commands);
      };
    const conflicts = this.#recoveryItems(key);
    const kept = await this.#keptCopies(key);
    const actions = [
      // Conflicts are resolved one by one, by the user (061).
      ...(conflicts.length > 0
        ? [{ label: "Review conflicts…", run: () => this.#openRecovery(key, title) }]
        : []),
      // Inviting is offered by the validated access (060), never by default.
      ...(content.access?.canInvite === true && this.#runtime?.sectionsReadOnly !== true
        ? [{ label: "Invite collaborator…", run: still((c) => c.inviteTo(R)) }]
        : []),
      // F-04: where edits are held, and the repair of that note.
      ...(content.held[0] === undefined
        ? []
        : [
            {
              label: `Go to line ${content.held[0].line + 1}`,
              run: () =>
                void this.#goToLine(content.held[0]?.path ?? "", content.held[0]?.line ?? 0),
            },
            ...(["unsupported", "binding", "boundary", "base-unknown"].includes(
              content.held[0].cause,
            )
              ? [
                  {
                    label: "Repair shared sections in this note",
                    run: () => void this.#repairAt(content.held[0]?.path ?? ""),
                  },
                ]
              : []),
          ]),
      { label: "Resource status", run: still((c) => c.resourceStatusOf(R)) },
      // Text kept on this device after a refusal (a local copy, never applied by itself).
      ...(kept.length > 0
        ? [
            {
              label: `Discard ${kept.length === 1 ? "the local copy" : `${kept.length} local copies`}…`,
              run: () => void this.#discardKept(key, title),
            },
          ]
        : []),
    ];
    this.#card?.modal.close();
    const modal = new SectionCardModal(
      this.app,
      content,
      actions,
      () => {
        if (this.#card?.modal === modal) this.#card = null;
      },
      {
        // A local alias: a label of this device for an identity, never sent.
        alias: (id, label) => {
          const ask = new AliasModal(this.app, label.startsWith("Member ") ? "" : label);
          ask.open();
          void ask.result.then(async (name) => {
            if (name === null || this.#runtime === null) return;
            await this.#runtime.localState.update(ALIASES, (v) => {
              const all = { ...((v ?? {}) as Record<string, string>) };
              if (name.trim() === "") delete all[id];
              else all[id] = name.trim();
              return all;
            });
            const fresh = await this.#cardContent(key, title);
            if (fresh !== null) modal.update(fresh);
          });
        },
        // 060: confirmed first; queued is pending until the server commits it.
        // V3: no access change from a device where sections are read-only.
        ...(this.#runtime?.sectionsReadOnly === true
          ? {}
          : {
              remove: (principal: string, label: string) => {
                const ask = new ConfirmModal(
                  this.app,
                  `Remove access: ${label}`,
                  REMOVE_CONFIRMATION,
                  "Remove access",
                );
                ask.open();
                void ask.result.then(async (yes) => {
                  const runtime = this.#runtime;
                  if (!yes || runtime === null) return;
                  const aliases = ((await runtime.localState.get(ALIASES)) ?? {}) as Record<
                    string,
                    string
                  >;
                  let message: string;
                  try {
                    const r = await runtime.revokeSectionAccess(
                      R,
                      fromHex(principal) as PrincipalId,
                    );
                    message = revokeMessage(
                      r.kind === "refused"
                        ? { kind: "refused", reason: r.reason }
                        : {
                            kind: "queued",
                            rotated: r.epoch !== null,
                            remainingPaths: r.remainingPaths.map((p) => ({
                              issuer: toHex(p.issuer),
                              abilities: p.abilities,
                            })),
                          },
                      (hex) => aliases[hex.slice(0, 8)] ?? `Member ${hex.slice(0, 8)}`,
                    );
                  } catch {
                    // Outcome unknown: the access list says whether a change is pending.
                    message =
                      "Removing access failed. The access list shows whether a change is pending.";
                  }
                  new Notice(`Shared Tasks: ${message}`);
                  const fresh = await this.#cardContent(key, title);
                  if (fresh !== null && this.#card?.modal === modal) modal.update(fresh);
                });
              },
            }),
      },
    );
    this.#card = { key, title, modal };
    modal.open();
  }

  /**
   * "Repair shared sections in this note" (062): broken boundaries with
   * their candidate lines, problems to locate, and sections whose base is
   * lost, compared. Nothing changes without the user's choice.
   */
  async repairNote(editor: Editor, path: string): Promise<void> {
    const port = this.#port;
    const bases = this.#bases;
    const journal = this.#journal;
    if (port === null || bases === null || journal === null) {
      new Notice("Shared Tasks: still starting. Try again in a moment.");
      return;
    }
    const md = editor.getValue();
    const items = repairItems(md);
    const known = new Set<string>();
    for (const id of await bases.projectionsOf(path)) {
      const b = await bases.load(id);
      if (b !== undefined) known.add(sectionKey(b.locator.section));
    }
    const lost: (LostBase & { section: ParsedSection; snap: SectionSnapshot; block: string })[] =
      [];
    const lines = md.split(/\r?\n/);
    for (const s of parseSections(md).sections) {
      const key = sectionKey(s.ref);
      if (known.has(key)) continue;
      const b64 = toBase64url(s.ref.resourceId);
      const snap = port.snapshot(b64, s.ref.sectionId);
      if (snap === undefined || !snap.ready) continue;
      if (sameState(markdownState(md, s).state, sharedState(snap))) continue;
      const block = renderSection(snap, s.ref, s.heading.level, {
        task: (id) => port.task(b64, id),
        placement: this.refPlacement(),
      });
      if (block === null) continue;
      const local = lines.slice(s.startLine + 1, s.endLine).join("\n");
      const shared = block
        .replace(/\r?\n$/, "")
        .split("\n")
        .slice(2, -1)
        .join("\n");
      lost.push({
        key,
        title: s.heading.title,
        lines: compare(local, shared),
        section: s,
        snap,
        block,
      });
    }
    new RepairModal(this.app, items, lost, {
      boundary: async (item, line) => {
        await this.#edit(path, (current) => {
          // Only on the note the candidates were computed for.
          if (current !== md) return null;
          return [boundaryRepair(current, item, line)];
        });
        this.editor.remoteChanged(path);
      },
      locate: (line) => editor.setCursor({ line, ch: 0 }),
      shareMine: async (key) => {
        const l = lost.find((x) => x.key === key);
        if (l === undefined) return;
        await bases.save(newProjectionId(), adoptedBase(path, l.section.ref, l.snap));
        this.editor.remoteChanged(path);
        new Notice("Shared Tasks: your version of this section is being shared.");
      },
      useShared: async (key) => {
        const l = lost.find((x) => x.key === key);
        if (l === undefined) return;
        // The note's text first, as a recovery copy kept on this device.
        await journal.putCandidate({
          candidateId: `repair:${crypto.randomUUID()}`,
          projectionId: `repair:${path}`,
          reason: "base-unknown",
          sourceText: lines.slice(l.section.heading.line, l.section.endLine + 1).join("\n"),
        });
        let replaced = false;
        await this.#edit(path, (current) => {
          if (current !== md) return null;
          replaced = true;
          return [sharedVersionChange(current, l.section, l.block)];
        });
        if (!replaced) {
          new Notice(
            "Shared Tasks: the note changed meanwhile. Nothing was replaced; open the repair again.",
          );
          return;
        }
        // No base is stored here: the next pass seeds one once the note shows
        // the model (CM11). A base saved now could meet the editor's old text
        // and send the very edit the user chose to drop.
        this.editor.remoteChanged(path);
        new Notice(
          "Shared Tasks: this section shows the shared version now. Your previous text is kept as a recovery copy on this device.",
        );
      },
    }).open();
  }

  /** The copies of section `key`'s text kept on this device after a refusal (not shared). */
  async #keptCopies(key: string): Promise<string[]> {
    const journal = this.#journal;
    if (journal === null) return [];
    const ids: string[] = [];
    for (const c of await journal.allCandidates()) {
      const base = await this.#bases?.load(c.projectionId);
      const section = base === undefined ? undefined : sectionKey(base.locator.section);
      if (section === key || c.projectionId.includes(`#${key}#`)) ids.push(c.candidateId);
    }
    return ids;
  }

  /** Discards the kept copies of section `key`, after asking: the note and the section stay. */
  async #discardKept(key: string, title: string): Promise<void> {
    const ids = await this.#keptCopies(key);
    if (ids.length === 0) return;
    const ask = new ConfirmModal(
      this.app,
      `Local copies of "${title}"`,
      `${ids.length === 1 ? "One copy" : `${ids.length} copies`} of this section's text ${ids.length === 1 ? "was" : "were"} kept on this device when the sync server refused ${ids.length === 1 ? "it" : "them"}. ${ids.length === 1 ? "It is" : "They are"} not shared. Discard ${ids.length === 1 ? "it" : "them"}? Your note and the shared section are not changed.`,
      "Discard",
    );
    ask.open();
    if (!(await ask.result)) return;
    for (const id of ids) await this.#journal?.resolveCandidate(id);
    new Notice(
      `Shared Tasks: ${ids.length === 1 ? "the local copy was" : `${ids.length} local copies were`} discarded.`,
    );
    this.scheduleStatus();
  }

  readonly #soon = new Map<string, number>();
  /** One more pass of note `path` in 2 s (drift marks wait for a pass with the same Text). */
  #passSoon(path: string): void {
    if (this.#soon.has(path)) return;
    this.#soon.set(
      path,
      window.setTimeout(() => {
        this.#soon.delete(path);
        const file = this.app.vault.getFileByPath(path);
        if (this.#openEditor(path) !== null) this.editor.remoteChanged(path);
        else if (file !== null)
          void this.app.vault.read(file).then((md) => this.editor.remoteChanged(path, md));
      }, 2000),
    );
  }

  /** A failure of the bookkeeping after a flushed pass: said once, never an unhandled rejection. */
  #bookkeepingFailed(error: unknown): void {
    if (this.#passErrors.shouldShow("", error instanceof Error ? error.message : String(error)))
      this.onError("a note", error);
  }

  /** "Review conflicts…" (061): each conflict, its alternatives, one choice at a time. */
  #openRecovery(key: string, title: string): void {
    const port = this.#port;
    if (port === null) return;
    const b64 = key.slice(0, key.indexOf("#"));
    const sectionId = key.slice(key.indexOf("#") + 1);
    new RecoveryModal(this.app, title, this.#recoveryItems(key), async (item, choice) => {
      if (item.kind === "stale-work") {
        const note =
          (await this.#stale?.resolve(
            key.slice(0, key.indexOf("#")),
            item.operationId,
            "keep" in choice && choice.keep,
          )) ?? "";
        return { items: this.#recoveryItems(key), note };
      }
      if (item.kind === "reappeared") {
        const note = await this.#resolveReappeared(key, item.nodeId, "restore" in choice);
        this.scheduleStatus();
        return { items: this.#recoveryItems(key).filter((i) => i.key !== item.key), note };
      }
      // Alone, as a pass: no coalesced pass is committed in the middle of it.
      const out = await port.exclusive(b64, () =>
        applyRecovery(port, b64, sectionId, item, choice, crypto.randomUUID()),
      );
      if (out.applied) this.scheduleStatus();
      return out;
    }).open();
  }

  /** What the card of `key` says now, or null while its status is unknown. */
  async #cardContent(key: string, title: string): Promise<SectionCard | null> {
    const view = this.#statuses.get(key);
    const at = key.indexOf("#");
    if (view === undefined || at < 0) return null;
    const b64 = key.slice(0, at);
    const sectionId = key.slice(at + 1);
    const R = fromBase64url(b64) as ResourceId;
    const status = await this.collab()
      ?.status(R)
      .catch(() => undefined);
    // D1: a model that throws when read still gets its card (its problem, no counts).
    let model: Readonly<Record<string, ModelNode>> = {};
    try {
      model = this.#port?.snapshot(b64, sectionId)?.nodes ?? {};
    } catch {
      model = {};
    }
    const nodes = Object.values(model).filter((n) => n.lifecycle === "active" && n.hidden !== true);
    const count = (kind: string) => nodes.filter((n) => n.kind === kind).length;
    const runtime = this.#runtime;
    const mine = await runtime?.sectionAccessState(R).catch(() => undefined);
    const history = runtime?.sectionHistory(R);
    const aliases = ((await runtime?.localState.get(ALIASES)) ?? {}) as Record<string, string>;
    const access = accessView({
      participants: status?.participants ?? [],
      mine:
        mine === undefined || mine.verifiedAt === null
          ? null
          : {
              allowed: mine.allowed,
              ...(mine.reason === null ? {} : { reason: mine.reason }),
              current: mine.current,
              verifiedAt: mine.verifiedAt,
              abilities: mine.abilities,
              owner: mine.owner,
              pendingControl: mine.pendingControl.map((p) => p.type),
            },
      aliases,
      connected: runtime?.phase(R) === "LIVE",
      time: (ms) => `at ${new Date(ms).toLocaleTimeString()}`,
    });
    return sectionCard({
      title,
      view,
      resource: b64,
      sectionId,
      ...(status === undefined ? {} : { hosting: status.hosting }),
      access,
      counts: { tasks: count("task"), paragraphs: count("paragraph"), items: count("item") },
      ...(history === undefined ? {} : { history }),
    });
  }

  /**
   * A waiting pass committed after a pause, or failed (025): out of any
   * engine pass. Committed: the next pass of its note finds the receipt and
   * moves the base (as after a crash). Failed: its entry is closed, and the
   * next pass plans the edit, still in the note, again.
   */
  async #flushed(journal: KeyValueSectionJournalStore, f: Flushed): Promise<void> {
    const entry = await journal.get(f.operationId);
    // A pass may have settled it meanwhile (resumed, replaced or refused): nothing left to do.
    if (entry === undefined || entry.phase === "done" || entry.phase === "abandoned") return;
    const base = await this.#bases?.load(entry.projectionId);
    const path = base?.locator.path;
    const file = path === undefined ? null : this.app.vault.getFileByPath(path);
    if (f.kind === "failed") {
      const refusal = portRefusal(f.error);
      // A refusal is final for these intents: the next pass would plan them
      // again. The edit stays in the note as a candidate, like a refused
      // direct commit, and no pass is forced. A stale base or an import in
      // progress is replanned instead.
      if (
        refusal instanceof CommitRefused &&
        refusal.code !== "STALE_BASE" &&
        refusal.code !== "SECTION_IMPORTING"
      ) {
        if ((await abandonOnce(journal, entry.operationId, refusal.code)) === undefined) return;
        if (base !== undefined)
          this.#projectionFacts.fail(
            sectionKey(base.locator.section),
            entry.projectionId,
            entry.operationId,
          );
        const md =
          path === undefined
            ? undefined
            : (this.#openEditor(path)?.getValue() ??
              (file === null ? undefined : await this.app.vault.read(file)));
        const s =
          md === undefined || base === undefined
            ? undefined
            : parseSections(md).sections.find((x) => sameSection(x.ref, base.locator.section));
        if (md !== undefined && s !== undefined)
          await journal.putCandidate({
            candidateId: entry.operationId,
            projectionId: entry.projectionId,
            reason: "rejected",
            sourceText: splitLines(md)
              .slice(s.heading.line, s.endLine + 1)
              .map((l) => l.text + l.eol)
              .join(""),
          });
        // INVALID_INTENT: the Text edit was planned on a base that drifted
        // from the model (0.4.0-beta.6). The next pass shows the model's Text
        // for its nodes (SectionEngine.drifted), so a pass runs now.
        if (refusal.code !== "INVALID_INTENT") {
          this.scheduleStatus();
          return;
        }
        const ids = (
          (entry.intents ?? f.intents) as readonly {
            readonly intent: string;
            readonly id?: string;
          }[]
        ).flatMap((i) => (i.intent === "text.edit" && i.id !== undefined ? [i.id] : []));
        await this.#engine?.drifted(entry.projectionId, ids);
      } else {
        if ((await abandonOnce(journal, entry.operationId, "flush-failed")) === undefined) return;
        if (base !== undefined)
          this.#projectionFacts.fail(
            sectionKey(base.locator.section),
            entry.projectionId,
            entry.operationId,
          );
      }
    }
    if (path === undefined) return;
    if (this.#openEditor(path) !== null) this.editor.remoteChanged(path);
    else if (file !== null) this.editor.remoteChanged(path, await this.app.vault.read(file));
    this.scheduleStatus();
  }

  /** The typing coalescers' timer (025). */
  tick(): void {
    void this.#port?.tick(Date.now()).catch(() => undefined);
  }

  /** Commits all waiting typing (unloading); no pass is due later. */
  async flushTyping(): Promise<void> {
    for (const t of this.#soon.values()) window.clearTimeout(t);
    this.#soon.clear();
    await this.#port?.flushAll().catch(() => undefined);
  }

  /**
   * Pane-ready sync facts (LFCP-03-003): one section's (key: Resource
   * base64url # section ID), held edits, queue and shared model apart;
   * undefined before its first status.
   */
  sectionSync(key: string): SyncFacts | undefined {
    return this.#statuses.get(key)?.sync;
  }

  /**
   * Pane-ready access (LFCP-03-005): this vault's access to one section,
   * each denial apart, with its as-of; undefined before its first status.
   */
  sectionAccess(key: string): AccessFacts | undefined {
    return this.#statuses.get(key)?.access;
  }

  /**
   * Pane-ready connection (LFCP-03-005): one section's connection, why it is
   * not connected, and the server's refusal; undefined before its first status.
   */
  sectionConnection(key: string):
    | {
        readonly connection: StatusFacts["connection"];
        readonly qualifier: ConnectionQualifier | null;
        readonly refusal: string | null;
      }
    | undefined {
    const v = this.#statuses.get(key);
    return v === undefined
      ? undefined
      : { connection: v.connection, qualifier: v.connectionQualifier, refusal: v.refusal };
  }

  /** Pane-ready: every watched section's sync, summed per fact, never across them. */
  syncSummary(): VaultSyncSummary {
    return vaultSyncSummary(this.#statuses.values());
  }

  /** Recomputes the sections' statuses soon (several triggers make one pass). */
  scheduleStatus(): void {
    if (this.#statusDue !== null) return;
    this.#statusDue = window.setTimeout(() => {
      this.#statusDue = null;
      void this.#refreshStatus().catch(() => undefined);
    }, 250);
  }

  /**
   * Each section's status from what the runtime shows (provisional facts:
   * no acceptance is ever claimed, core/status/facts.ts); UI only.
   */
  async #refreshStatus(): Promise<void> {
    const runtime = this.#runtime;
    const port = this.#port;
    if (runtime === null || port === null) return;
    // D1: one section whose model throws shows attention; the others go on.
    const next = await collectStatuses(
      this.#watched,
      async (hex) => {
        const R = fromKey64(hex);
        const replica = runtime.sectionProfile(R)?.replica;
        const sectionId = (replica?.toJSON() as { section?: { id?: unknown } } | undefined)?.section
          ?.id;
        if (typeof sectionId !== "string") return null;
        const r = toBase64url(R);
        const snapshot = port.snapshot(r, sectionId);
        // C14: a model change no event announced is still projected, once a
        // lag outlives the passes events started (no duplicate pass).
        const key = `${r}#${sectionId}`;
        if (
          snapshot !== undefined &&
          this.#lags.decide(
            key,
            snapshot.revision,
            this.#projectionFacts.behind(key, snapshot.revision),
          )
        )
          void this.#remote(R);
        const phase = runtime.phase(R);
        if (phase === "LIVE") this.#wasLive.add(hex);
        const facts = observedFacts({
          session: hex,
          load: runtime.sectionLoad(R),
          phase,
          wasLive: this.#wasLive.has(hex),
          problems: snapshot?.problems ?? [],
          projections: this.#projectionFacts.projections(`${r}#${sectionId}`, snapshot?.revision),
          failedOperations: this.#projectionFacts.failedOperations(
            `${toBase64url(R)}#${sectionId}`,
          ),
          sdk: this.#sdk.get(hex),
          // LFCP-02-066: queued units stay pending across a restart, whatever the SDK's batches know.
          queuedUnits:
            (await runtime.storage?.outbound.list(R))?.filter((i) => i.kind === "data-unit")
              .length ?? 0,
          refusal: runtime.refusal(R)?.code ?? null,
          // LFCP-03-005: connecting and failed only from the session's own transitions.
          transport: runtime.transport(R),
          // LFCP-03-003: a note with the section not checked yet may hold edits.
          heldCheck: this.#heldChecks.state(hex),
          ...(this.#stale === null
            ? {}
            : { staleWork: this.#stale.counts(r), settledOperations: this.#stale.settled(r) }),
        });
        return { key: `${r}#${sectionId}`, view: statusView(facts) };
      },
      this.#statusKeys,
    );
    const same =
      next.size === this.#statuses.size &&
      [...next].every(([k, v]) => {
        const old = this.#statuses.get(k);
        return (
          old !== undefined &&
          old.state === v.state &&
          old.pendingBatches === v.pendingBatches &&
          JSON.stringify(old.conditions) === JSON.stringify(v.conditions) &&
          JSON.stringify(old.held) === JSON.stringify(v.held) &&
          JSON.stringify(old.sync) === JSON.stringify(v.sync) &&
          JSON.stringify(old.access) === JSON.stringify(v.access) &&
          old.connection === v.connection &&
          old.connectionQualifier === v.connectionQualifier &&
          old.refusal === v.refusal &&
          old.label === v.label &&
          [...old.pendingNodeIds].join() === [...v.pendingNodeIds].join()
        );
      });
    if (same) return;
    this.#statuses = next;
    for (const view of this.status.views) view.dispatch({ effects: setSectionStatuses.of(next) });
    const said = this.#announcer.next(next, (key) => {
      const at = key.indexOf("#");
      return port.snapshot(key.slice(0, at), key.slice(at + 1))?.title ?? "";
    });
    if (said.length > 0) this.announce(said.join(" "));
    this.reading.update();
    const card = this.#card;
    if (card !== null) {
      const content = await this.#cardContent(card.key, card.title);
      if (content !== null) card.modal.update(content);
    }
  }

  /**
   * What diagnostics show of the shared sections (LFCP-02-065): each one's
   * state, condition kinds and codes (a save failure's refusal code) and
   * pending count; the kept candidates' reasons, sizes and refusal codes. No
   * text, path, title or node ID.
   */
  async diagnostics(): Promise<{
    readonly sections: SectionFacts[];
    readonly candidates: KeptCandidate[];
  }> {
    const journal = this.#journal;
    const sections: SectionFacts[] = [];
    for (const [key, v] of this.#statuses) {
      const conditions: string[] = [];
      for (const c of v.conditions)
        if (c.kind === "save-failed")
          conditions.push(
            ...(journal === null
              ? ["save-failed"]
              : await saveFailedConditions(journal, c.batchIds)),
          );
        else
          conditions.push(
            c.kind === "rejected"
              ? `rejected:${c.code}`
              : c.kind === "source"
                ? `source-${c.source}`
                : c.kind === "access"
                  ? `access-${c.access}`
                  : c.kind,
          );
      sections.push({ key, state: v.state, conditions, pendingBatches: v.pendingBatches });
    }
    return {
      sections,
      candidates: journal === null ? [] : await keptCandidates(journal),
    };
  }

  /**
   * "Detach this section" (§10, MS10-detach): after a confirmation, the
   * section under the cursor loses every binding in this note and keeps its
   * text as private text; this note's projection base is dropped. Nothing
   * is published: the shared section, other notes and collaborators are
   * unchanged.
   */
  async detachSectionAt(editor: Editor, path: string): Promise<void> {
    const md = editor.getValue();
    const found = detachAt(md, editor.getCursor().line);
    if (found === null) {
      new Notice("Shared Tasks: put the cursor in a shared section to detach it.");
      return;
    }
    const ask = new ConfirmModal(
      this.app,
      `Detach "${found.title}" in this note`,
      "Its text stays in this note as your own and no longer updates. The shared section, your other notes and your collaborators are not changed.",
      "Detach",
    );
    ask.open();
    if (!(await ask.result)) return;
    let detached = false;
    await this.#edit(path, (current) => {
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
      new Notice("Shared Tasks: the note changed meanwhile. Nothing was detached; try again.");
      return;
    }
    const bases = this.#bases;
    if (bases !== null)
      for (const id of await bases.projectionsOf(path)) {
        const b = await bases.load(id);
        if (b !== undefined && sameSection(b.locator.section, found.section)) {
          await bases.save(id, null);
          this.#projectionFacts.forget(sectionKey(found.section), id);
        }
      }
    this.editor.remoteChanged(path);
    new Notice(
      `Shared Tasks: "${found.title}" is no longer shared in this note. The shared section itself is unchanged.`,
    );
  }

  /** "Open shared section details" (064): the card of the section under the cursor. */
  openCardAt(editor: Editor): void {
    const at = sectionAtLine(editor.getValue(), editor.getCursor().line);
    if (at === null) {
      new Notice("Shared Tasks: put the cursor in a shared section to see its details.");
      return;
    }
    void this.openCard(at.key, at.title);
  }

  /**
   * "Resolve shared task conflict" with the cursor in a shared section
   * (F-05): that section's "Review conflicts…", as its card opens it.
   */
  reviewConflictsAt(text: string, line: number): void {
    if (this.#unavailable !== null) {
      new Notice(this.#unavailable);
      return;
    }
    const at = sectionAtLine(text, line);
    if (at === null) {
      new Notice("Shared Tasks: put the cursor in a shared section to review its conflicts.");
      return;
    }
    if (this.#port === null || !this.#statuses.has(at.key)) {
      new Notice("Shared Tasks: this section is still loading. Try again in a moment.");
      return;
    }
    this.#openRecovery(at.key, at.title);
  }

  /**
   * "Go to next shared section problem" (064, UX09): the next row needing
   * attention after the cursor, unfolded if a fold hides it, said once.
   */
  nextProblem(view: MarkdownView): void {
    const cm = [...this.status.views].find((v) => view.containerEl.contains(v.dom));
    const said = goToNextProblem(cm, this.#statuses);
    if (said.found === 0) new Notice(`Shared Tasks: ${said.text}`);
    this.announce(said.text);
  }

  /** The note at `path` in an editor (opened if needed), the cursor on `line` (F-04). */
  async #goToLine(path: string, line: number): Promise<Editor | null> {
    let editor = this.#openEditor(path);
    if (editor === null) {
      const file = this.app.vault.getFileByPath(path);
      if (file === null) {
        new Notice("Shared Tasks: that note is no longer in the vault.");
        return null;
      }
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      editor = leaf.view instanceof MarkdownView ? leaf.view.editor : null;
    }
    if (editor === null) return null;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown"))
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        const cm = [...this.status.views].find((v) => leaf.view.containerEl.contains(v.dom));
        if (cm !== undefined) revealLine(cm, line);
        else {
          editor.setCursor({ line, ch: 0 });
          editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
        }
        break;
      }
    return editor;
  }

  /** "Repair shared sections in this note" from a card (F-04): the note opened first. */
  async #repairAt(path: string): Promise<void> {
    const editor = await this.#goToLine(path, this.#openEditor(path)?.getCursor().line ?? 0);
    if (editor !== null) await this.repairNote(editor, path);
  }

  #openEditor(path: string): Editor | null {
    // A note shown only in Reading view is not open for editing: Obsidian keeps
    // its editor, but never saves what is written there (LFCP-02-069).
    for (const leaf of this.app.workspace.getLeavesOfType("markdown"))
      if (
        leaf.view instanceof MarkdownView &&
        leaf.view.file?.path === path &&
        leaf.view.getMode() !== "preview"
      )
        return leaf.view.editor;
    return null;
  }

  /** The changes `fn` computes, on the open editor's text, else on the file's. */
  async #edit(
    path: string,
    fn: (current: string) => readonly { from: number; to: number; insert: string }[] | null,
  ): Promise<void> {
    const editor = this.#openEditor(path);
    if (editor !== null) {
      const changes = fn(editor.getValue());
      if (changes === null || changes.length === 0) return;
      // Marked as the plugin's own edit: reconciled, never a move hint.
      const cm = (editor as Editor & { cm?: EditorView }).cm;
      if (cm !== undefined) {
        cm.dispatch({
          changes: changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
          annotations: pluginEdit.of(true),
        });
        return;
      }
      editor.transaction({
        changes: changes.map((c) => ({
          from: editor.offsetToPos(c.from),
          to: editor.offsetToPos(c.to),
          text: c.insert,
        })),
      });
      return;
    }
    const file = this.app.vault.getFileByPath(path);
    if (file === null) return;
    await this.app.vault.process(file, (text) => {
      const changes = fn(text);
      return changes === null ? text : applyChanges(text, changes);
    });
  }

  /**
   * "Share section…" (LFCP-02-049): the heading at or above the cursor
   * proposes the range; the preview shows exactly what would be shared. An
   * approved preview is revalidated against the note as it is then (UX02):
   * a changed range is shown again. Returns the approved preview, or null.
   */
  async shareSection(
    editor: Editor,
    path: string,
    flow?: Flow,
    target?: NoteTarget,
  ): Promise<SharePreview | null> {
    // V3: no new shared section from a device where sections are read-only.
    if (this.#runtime?.sectionsReadOnly === true) {
      new Notice(`Shared Tasks: ${SECTIONS_READ_ONLY}.`);
      return null;
    }
    const md = editor.getValue();
    let line = editor.getCursor().line;
    let range: ShareRange | null = null;
    for (; line >= 0 && range === null; line--) range = proposeRange(md, line);
    if (range === null) {
      new Notice("Shared Tasks: put the cursor on or under a heading to share its section.");
      return null;
    }
    let preview = preflight(md, range);
    // 0.1 shared Tasks in the range, and nothing else in the way: the explicit import (053).
    if (
      preview.problems.length > 0 &&
      preview.problems.every((p) => p.code === "LEGACY_SHARED_TASKS")
    ) {
      await this.#importFlow(editor, target ?? { id: 0, path }, range, preview.title, flow);
      return null;
    }
    let note: string | undefined;
    for (;;) {
      const modal = new ShareSectionModal(this.app, preview, note);
      modal.open();
      this.#showing(flow, modal, `the share preview of "${preview.title}"`);
      const approved = await modal.result;
      flow?.showing(null);
      if (!approved) return null;
      const now = revalidate(editor.getValue(), preview);
      if (now.kind !== "changed") return now.preview;
      if (now.preview === null) {
        new Notice("Shared Tasks: the section's heading is gone. Nothing was shared.");
        return null;
      }
      preview = now.preview;
      note = "The note changed while the preview was open. Review the section again.";
    }
  }

  /**
   * Imports a range with 0.1 shared Tasks into a new shared section (053,
   * 054): the preview and the user's choices first, then the journaled
   * creation; the note's refs are replaced only once the copy is durable.
   */
  async #importFlow(
    editor: Editor,
    target: NoteTarget,
    range: ShareRange,
    title: string,
    flow?: Flow,
  ): Promise<void> {
    const runtime = this.#runtime;
    const creation = this.#creation;
    if (runtime === null || creation === null) {
      new Notice("Shared Tasks: still starting. Try again in a moment.");
      return;
    }
    const md = editor.getValue();
    // The sources as this device holds them now (0.1 collaborations).
    const sources = new Map<string, LegacySource>();
    for (const p of scanRefs(md).projections) {
      if (p.taskLine <= range.headingLine || p.taskLine > range.lastLine) continue;
      const key = `${toBase64url(p.resourceId)}#${p.objectId}`;
      if (sources.has(key)) continue;
      try {
        const R = p.resourceId as ResourceId;
        const replica = (await runtime.profileOf(R)).replica;
        const view = replica.task(p.objectId);
        const pending = ((await runtime.storage?.outbound.list(R)) ?? []).length > 0;
        if (view !== undefined)
          sources.set(key, { view, revision: replica.heads().join(","), pending });
      } catch {
        // Not on this device, or another profile: the preflight blocks it.
      }
    }
    const source = (resource: string, objectId: string) => sources.get(`${resource}#${objectId}`);
    const preview = legacyPreflight(md, range, source);
    const modal = new ImportSectionModal(this.app, title, preview);
    modal.open();
    this.#showing(flow, modal, `the import preview of "${title}"`);
    const chosen = await modal.result;
    flow?.showing(null);
    if (chosen === null) return;
    const path = target.path;
    if (path === null) {
      new Notice(
        "Shared Tasks: the note was deleted while the preview was open. Nothing was imported.",
      );
      return;
    }
    if (flow !== undefined) flow.stage = `section "${title}" is being imported from this note.`;
    if (this.server().trim() === "") {
      new Notice("Shared Tasks: set a default sync server in the settings to share a section.");
      return;
    }
    let entry: CreationEntry;
    try {
      entry = await creation.prepareImport(path, editor.getValue(), range, source, chosen);
    } catch (e) {
      new Notice(
        `Shared Tasks: the import cannot start (${e instanceof Error ? e.message : String(e)}). Nothing changed.`,
      );
      return;
    }
    await this.#finish(entry, target).then((r) => notifyCreation(entry, r), notifyFailure(entry));
  }

  /**
   * "Restore note before section import" (054): the latest import in this
   * note gets its original view back; edits made on the new section since
   * are kept beside it. The new section itself, and any invitation to it,
   * stay as they are.
   */
  async restoreImport(path: string): Promise<void> {
    const creation = this.#creation;
    if (creation === null) return;
    const last = (await creation.imports(path)).at(-1);
    if (last === undefined) {
      new Notice("Shared Tasks: no section import to restore in this note.");
      return;
    }
    const out = await creation.rollback(last);
    new Notice(
      out.kind === "restored"
        ? "Shared Tasks: the note shows its content from before the import again. The new shared section still exists; to stop sharing it, remove people's access."
        : out.kind === "beside"
          ? "Shared Tasks: the section was edited since the import, so the content from before is added after it for comparison. Nothing was removed."
          : "Shared Tasks: this import cannot be restored here (its section is not in the note).",
    );
  }

  /** The vault changed: notes with sections are indexed and reconciled when closed. */
  async vaultChange(c: VaultChange): Promise<void> {
    if (c.kind === "delete") {
      this.#unindex(c.path);
      // The last note not checked yet gone: its sections are no longer "Checking…".
      const unchecked = this.#heldChecks.deleted(c.path);
      if (this.#projectionFacts.damaged(c.path, new Set()) || unchecked) this.scheduleStatus();
      this.editor.deleted(c.path);
      return;
    }
    if (c.kind === "rename") {
      this.#placements.rename(c.oldPath, c.path);
      this.#heldChecks.renamed(c.oldPath, c.path);
      // The new path's pass records its damaged copies again.
      if (this.#projectionFacts.damaged(c.oldPath, new Set())) this.scheduleStatus();
      this.editor.renamed(c.oldPath, c.path);
      await this.#bases?.rename(c.oldPath, c.path);
    }
    const file = this.app.vault.getFileByPath(c.path);
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const text = await this.app.vault.read(file);
    // LFCP-03-003: a note holding edits was saved (or changed on disk): is it saved as shown now?
    if (
      this.#projectionFacts.holds(c.path) &&
      this.#projectionFacts.persisted(c.path, await this.#persistence(c.path, text))
    )
      this.scheduleStatus();
    const known = this.#placements.has(c.path);
    if (!known && !text.includes(SECTION_MARK)) return;
    this.#index(c.path, text);
    this.editor.fileChanged(c.path, text);
  }

  #index(path: string, text: string): void {
    this.#placements.index(path, noteSections(parseSections(text)));
  }

  #unindex(path: string): void {
    this.#placements.unindex(path);
  }

  /** A section's model changed: a pass on each note that holds it. */
  async #remote(resource: ResourceId): Promise<void> {
    for (const path of this.#placements.notesWith(toKey(resource))) {
      const open = this.app.workspace
        .getLeavesOfType("markdown")
        .some((l) => l.view instanceof MarkdownView && l.view.file?.path === path);
      if (open) this.editor.remoteChanged(path);
      else {
        const file = this.app.vault.getFileByPath(path);
        if (file !== null) this.editor.remoteChanged(path, await this.app.vault.read(file));
      }
    }
  }
}

/** What became of a creation, in a notice (UX §3). */
function notifyCreation(entry: CreationEntry, r: CreationResult): void {
  const title = entry.preview.title;
  if (r.kind === "hosted") new Notice(`Shared Tasks: section "${title}" is shared.`);
  else if (r.kind === "local")
    new Notice(
      `Shared Tasks: section "${title}" was created on this device; invitation is not ready yet. ${r.reason}`,
    );
  else if (r.kind === "stale")
    new Notice(
      `Shared Tasks: section "${title}" changed since the preview. Nothing was bound; share it again.`,
    );
  else if (r.kind === "failed")
    new Notice(`Shared Tasks: section "${title}" could not be created (${r.reason}).`);
}

function notifyInsertion(r: InsertResult): void {
  if (r.kind === "stale")
    new Notice("Shared Tasks: the note changed where the section would go. Insert it again.");
  else if (r.kind === "inserted" && (r.entry.warnings ?? []).length > 0)
    new Notice(
      "Shared Tasks: section inserted. The private text after it, up to the next heading, stays private but moves with its heading.",
    );
}

const notifyFailure = (entry: CreationEntry) => (e: unknown) => {
  new Notice(
    `Shared Tasks: creating section "${entry.preview.title}" stopped (${e instanceof Error ? e.message : String(e)}). It goes on at the next start.`,
  );
};

const fromKey = (b64: string): ResourceId => fromBase64url(b64) as ResourceId;

/**
 * An open dialog brought in front of any other and focused (a repeated
 * start of its flow). The dialog itself takes the focus, never its Share
 * or Insert button: a repeated hotkey followed by Enter must not confirm.
 */
function bringForward(modal: Modal): void {
  const box = (modal as { containerEl?: HTMLElement }).containerEl;
  box?.parentElement?.appendChild(box);
  const el = modal.modalEl;
  // Focusable without entering the Tab order (the test mock's elements have no attributes).
  if (typeof el.setAttribute === "function" && !el.hasAttribute("tabindex"))
    el.setAttribute("tabindex", "-1");
  el.focus?.();
}

/** Local aliases of identities (Principal ID → label), in the plugin's local state. */
const ALIASES = "identity-aliases";

const fromKey64 = (hex: string): ResourceId => fromHex(hex) as ResourceId;

const toKey = (r: Uint8Array): string =>
  [...r].map((b) => b.toString(16).padStart(2, "0")).join("");
