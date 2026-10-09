// Shared sections in the plugin (MVP 0.2), behind the `sectionsPreview`
// development flag (off by default, set in data.json only): the editor
// extension, the engine on the real SDK (the runtime's sessions, its
// install database), the notes that hold sections, and the events that
// start passes. Not reachable with the flag off: the plugin then creates
// none of this.
//
// The sync status comes from the SDK's status stream (026) and what the
// plugin observes of the session and the model (core/status/facts.ts).

import type { Flushed } from "@openlfcp/client";
import {
  fromBase64url,
  fromHex,
  generateObjectId,
  generateResourceId,
  type PrincipalId,
  type ResourceId,
  toBase64url,
  toHex,
} from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import type { LfcpStorage } from "@openlfcp/storage";
import { type App, type Editor, MarkdownView, Notice, TFile } from "obsidian";
import type { Collaboration } from "../core/collab/service";
import type { SectionFacts } from "../core/diagnostics";
import { type LfcpRuntime, SECTIONS_READ_ONLY } from "../core/lfcp/runtime";
import { portRefusal, SdkSectionPort } from "../core/lfcp/section-port";
import { scanRefs } from "../core/refs";
import { splitLines } from "../core/refs/lines";
import { markdownState, newProjectionId } from "../core/sections/base";
import { type CreationEntry, type CreationResult, SectionCreation } from "../core/sections/create";
import { applyChanges, SectionEngine, sameState, sharedState } from "../core/sections/engine";
import { sameSection } from "../core/sections/grammar";
import { type InsertResult, renderSection, SectionInsertion } from "../core/sections/insert";
import { advance } from "../core/sections/journal";
import { type LegacySource, legacyPreflight } from "../core/sections/legacy";
import { type ParsedSection, parseSections } from "../core/sections/parser";
import { CommitRefused, type SectionSnapshot } from "../core/sections/port";
import { applyRecovery, recoveryItems } from "../core/sections/recovery";
import {
  adoptedBase,
  boundaryRepair,
  compare,
  repairItems,
  sharedVersionChange,
} from "../core/sections/repair";
import { detachAt } from "../core/sections/rules";
import {
  preflight,
  proposeRange,
  revalidate,
  type SharePreview,
  type ShareRange,
} from "../core/sections/share";
import { KeyValueSectionBaseStore, KeyValueSectionJournalStore } from "../core/sections/stores";
import { newSectionTask } from "../core/sections/task-fields";
import type { RefPlacement, SectionComments } from "../core/settings";
import { Announcer } from "../core/status/a11y";
import { accessView, REMOVE_CONFIRMATION, revokeMessage } from "../core/status/access";
import { type SectionCard, sectionCard } from "../core/status/card";
import { observedFacts } from "../core/status/facts";
import { LagNudges, ProjectionFactsStore } from "../core/status/projections";
import { type StatusView, statusView } from "../core/status/reducer";
import { applySdkEvent, fromSnapshot, type SdkStatus } from "../core/status/sdk-status";
import type { VaultChange } from "../core/vault/changes";
import { sectionEditorExtension } from "./section-editor";
import {
  goToNextProblem,
  ReadingBadges,
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

export class SectionsHost {
  #engine: SectionEngine | null = null;
  #creation: SectionCreation | null = null;
  #insertion: SectionInsertion | null = null;
  #runtime: LfcpRuntime | null = null;
  /** Section Resources whose model changes start passes (hex of the ID). */
  readonly #watched = new Set<string>();
  #bases: KeyValueSectionBaseStore | null = null;
  /** Notes that hold a section, by the section's Resource (hex of its ID). */
  readonly #notes = new Map<string, Set<string>>();
  readonly editor: ReturnType<typeof sectionEditorExtension>;
  /** Section status badges (LFCP-02-058): in editors, and in Reading view. */
  readonly status = sectionStatusExtension(
    () => this.#statuses,
    (key, title) => void this.openCard(key, title),
  );
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
  /** The SDK's status of each section Resource (hex): batches, acceptance, access (026). */
  readonly #sdk = new Map<string, SdkStatus>();
  /** Section Resources whose session was LIVE in this run (hex). */
  readonly #wasLive = new Set<string>();

  constructor(
    private readonly app: App,
    onError: (path: string, error: unknown) => void,
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
      },
      onError,
      // SI12, SI16: each projection's pass result reaches its section's badge.
      onPass: (path, pass) => {
        let changed = false;
        for (const r of pass.sections)
          if (this.#projectionFacts.note(sectionKey(r.section), r)) changed = true;
        // C17: a copy whose boundary is damaged yields no section result; it is still a problem.
        const damaged = new Set(parseSections(pass.source).damaged.map((d) => sectionKey(d.ref)));
        if (this.#projectionFacts.damaged(path, damaged)) changed = true;
        if (changed) this.scheduleStatus();
      },
    });
  }

  /** The note side of each section's status: projection facts and failed saves (SI12, SI16). */
  readonly #projectionFacts = new ProjectionFactsStore();
  /** C14: a lag no event resolves gets one pass per revision. */
  readonly #lags = new LagNudges();

  /** The runtime is ready: the engine on the real SDK, section Resources opened, their notes reconciled. */
  async start(runtime: LfcpRuntime, principal: PrincipalId): Promise<void> {
    const storage = runtime.storage as LfcpStorage;
    const journal = new KeyValueSectionJournalStore(runtime.localState);
    this.#journal = journal;
    const port = new SdkSectionPort(
      {
        profile: (r) => runtime.sectionProfile(r),
        commit: (r, intents, o) => runtime.commitSection(r, intents, o),
        storage,
        // Contract §6: from the validated Control state; a denied edit stays a candidate.
        canWrite: (r) => runtime.canWriteSection(r),
      },
      // Typing coalescing (025): a burst of typing is one unit, not one per key.
      { now: () => Date.now(), onFlushed: (_r, f) => void this.#flushed(journal, f) },
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
    });
    this.#runtime = runtime;
    this.#port = port;
    runtime.on((e) => {
      if (e.type === "status") this.#statusEvent(e.resourceId, e.event);
      this.scheduleStatus();
    });
    this.#creation = new SectionCreation({
      host: {
        createSectionResource: (o) => runtime.createSectionResource(o),
        openSection: (R) => runtime.openSection(R),
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
    for (const entry of await runtime.registry())
      if (entry.profile === SECTIONS_PROFILE_ID) await this.#watch(entry.resourceId);
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(file);
      if (!text.includes(SECTION_MARK)) continue;
      this.#index(file.path, text);
      this.editor.remoteChanged(file.path, text);
    }
    // Creations a restart interrupted go on from their journal (SSP §12.2).
    for (const entry of await this.#creation.unfinished())
      void this.#finish(entry).then((r) => notifyCreation(entry, r), notifyFailure(entry));
  }

  /**
   * Creates the shared section of an approved preview (LFCP-02-050): the
   * creation is journaled first, then runs; an interrupted one goes on
   * at the next start.
   */
  async createSection(path: string, markdown: string, preview: SharePreview): Promise<void> {
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
    await this.#finish(entry).then((r) => notifyCreation(entry, r), notifyFailure(entry));
  }

  /**
   * "Insert shared section…" (LFCP-02-052): a ready, fully loaded section
   * of this vault, previewed, then written after the block at the cursor
   * as one complete projection.
   */
  async insertSection(editor: Editor, path: string): Promise<void> {
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
    const choice = await pick.result;
    if (choice === null) return;
    const preview = await insertion.preview(choice.resource as ResourceId, choice.sectionId);
    if ("refused" in preview) {
      new Notice(
        preview.refused === "importing"
          ? "Shared Tasks: this section is still being imported. Try again when it is ready."
          : preview.refused === "not-loaded"
            ? "Shared Tasks: this section has not fully arrived yet. Try again in a moment."
            : "Shared Tasks: this section cannot be shown here yet (it has a problem to resolve).",
      );
      return;
    }
    await this.#watch(choice.resource as ResourceId);
    const modal = new InsertSectionModal(this.app, preview);
    modal.open();
    if (!(await modal.result)) return;
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

  async #finish(entry: CreationEntry): Promise<CreationResult> {
    const creation = this.#creation as SectionCreation;
    const result = await creation.run(entry);
    if (result.kind === "stale") await creation.cancel(result.entry);
    if (result.kind === "hosted" || result.kind === "local") {
      await this.#watch(fromKey(entry.resource));
      const file = this.app.vault.getFileByPath(entry.path);
      const open = this.#openEditor(entry.path);
      const text = open?.getValue() ?? (file === null ? null : await this.app.vault.read(file));
      if (text !== null) {
        this.#index(entry.path, text);
        if (open !== null) this.editor.remoteChanged(entry.path);
        else this.editor.remoteChanged(entry.path, text);
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
  async #statusSnapshot(R: ResourceId): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === null) return;
    const snapshot = await runtime.sectionStatusSnapshot(R).catch(() => undefined);
    if (snapshot !== undefined) this.#sdk.set(toKey(R), fromSnapshot(snapshot));
    this.scheduleStatus();
  }

  #statusEvent(R: ResourceId, event: Parameters<typeof applySdkEvent>[1]): void {
    const key = toKey(R);
    const known = this.#sdk.get(key);
    if (known === undefined) {
      if (this.#watched.has(key)) void this.#statusSnapshot(R);
      return;
    }
    const next = applySdkEvent(known, event);
    this.#sdk.set(key, next);
    if (next.needsSnapshot) void this.#statusSnapshot(R);
  }

  /**
   * The details card of a section (LFCP-02-059), opened from its badge.
   * Its actions run on the section's Resource after checking it is still
   * here (stable ref, revalidated).
   */
  async openCard(key: string, title: string): Promise<void> {
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
    const b64 = key.slice(0, key.indexOf("#"));
    const sectionId = key.slice(key.indexOf("#") + 1);
    const model = this.#port?.recoveryModel(b64, sectionId);
    const conflicts = model === undefined ? [] : recoveryItems(model);
    const actions = [
      // Conflicts are resolved one by one, by the user (061).
      ...(conflicts.length > 0
        ? [{ label: "Review conflicts…", run: () => this.#openRecovery(key, title) }]
        : []),
      // Inviting is offered by the validated access (060), never by default.
      ...(content.access?.canInvite === true && this.#runtime?.sectionsReadOnly !== true
        ? [{ label: "Invite collaborator…", run: still((c) => c.inviteTo(R)) }]
        : []),
      { label: "Resource status", run: still((c) => c.resourceStatusOf(R)) },
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

  /** "Review conflicts…" (061): each conflict, its alternatives, one choice at a time. */
  #openRecovery(key: string, title: string): void {
    const port = this.#port;
    if (port === null) return;
    const b64 = key.slice(0, key.indexOf("#"));
    const sectionId = key.slice(key.indexOf("#") + 1);
    const items = () => {
      const m = port.recoveryModel(b64, sectionId);
      return m === undefined ? [] : recoveryItems(m);
    };
    new RecoveryModal(this.app, title, items(), async (item, choice) => {
      const out = await applyRecovery(port, b64, sectionId, item, choice, crypto.randomUUID());
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
    const nodes = Object.values(this.#port?.snapshot(b64, sectionId)?.nodes ?? {}).filter(
      (n) => n.lifecycle === "active" && n.hidden !== true,
    );
    const count = (kind: string) => nodes.filter((n) => n.kind === kind).length;
    const runtime = this.#runtime;
    const mine = await runtime?.sectionAccessState(R).catch(() => undefined);
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
    if (entry === undefined) return;
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
        await journal.put(advance(entry, "abandoned", { reason: refusal.code }));
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
        this.scheduleStatus();
        return;
      }
      await journal.put(advance(entry, "abandoned", { reason: "flush-failed" }));
      if (base !== undefined)
        this.#projectionFacts.fail(
          sectionKey(base.locator.section),
          entry.projectionId,
          entry.operationId,
        );
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

  /** Commits all waiting typing (unloading). */
  async flushTyping(): Promise<void> {
    await this.#port?.flushAll().catch(() => undefined);
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
    const next = new Map<string, StatusView>();
    for (const hex of this.#watched) {
      const R = fromKey64(hex);
      const replica = runtime.sectionProfile(R)?.replica;
      const sectionId = (replica?.toJSON() as { section?: { id?: unknown } } | undefined)?.section
        ?.id;
      if (typeof sectionId !== "string") continue;
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
        failedOperations: this.#projectionFacts.failedOperations(`${toBase64url(R)}#${sectionId}`),
        sdk: this.#sdk.get(hex),
        // LFCP-02-066: queued units stay pending across a restart, whatever the SDK's batches know.
        queuedUnits:
          (await runtime.storage?.outbound.list(R))?.filter((i) => i.kind === "data-unit").length ??
          0,
      });
      next.set(`${r}#${sectionId}`, statusView(facts));
    }
    const same =
      next.size === this.#statuses.size &&
      [...next].every(([k, v]) => {
        const old = this.#statuses.get(k);
        return (
          old !== undefined &&
          old.state === v.state &&
          old.pendingBatches === v.pendingBatches &&
          JSON.stringify(old.conditions) === JSON.stringify(v.conditions) &&
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
   * state, condition kinds and codes and pending count; the kept candidates'
   * reasons and sizes. No text, path, title or node ID.
   */
  async diagnostics(): Promise<{
    readonly sections: SectionFacts[];
    readonly candidates: { readonly reason: string; readonly characters: number }[];
  }> {
    const sections = [...this.#statuses].map(([key, v]) => ({
      key,
      state: v.state,
      conditions: v.conditions.map((c) =>
        c.kind === "rejected"
          ? `rejected:${c.code}`
          : c.kind === "source"
            ? `source-${c.source}`
            : c.kind === "access"
              ? `access-${c.access}`
              : c.kind,
      ),
      pendingBatches: v.pendingBatches,
    }));
    const kept = (await this.#journal?.allCandidates()) ?? [];
    return {
      sections,
      candidates: kept.map((c) => ({ reason: c.reason, characters: c.sourceText.length })),
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
   * "Go to next shared section problem" (064, UX09): the next row needing
   * attention after the cursor, unfolded if a fold hides it, said once.
   */
  nextProblem(view: MarkdownView): void {
    const cm = [...this.status.views].find((v) => view.containerEl.contains(v.dom));
    const said = goToNextProblem(cm, this.#statuses);
    if (said.found === 0) new Notice(`Shared Tasks: ${said.text}`);
    this.announce(said.text);
  }

  #openEditor(path: string): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown"))
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path)
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
  async shareSection(editor: Editor, path: string): Promise<SharePreview | null> {
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
      await this.#importFlow(editor, path, range, preview.title);
      return null;
    }
    let note: string | undefined;
    for (;;) {
      const modal = new ShareSectionModal(this.app, preview, note);
      modal.open();
      if (!(await modal.result)) return null;
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
  async #importFlow(editor: Editor, path: string, range: ShareRange, title: string): Promise<void> {
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
    const chosen = await modal.result;
    if (chosen === null) return;
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
    await this.#finish(entry).then((r) => notifyCreation(entry, r), notifyFailure(entry));
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
      if (this.#projectionFacts.damaged(c.path, new Set())) this.scheduleStatus();
      this.editor.deleted(c.path);
      return;
    }
    if (c.kind === "rename") {
      for (const paths of this.#notes.values()) if (paths.delete(c.oldPath)) paths.add(c.path);
      // The new path's pass records its damaged copies again.
      if (this.#projectionFacts.damaged(c.oldPath, new Set())) this.scheduleStatus();
      this.editor.renamed(c.oldPath, c.path);
      await this.#bases?.rename(c.oldPath, c.path);
    }
    const file = this.app.vault.getFileByPath(c.path);
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const text = await this.app.vault.read(file);
    const known = [...this.#notes.values()].some((p) => p.has(c.path));
    if (!known && !text.includes(SECTION_MARK)) return;
    this.#index(c.path, text);
    this.editor.fileChanged(c.path, text);
  }

  #index(path: string, text: string): void {
    this.#unindex(path);
    for (const s of parseSections(text).sections) {
      const key = toKey(s.ref.resourceId);
      this.#notes.set(key, (this.#notes.get(key) ?? new Set()).add(path));
    }
  }

  #unindex(path: string): void {
    for (const paths of this.#notes.values()) paths.delete(path);
  }

  /** A section's model changed: a pass on each note that holds it. */
  async #remote(resource: ResourceId): Promise<void> {
    for (const path of this.#notes.get(toKey(resource)) ?? []) {
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

/** Local aliases of identities (Principal ID → label), in the plugin's local state. */
const ALIASES = "identity-aliases";

const fromKey64 = (hex: string): ResourceId => fromHex(hex) as ResourceId;

const toKey = (r: Uint8Array): string =>
  [...r].map((b) => b.toString(16).padStart(2, "0")).join("");
