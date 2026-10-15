// LFCP-03-008 (F-C03, F-C08, U03-07): the section actions on recording
// mock ports, no Obsidian and no runtime. Each case records the dialogs
// asked for, the notices, the writes and the calls into the section
// cores, and checks the stale, unknown-outcome and error paths: nothing is
// written or created after a change, a refusal or a failure the executor
// cannot classify, and a running flow is revealed, never started twice.

import { fromBase64url, principalId, resourceId, toBase64url } from "@openlfcp/core";
import { createTask, SharedObjectsReplica, type TaskView } from "@openlfcp/shared-objects";
import { describe, expect, it } from "vitest";
import { ACTION_IDS } from "../../../src/core/actions/catalog";
import {
  ActionDispatcher,
  coreHandlers,
  type HostEntry,
} from "../../../src/core/actions/dispatcher";
import { SECTIONS_READ_ONLY } from "../../../src/core/lfcp/runtime";
import { contentHash } from "../../../src/core/projection/guard";
import type {
  CreationService,
  DestinationChoice,
  InsertDestination,
  InsertionService,
  InsertPlace,
  NoticeAction,
  SectionNotes,
  SectionPrompter,
  SectionServices,
  TextChange,
} from "../../../src/core/sections/action-ports";
import { DETACH_CONFIRMATION, SectionActions } from "../../../src/core/sections/actions";
import {
  MemorySectionBaseStore,
  markdownState,
  type SectionState,
} from "../../../src/core/sections/base";
import type { CreationEntry, CreationResult } from "../../../src/core/sections/create";
import { applyChanges, type PassContext, SectionEngine } from "../../../src/core/sections/engine";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import type {
  InsertionEntry,
  InsertPreview,
  InsertRefusal,
  InsertResult,
} from "../../../src/core/sections/insert";
import {
  MemorySectionJournalStore,
  type PendingCandidate,
} from "../../../src/core/sections/journal";
import { parseSections } from "../../../src/core/sections/parser";
import type { SectionSnapshot } from "../../../src/core/sections/port";
import type { RecoveryChoice, RecoveryItem } from "../../../src/core/sections/recovery";
import type { SharePreview } from "../../../src/core/sections/share";
import type { EditorMode, TargetCapture, TextSelection } from "../../../src/core/sections/target";
import type { RevokeOutcome } from "../../../src/core/status/access";
import type { SectionCard } from "../../../src/core/status/card";
import { statusView } from "../../../src/core/status/reducer";
import { FakeSectionPort } from "./fake-port";

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const NOTE = ["# Notes", "", "## Plan", "", "- [ ] Alpha", "- [ ] Beta", "", "## Later", ""].join(
  "\n",
);
const PLAN = NOTE.split("\n").indexOf("## Plan");

/** A dialog the test answers: by a scripted answer at once, else by `answer` later. */
class OpenDialog<T> {
  forward = 0;
  answered = false;
  #resolve: (v: T) => void = () => undefined;
  readonly result = new Promise<T>((r) => {
    this.#resolve = r;
  });
  constructor(
    readonly kind: string,
    readonly args: readonly unknown[],
  ) {}
  bringForward(): void {
    this.forward++;
  }
  answer(v: T): void {
    this.answered = true;
    this.#resolve(v);
  }
}

/** Records every dialog and notice; answers from `script` per dialog kind, in order. */
class RecordingPrompter implements SectionPrompter {
  readonly notices: string[] = [];
  readonly announced: string[] = [];
  readonly dialogs: OpenDialog<unknown>[] = [];
  readonly script: Record<string, unknown[]> = {};
  #open<T>(kind: string, ...args: unknown[]): OpenDialog<T> {
    const d = new OpenDialog<T>(kind, args);
    this.dialogs.push(d as OpenDialog<unknown>);
    const queued = this.script[kind];
    if (queued !== undefined && queued.length > 0) d.answer(queued.shift() as T);
    return d;
  }
  /** The dialogs still open, of `kind`. */
  open(kind?: string): OpenDialog<unknown>[] {
    return this.dialogs.filter((d) => !d.answered && (kind === undefined || d.kind === kind));
  }
  /** The buttons notices carried ("Open" after an insertion), by notice text. */
  readonly noticeActions = new Map<string, NoticeAction>();
  notice(message: string, action?: NoticeAction): void {
    this.notices.push(message);
    if (action !== undefined) this.noticeActions.set(message, action);
  }
  announce(text: string): void {
    this.announced.push(text);
  }
  sharePreview(preview: SharePreview, note?: string) {
    return this.#open<boolean>("share", preview, note);
  }
  importPreview(title: string, preview: unknown) {
    return this.#open<never>("import", title, preview);
  }
  pickSection(choices: readonly unknown[]) {
    return this.#open<never>("pick", choices);
  }
  insertPreview(preview: unknown, place?: InsertPlace) {
    return this.#open<boolean>("insert", preview, place);
  }
  chooseDestination(choice: DestinationChoice) {
    return this.#open<InsertDestination | null>("destination", choice);
  }
  confirm(o: { title: string; message: string; action: string }) {
    return this.#open<boolean>("confirm", o);
  }
  async alias(current: string): Promise<string | null> {
    return this.#open<string | null>("alias", current).result;
  }
  repair(...args: unknown[]) {
    return this.#open<void>("repair", ...args);
  }
  review(...args: unknown[]): void {
    this.#open("review", ...args);
  }
  readonly cardUpdates: unknown[] = [];
  card(...args: unknown[]) {
    const d = this.#open("card", ...args);
    return { update: (c: unknown) => this.cardUpdates.push(c), close: () => d.answer(null) };
  }
}

/** An editor on a note in memory: `at()` captures it as an action does when it starts. */
class TestEditor {
  selections: TextSelection[] = [];
  composing = false;
  mode: EditorMode = "source";
  constructor(
    private readonly files: Map<string, string>,
    readonly path: string,
    public line: number,
  ) {}
  at(): TargetCapture {
    return {
      path: this.path,
      text: this.files.get(this.path) ?? "",
      mode: this.mode,
      cursorLine: this.line,
      selections: this.selections,
      composing: this.composing,
    };
  }
}

/** Notes in memory; `open` paths have an editor. Writes recorded. */
class MemoryNotes implements SectionNotes {
  readonly files = new Map<string, string>();
  readonly open = new Set<string>();
  /** Notes being composed in (IME), by path. */
  readonly composing = new Set<string>();
  readonly writes: { path: string; changes: readonly TextChange[] }[] = [];
  /** Lines revealed by goToLine. */
  readonly located: [string, number][] = [];
  editorOf(path: string, line = 0): TestEditor {
    return new TestEditor(this.files, path, line);
  }
  capture(path: string): TargetCapture | null {
    if (!this.open.has(path)) return null;
    return { ...this.editorOf(path).at(), composing: this.composing.has(path) };
  }
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async edit(path: string, fn: (current: string) => readonly TextChange[] | null): Promise<void> {
    const current = this.files.get(path);
    if (current === undefined) return;
    const changes = fn(current);
    if (changes === null || changes.length === 0) return;
    this.writes.push({ path, changes });
    this.files.set(path, applyChanges(current, changes));
  }
  async goToLine(path: string, line: number): Promise<TargetCapture | null> {
    if (!this.files.has(path)) return null;
    this.located.push([path, line]);
    return this.editorOf(path, line).at();
  }
}

interface FakeCreation extends CreationService {
  /** What `run` does with an entry. */
  result: (entry: CreationEntry) => Promise<CreationResult>;
  /** The entries as the journal holds them (`current`), by operation ID. */
  readonly journal: Map<string, CreationEntry>;
  /** The note path getter `run` was last given. */
  lastAt: (() => string | null) | undefined;
}

/** A creation journal that records its calls; `result` decides what `run` does. */
function fakeCreation(calls: string[]) {
  let n = 0;
  const c: FakeCreation = {
    result: (entry: CreationEntry): Promise<CreationResult> =>
      Promise.resolve({ kind: "hosted", entry }),
    lastAt: undefined,
    journal: new Map(),
    async current(operationId: string) {
      calls.push(`current ${operationId}`);
      return c.journal.get(operationId);
    },
    async prepare(path: string, _markdown: string, preview: SharePreview) {
      calls.push(`prepare ${path} "${preview.title}"`);
      return entry(`op-${++n}`, path, preview);
    },
    async prepareImport(path: string): Promise<CreationEntry> {
      calls.push(`prepareImport ${path}`);
      throw new Error("a choice is missing: CONFLICT");
    },
    async run(e: CreationEntry, at?: () => string | null): Promise<CreationResult> {
      calls.push(`run ${e.operationId}`);
      c.lastAt = at;
      return c.result(e);
    },
    async cancel(e: CreationEntry) {
      calls.push(`cancel ${e.operationId}`);
      return e;
    },
    async imports() {
      return [];
    },
    async rollback(e: CreationEntry) {
      return { kind: "none" as const, entry: e };
    },
  };
  return c;
}

const entry = (operationId: string, path: string, preview: SharePreview): CreationEntry => ({
  operationId,
  path,
  resource: R0,
  sectionId: "s1",
  nodeIds: [],
  intents: [],
  preview,
  phase: "prepared" as CreationEntry["phase"],
});

/** Services that record what the actions do to the host. */
function fakeServices(calls: string[], over: Partial<SectionServices> = {}): SectionServices {
  const unused = (name: string) => () => {
    throw new Error(`unexpected ${name}`);
  };
  return {
    creation: () => null,
    insertion: () => null,
    bases: () => null,
    candidates: () => null,
    model: () => null,
    readOnly: () => false,
    server: () => "wss://sync.example/v1/ws",
    refPlacement: () => "child-line",
    sectionChoices: async () => [],
    legacySource: async () => undefined,
    watch: async () => {
      calls.push("watch");
    },
    indexed: (path) => calls.push(`indexed ${path}`),
    pass: (path, text) => calls.push(`pass ${path}${text === undefined ? "" : " (file)"}`),
    forget: (key, id) => calls.push(`forget ${key} ${id}`),
    registryChanged: () => calls.push("registryChanged"),
    scheduleStatus: () => calls.push("scheduleStatus"),
    unavailable: () => null,
    known: () => false,
    cardContent: async () => null,
    held: () => [],
    recoveryItems: () => [],
    resolveRecovery: unused("resolveRecovery"),
    commands: () => null,
    aliases: async () => ({}),
    setAlias: async () => true,
    revokeAccess: unused("revokeAccess"),
    ...over,
  };
}

function setup(over: (calls: string[]) => Partial<SectionServices> = () => ({})) {
  const calls: string[] = [];
  const prompter = new RecordingPrompter();
  const notes = new MemoryNotes();
  const creation = fakeCreation(calls);
  const services = fakeServices(calls, { creation: () => creation, ...over(calls) });
  const actions = new SectionActions({ prompter, notes, services });
  notes.files.set("Plan.md", NOTE);
  notes.open.add("Plan.md");
  return { calls, prompter, notes, creation, actions, editor: notes.editorOf("Plan.md", PLAN) };
}

/** Lets pending promise callbacks run. */
const flush = async (times = 10) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

describe("share (LFCP-03-008 over 049/050, LFCP-03-002)", () => {
  it("an approved preview is created, watched, indexed and passed at the held note's path", async () => {
    const t = setup();
    t.prompter.script.share = [true];
    await t.actions.share(t.editor.at());
    expect(t.calls).toEqual([
      'prepare Plan.md "Plan"',
      "run op-1",
      "registryChanged",
      "watch",
      "indexed Plan.md",
      "pass Plan.md",
    ]);
    expect(t.creation.lastAt?.()).toBe("Plan.md");
    expect(t.prompter.notices).toEqual(['Shared Tasks: section "Plan" is shared.']);
  });

  it("a second start while the preview is open reveals it: no second dialog, nothing created", async () => {
    const t = setup();
    const first = t.actions.share(t.editor.at());
    await flush();
    expect(t.prompter.open("share")).toHaveLength(1);
    await t.actions.share(t.editor.at());
    // The insert entry shares the note's reservation.
    await t.actions.insertSection(t.editor.at());
    expect(t.prompter.dialogs).toHaveLength(1);
    expect(t.prompter.dialogs[0]?.forward).toBe(2);
    expect(t.prompter.announced).toEqual([
      'Shared Tasks: the share preview of "Plan" is open. Finish or cancel it first.',
      'Shared Tasks: the share preview of "Plan" is open. Finish or cancel it first.',
    ]);
    expect(t.calls).toEqual([]);
    t.prompter.open("share")[0]?.answer(false);
    await first;
    expect(t.calls).toEqual([]);
    expect(t.prompter.notices).toEqual([]);
  });

  it("a start while the creation runs says where it stands; the note is free again after", async () => {
    const t = setup();
    t.prompter.script.share = [true];
    let finish: (r: CreationResult) => void = () => undefined;
    t.creation.result = () => new Promise((r) => (finish = r));
    const first = t.actions.share(t.editor.at());
    await flush();
    await t.actions.share(t.editor.at());
    const stage =
      'Shared Tasks: section "Plan" is being shared from this note. Its result shows when it is done.';
    expect(t.prompter.notices).toEqual([stage]);
    expect(t.prompter.announced).toEqual([stage]);
    finish({
      kind: "local",
      entry: entry("op-1", "Plan.md", {} as SharePreview),
      reason: "Offline.",
    });
    await first;
    expect(t.prompter.notices.at(-1)).toBe(
      'Shared Tasks: section "Plan" was created on this device; invitation is not ready yet. Offline.',
    );
    t.prompter.script.share = [false];
    await t.actions.share(t.editor.at());
    expect(t.prompter.dialogs.filter((d) => d.kind === "share")).toHaveLength(2);
  });

  it("stale: a creation whose range changed is cancelled, nothing watched or bound", async () => {
    const t = setup();
    t.prompter.script.share = [true];
    t.creation.result = (e) => Promise.resolve({ kind: "stale", entry: e });
    await t.actions.share(t.editor.at());
    expect(t.calls).toEqual([
      'prepare Plan.md "Plan"',
      "run op-1",
      "cancel op-1",
      "registryChanged",
    ]);
    expect(t.prompter.notices).toEqual([
      'Shared Tasks: section "Plan" changed since the preview. Nothing was bound; share it again.',
    ]);
  });

  it("LFCP-03-013: the pane hears of each step of a flow, and of its end", async () => {
    const t = setup();
    let told = 0;
    const off = t.actions.onFlowsChange(() => {
      told++;
    });
    const steps: string[] = [];
    t.actions.onFlowsChange(() => {
      for (const f of t.actions.flows()) steps.push(`${f.kind} ${f.step} ${f.outcome}`);
    });
    t.creation.result = () => Promise.reject(new Error("socket closed"));
    const first = t.actions.share(t.editor.at());
    await flush();
    expect(t.actions.flows()).toMatchObject([
      { kind: "share", step: "preview", outcome: "running" },
    ]);
    t.prompter.open("share")[0]?.answer(true);
    await first;
    await flush();
    expect(steps).toContain("share creating running");
    expect(t.actions.flows()).toMatchObject([{ step: "creating", outcome: "unknown" }]);
    expect(steps.at(-1)).toBe("share creating unknown");
    off();
    const before = told;
    t.creation.result = (e) => Promise.resolve({ kind: "hosted", entry: e });
    await t.actions.checkResult(t.actions.flows()[0]?.generation ?? 0);
    expect(t.actions.flows()).toEqual([]);
    expect(told).toBe(before);
    expect(steps.length).toBeGreaterThan(2);
  });

  it("D12: an unknown outcome keeps the note; a repeat checks the same operation, never a new one", async () => {
    const t = setup();
    t.prompter.script.share = [true];
    t.creation.result = () => Promise.reject(new Error("socket closed"));
    await t.actions.share(t.editor.at());
    expect(t.calls).toEqual(['prepare Plan.md "Plan"', "run op-1"]);
    expect(t.prompter.notices).toEqual([
      'Shared Tasks: creating section "Plan" stopped (socket closed); its result is not known yet. Share section… on this note checks it again and creates nothing new; it also goes on at the next start.',
    ]);
    const [held] = t.actions.flows();
    expect(held).toMatchObject({ kind: "share", path: "Plan.md", outcome: "unknown" });

    // A repeat (any entry: share, insert) opens nothing and allocates nothing: it checks op-1 again.
    t.prompter.notices.length = 0;
    t.calls.length = 0;
    // The journal went on as far as "local" before the error: the check resumes from there.
    const journaled = entry("op-1", "Plan.md", { title: "Plan" } as SharePreview);
    t.creation.journal.set("op-1", { ...journaled, phase: "local" });
    await t.actions.share(t.editor.at());
    await t.actions.insertSection(t.editor.at());
    await flush();
    const checking =
      'Shared Tasks: the result of sharing section "Plan" from this note is being checked. Nothing new is created.';
    expect(t.prompter.notices).toEqual([
      checking,
      checking,
      'Shared Tasks: the result of creating section "Plan" is still not known (socket closed). Nothing new was created.',
    ]);
    // One check at a time; the same operation ID, as the journal holds it.
    expect(t.calls).toEqual(["current op-1", "run op-1"]);
    expect(t.prompter.dialogs.filter((d) => d.kind === "share")).toHaveLength(1);
    expect(t.actions.flows()).toHaveLength(1);

    // "Check the result" (the pane) settles it: the same op-1, hosted; the note is free.
    t.prompter.notices.length = 0;
    t.calls.length = 0;
    const resumedFrom: string[] = [];
    t.creation.result = (e) => {
      resumedFrom.push(e.phase);
      return Promise.resolve({ kind: "hosted", entry: e });
    };
    expect(await t.actions.checkResult(held?.generation ?? 0)).toBe(true);
    expect(resumedFrom).toEqual(["local"]);
    expect(t.calls).toEqual([
      "current op-1",
      "run op-1",
      "registryChanged",
      "watch",
      "indexed Plan.md",
      "pass Plan.md",
    ]);
    expect(t.prompter.notices.at(-1)).toBe('Shared Tasks: section "Plan" is shared.');
    expect(t.actions.flows()).toEqual([]);

    // A late "Check the result" for the closed flow does nothing.
    t.calls.length = 0;
    expect(await t.actions.checkResult(held?.generation ?? 0)).toBe(false);
    expect(t.calls).toEqual([]);

    // A later explicit share is a new operation, from a new preview.
    t.prompter.script.share = [true];
    await t.actions.share(t.editor.at());
    expect(t.prompter.dialogs.filter((d) => d.kind === "share")).toHaveLength(2);
    expect(t.calls).toContain("run op-2");
  });

  it("D12: a stale or cancelled creation is known: the note is free at once", async () => {
    const t = setup();
    t.prompter.script.share = [true, false];
    t.creation.result = (e) => Promise.resolve({ kind: "cancelled", entry: e });
    await t.actions.share(t.editor.at());
    expect(t.actions.flows()).toEqual([]);
    await t.actions.share(t.editor.at());
    expect(t.prompter.dialogs.filter((d) => d.kind === "share")).toHaveLength(2);
  });

  it("a creation a restart interrupted holds its note while it runs; a share meanwhile waits", async () => {
    const t = setup();
    let finish: (r: CreationResult) => void = () => undefined;
    t.creation.result = () => new Promise((r) => (finish = r));
    const resumed = entry("op-7", "Plan.md", { title: "Plan" } as SharePreview);
    const running = t.actions.resumeCreation(resumed);
    await flush();
    await t.actions.share(t.editor.at());
    expect(t.prompter.dialogs).toEqual([]);
    expect(t.prompter.notices).toEqual([
      'Shared Tasks: section "Plan" is being shared from this note. Its result shows when it is done.',
    ]);
    finish({ kind: "hosted", entry: resumed });
    await running;
    expect(t.prompter.notices.at(-1)).toBe('Shared Tasks: section "Plan" is shared.');
    expect(t.actions.flows()).toEqual([]);
  });

  it("stale preview: a note changed while the preview was open is shown again; a lost heading shares nothing", async () => {
    const t = setup();
    const first = t.actions.share(t.editor.at());
    await flush();
    t.notes.files.set("Plan.md", NOTE.replace("- [ ] Beta", "- [ ] Beta\n- [ ] Gamma"));
    t.prompter.open("share")[0]?.answer(true);
    await flush();
    const again = t.prompter.open("share")[0];
    expect(again?.args[1]).toBe(
      "The note changed while the preview was open. Review the section again.",
    );
    const shown = again?.args[0] as SharePreview | undefined;
    expect(shown?.content).toContain("Gamma");
    t.notes.files.set("Plan.md", NOTE.replace("## Plan", "Plan, no heading"));
    again?.answer(true);
    await first;
    expect(t.calls).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the section's heading is gone. Nothing was shared.",
    ]);
  });

  it("a note deleted while the preview was open is not shared; renamed, the share binds the new path", async () => {
    const t = setup();
    const first = t.actions.share(t.editor.at());
    await flush();
    t.actions.noteDeleted("Plan.md");
    t.prompter.open("share")[0]?.answer(true);
    await first;
    expect(t.calls).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the note was deleted while the preview was open. Nothing was shared.",
    ]);

    const second = t.actions.share(t.editor.at());
    await flush();
    t.actions.noteRenamed("Plan.md", "Renamed.md");
    t.notes.files.set("Renamed.md", NOTE);
    t.prompter.open("share")[0]?.answer(true);
    await second;
    expect(t.calls[0]).toBe('prepare Renamed.md "Plan"');
    expect(t.creation.lastAt?.()).toBe("Renamed.md");
  });

  it("refused before any dialog: read-only device, no heading, still starting, no server", async () => {
    const readOnly = setup(() => ({ readOnly: () => true }));
    await readOnly.actions.share(readOnly.editor.at());
    expect(readOnly.prompter.notices).toEqual([`Shared Tasks: ${SECTIONS_READ_ONLY}.`]);

    const noHeading = setup();
    noHeading.editor.line = 0;
    noHeading.notes.files.set("Plan.md", `intro\n${NOTE.replace(/^#.*$/gm, "text")}`);
    await noHeading.actions.share(noHeading.editor.at());
    expect(noHeading.prompter.notices).toEqual([
      "Shared Tasks: put the cursor on or under a heading to share its section.",
    ]);

    const starting = setup(() => ({ creation: () => null }));
    starting.prompter.script.share = [true];
    await starting.actions.share(starting.editor.at());
    expect(starting.prompter.notices).toEqual([
      "Shared Tasks: still starting. Share the section again in a moment.",
    ]);

    const noServer = setup(() => ({ server: () => " " }));
    noServer.prompter.script.share = [true];
    await noServer.actions.share(noServer.editor.at());
    expect(noServer.prompter.notices).toEqual([
      "Shared Tasks: set a default sync server in the settings to share a section.",
    ]);
    for (const t of [readOnly, noHeading, starting, noServer]) expect(t.calls).toEqual([]);
  });
});

describe("import of 0.1 shared Tasks (LFCP-03-008 over 053)", () => {
  const ID = "0192e4a0-0000-7000-8000-000000000001";
  const LEGACY = [
    "## Launch",
    "- [ ] Prepare contract",
    `  <!-- lfcp-ref: lfcp1:${R0}#task:${ID} -->`,
    "",
  ].join("\n");

  it("a source this device cannot read is left to the preflight; a refused preparation changes nothing", async () => {
    const t = setup((calls) => ({
      legacySource: async () => {
        calls.push("legacySource");
        throw new Error("not on this device");
      },
    }));
    t.notes.files.set("Plan.md", LEGACY);
    t.editor.line = 0;
    t.prompter.script.import = [{ values: {}, copies: [] }];
    await t.actions.share(t.editor.at());
    const preview = t.prompter.dialogs.find((d) => d.kind === "import");
    expect(preview?.args[0]).toBe("Launch");
    expect(t.calls).toEqual(["legacySource", "prepareImport Plan.md"]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the import cannot start (a choice is missing: CONFLICT). Nothing changed.",
    ]);
    expect(t.notes.writes).toEqual([]);
  });
});

/** An insertion journal that records its calls. */
/** The section the fake insertion previews: a complete, empty projection. */
const INSERT_SID = "019a2f85-7b31-7c42-b85a-fc843e2f4099";
const INSERT_REF = parseSectionRef(`lfcp1:${R0}#section:${INSERT_SID}`) as SectionRef;
const INSERT_BLOCK = `## Shared\n${formatBoundary("start", INSERT_REF)}\n${formatBoundary("end", INSERT_REF)}\n`;

function fakeInsertion(calls: string[]) {
  const preview: InsertPreview = {
    resource: R0,
    sectionId: INSERT_SID,
    title: "Shared",
    block: INSERT_BLOCK,
    readOnly: false,
    revision: "r1",
  };
  let n = 0;
  const i = {
    refused: null as InsertRefusal | null,
    journal: new Map<string, InsertionEntry>(),
    async current(insertionId: string) {
      calls.push(`current ${insertionId}`);
      return i.journal.get(insertionId);
    },
    result: (e: InsertionEntry): Promise<InsertResult> =>
      Promise.resolve({ kind: "inserted", entry: e }),
    async preview(): Promise<InsertPreview | { readonly refused: InsertRefusal }> {
      calls.push("preview");
      return i.refused === null ? preview : { refused: i.refused };
    },
    async prepare(path: string, markdown: string, line: number, p: InsertPreview) {
      calls.push(`prepare ${path} line ${line} rev ${markdown.length}`);
      const entry: InsertionEntry = {
        insertionId: `ins-${++n}`,
        path,
        preview: p,
        target: { revision: "x", line, anchor: null, before: 0 },
        phase: "prepared",
      };
      return entry;
    },
    async run(e: InsertionEntry): Promise<InsertResult> {
      calls.push(`run ${e.insertionId}`);
      return i.result(e);
    },
    async cancel(e: InsertionEntry): Promise<InsertionEntry> {
      calls.push(`cancel ${e.insertionId}`);
      const c: InsertionEntry = { ...e, phase: "cancelled" };
      i.journal.set(e.insertionId, c);
      return c;
    },
  };
  return i satisfies InsertionService;
}

describe("insert (LFCP-03-008 over 052)", () => {
  const choice = { resource: new Uint8Array(32), sectionId: "s1", title: "Shared" };
  function insertSetup(choices: (typeof choice)[] | null = [choice]) {
    const calls: string[] = [];
    const insertion = fakeInsertion(calls);
    const t = setup(() => ({
      insertion: () => insertion,
      sectionChoices: async () => choices,
      watch: async () => {
        calls.push("watch");
      },
      indexed: (path) => calls.push(`indexed ${path}`),
      pass: (path, text) => calls.push(`pass ${path}${text === undefined ? "" : " (file)"}`),
    }));
    return { ...t, calls, insertion };
  }

  it("a picked, approved section is journaled at the cursor, inserted, indexed and passed", async () => {
    const t = insertSetup();
    t.prompter.script.pick = [choice];
    t.prompter.script.insert = [true];
    await t.actions.insertSection(t.editor.at());
    expect(t.calls).toEqual([
      "preview",
      "watch",
      `prepare Plan.md line ${PLAN} rev ${NOTE.length}`,
      "run ins-1",
      "indexed Plan.md",
      "pass Plan.md",
    ]);
    expect(t.prompter.notices).toEqual(['Shared Tasks: section "Shared" inserted into "Plan".']);
  });

  it("D12: an insertion that throws keeps the note; a repeat checks ins-1; a later insert is ins-2", async () => {
    const t = insertSetup();
    t.prompter.script.pick = [choice];
    t.prompter.script.insert = [true];
    t.insertion.result = () => Promise.reject(new Error("disk full"));
    await t.actions.insertSection(t.editor.at());
    expect(t.prompter.notices).toEqual([
      'Shared Tasks: inserting section "Shared" stopped (disk full); whether it was written is not known yet. Inserting it into this note again checks it and inserts nothing new.',
    ]);
    expect(t.actions.flows()).toMatchObject([{ kind: "insert", outcome: "unknown" }]);

    // A repeat from the palette, or a share on the same note: no dialog, no new insertion ID.
    t.calls.length = 0;
    t.prompter.notices.length = 0;
    t.insertion.result = (e) => Promise.resolve({ kind: "inserted", entry: e });
    await t.actions.insertSection(t.editor.at());
    await flush(20);
    expect(t.prompter.notices[0]).toBe(
      'Shared Tasks: the result of inserting section "Shared" into this note is being checked. Nothing new is inserted.',
    );
    expect(t.calls).toEqual(["current ins-1", "run ins-1", "indexed Plan.md", "pass Plan.md"]);
    expect(t.prompter.dialogs.filter((d) => d.kind === "pick")).toHaveLength(1);
    expect(t.actions.flows()).toEqual([]);

    // Settled: a later explicit insert is a new insertion.
    t.calls.length = 0;
    t.prompter.script.pick = [choice];
    t.prompter.script.insert = [true];
    await t.actions.insertSection(t.editor.at());
    expect(t.calls).toContain("run ins-2");
  });

  it("tells the caller the insert started only once it is journaled, not at its preview (LFCP-03-017)", async () => {
    const t = insertSetup();
    const started: string[] = [];
    t.prompter.script.pick = [choice, choice];
    t.prompter.script.insert = [false, true];
    await t.actions.insertSection(t.editor.at(), undefined, (key) => {
      started.push(key);
      t.calls.push("started");
    });
    expect(started).toEqual([]);
    await t.actions.insertSection(t.editor.at(), undefined, (key) => {
      started.push(key);
      t.calls.push("started");
    });
    expect(started).toEqual([`${toBase64url(choice.resource)}#s1`]);
    expect(t.calls.slice(-5, -2)).toEqual([
      `prepare Plan.md line ${PLAN} rev ${NOTE.length}`,
      "started",
      "run ins-1",
    ]);
  });

  it("stale: the note changed where the block would go; nothing indexed, said once; the insertion ends", async () => {
    const t = insertSetup();
    t.prompter.script.pick = [choice];
    t.prompter.script.insert = [true];
    t.insertion.result = (e) => Promise.resolve({ kind: "stale", entry: e });
    await t.actions.insertSection(t.editor.at());
    // Nothing was written: it is not resumed at the next start (LFCP-03-017).
    expect(t.calls.slice(-2)).toEqual(["run ins-1", "cancel ins-1"]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the note changed where the section would go. Insert it again.",
    ]);
  });

  it("a refused preview, a cancelled choice, a deleted note and no section write nothing", async () => {
    const refused = insertSetup();
    refused.insertion.refused = "importing";
    refused.prompter.script.pick = [choice];
    await refused.actions.insertSection(refused.editor.at());
    expect(refused.calls).toEqual(["preview"]);
    expect(refused.prompter.notices).toHaveLength(1);
    expect(refused.prompter.open()).toEqual([]);

    const cancelled = insertSetup();
    cancelled.prompter.script.pick = [null];
    await cancelled.actions.insertSection(cancelled.editor.at());
    expect(cancelled.calls).toEqual([]);

    const deleted = insertSetup();
    deleted.prompter.script.pick = [choice];
    const flow = deleted.actions.insertSection(deleted.editor.at());
    await flush(20);
    deleted.actions.noteDeleted("Plan.md");
    deleted.prompter.open("insert")[0]?.answer(true);
    await flow;
    expect(deleted.calls).toEqual(["preview", "watch"]);
    expect(deleted.prompter.notices).toEqual([
      "Shared Tasks: the note was deleted while the preview was open. Nothing was inserted.",
    ]);

    const none = insertSetup([]);
    await none.actions.insertSection(none.editor.at());
    expect(none.prompter.notices).toEqual(["Shared Tasks: no shared section on this device yet."]);
    const starting = insertSetup(null);
    await starting.actions.insertSection(starting.editor.at());
    expect(starting.prompter.notices).toEqual([
      "Shared Tasks: still starting. Try again in a moment.",
    ]);
  });

  it("a second insert while the insert preview is open brings it forward", async () => {
    const t = insertSetup();
    t.prompter.script.pick = [choice];
    const first = t.actions.insertSection(t.editor.at());
    await flush(20);
    await t.actions.insertSection(t.editor.at());
    await t.actions.share(t.editor.at());
    const open = t.prompter.open("insert");
    expect(open).toHaveLength(1);
    expect(open[0]?.forward).toBe(2);
    expect(t.prompter.announced).toEqual([
      "Shared Tasks: the insert preview is open. Finish or cancel it first.",
      "Shared Tasks: the insert preview is open. Finish or cancel it first.",
    ]);
    open[0]?.answer(false);
    await first;
    expect(t.calls).toEqual(["preview", "watch"]);
  });
});

const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const S = parseSectionRef(`lfcp1:${R0}#section:${SID}`) as SectionRef;
const KEY = `${R0}#${SID}`;
const BOUND = [
  "Private before.",
  "## Launch",
  formatBoundary("start", S),
  "- [ ] Alpha",
  formatBoundary("end", S),
  "Private after.",
  "",
].join("\n");
const EMPTY: SectionState = { title: "Launch", nodes: {}, order: {} } as unknown as SectionState;

/** A section loaded on this device: watched, its model ready (detach's loading guard). */
const loadedSection = (ready: () => boolean = () => true): Partial<SectionServices> => ({
  known: () => true,
  model: () => ({
    snapshot: () => ({ ready: ready() }) as SectionSnapshot,
    task: () => undefined,
    taskView: () => undefined,
  }),
});

describe("detach (LFCP-03-008 over §10)", () => {
  async function detachSetup() {
    const bases = new MemorySectionBaseStore();
    await bases.save("p1", { locator: { path: "Plan.md", section: S }, state: EMPTY });
    await bases.save("p2", { locator: { path: "Other.md", section: S }, state: EMPTY });
    let ready = true;
    const t = setup(() => ({ bases: () => bases, ...loadedSection(() => ready) }));
    t.notes.files.set("Plan.md", BOUND);
    t.editor.line = 3;
    return {
      ...t,
      bases,
      setReady: (r: boolean) => {
        ready = r;
      },
    };
  }

  it("LFCP-03-010: refused while the section loads, as its descriptor says; checked again before writing", async () => {
    const loading = await detachSetup();
    loading.setReady(false);
    await loading.actions.detachSectionAt(loading.editor.at());
    expect(loading.prompter.dialogs).toEqual([]);
    expect(loading.prompter.notices).toEqual([
      "Shared Tasks: this section is still loading. Try again in a moment.",
    ]);

    // Loaded when asked, unloaded (a reload) while the confirmation was open: nothing written.
    const t = await detachSetup();
    const flow = t.actions.detachSectionAt(t.editor.at());
    await flush();
    t.setReady(false);
    t.prompter.open("confirm")[0]?.answer(true);
    await flow;
    for (const x of [loading, t]) {
      expect(x.notes.writes).toEqual([]);
      expect(x.calls).toEqual([]);
      expect(await x.bases.projectionsOf("Plan.md")).toEqual(["p1"]);
    }
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: this section is still loading. Try again in a moment.",
    ]);
  });

  it("confirmed: the bindings go, this note's base is dropped, nothing else is touched", async () => {
    const t = await detachSetup();
    t.prompter.script.confirm = [true];
    await t.actions.detachSectionAt(t.editor.at());
    expect(t.notes.files.get("Plan.md")).toBe(
      ["Private before.", "## Launch", "- [ ] Alpha", "Private after.", ""].join("\n"),
    );
    expect(await t.bases.projectionsOf("Plan.md")).toEqual([]);
    expect(await t.bases.projectionsOf("Other.md")).toEqual(["p2"]);
    expect(t.calls).toEqual(["indexed Plan.md", `forget ${KEY} p1`, "pass Plan.md"]);
    expect(t.prompter.notices).toEqual([
      'Shared Tasks: "Launch" is no longer shared in this note. The shared section itself is unchanged.',
    ]);
  });

  it("stale: a note changed during the confirmation is not detached", async () => {
    const t = await detachSetup();
    const flow = t.actions.detachSectionAt(t.editor.at());
    await flush();
    t.notes.files.set("Plan.md", BOUND.replace("Alpha", "Alpha!"));
    t.prompter.open("confirm")[0]?.answer(true);
    await flow;
    expect(t.notes.writes).toEqual([]);
    expect(await t.bases.projectionsOf("Plan.md")).toEqual(["p1"]);
    expect(t.calls).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the note changed meanwhile. Nothing was detached; try again.",
    ]);
  });

  it("LFCP-03-019: from the pane, the copy the pane captured; the other copy and everyone's access untouched", async () => {
    const t = await detachSetup();
    // Another note holds a copy too, and is the one in view meanwhile: the captured note is detached.
    t.notes.files.set("Other.md", BOUND);
    t.notes.open.add("Other.md");
    const d = new ActionDispatcher(
      coreHandlers({
        sections: () => t.actions,
        collab: {
          joinCollaboration: async () => undefined,
          inviteCollaborator: async () => undefined,
          inviteTo: async () => undefined,
          resourceStatus: async () => undefined,
        },
      }),
    );
    const at = t.editor.at();
    t.prompter.script.confirm = [true];
    await d.run("detach-section", { target: at, section: { key: KEY, title: "Launch" } }, "pane");
    // The user saw what happens before it did: this note only, nobody's access.
    expect(t.prompter.dialogs.map((x) => x.args[0])).toEqual([
      { title: 'Detach "Launch" in this note', message: DETACH_CONFIRMATION, action: "Detach" },
    ]);
    expect(DETACH_CONFIRMATION).toContain("their access are not changed");
    expect(t.notes.files.get("Plan.md")).not.toContain("lfcp-section");
    expect(t.notes.files.get("Other.md")).toBe(BOUND);
    expect(await t.bases.projectionsOf("Other.md")).toEqual(["p2"]);
    // No access change, no Control action, nothing sent: revokeAccess would throw, commands is null.
    expect(t.calls).toEqual(["indexed Plan.md", `forget ${KEY} p1`, "pass Plan.md"]);
  });

  it("cancelled, or the cursor outside a section: nothing written", async () => {
    const t = await detachSetup();
    t.prompter.script.confirm = [false];
    await t.actions.detachSectionAt(t.editor.at());
    t.editor.line = 0;
    await t.actions.detachSectionAt(t.editor.at());
    expect(t.notes.writes).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.prompter.dialogs.map((d) => d.kind)).toEqual(["confirm"]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: put the cursor in a shared section to detach it.",
    ]);
  });
});

describe("repair (LFCP-03-008 over 062)", () => {
  /** A section whose base is lost: bound, but no base for it in this note. */
  const LOST = [
    "## Launch",
    formatBoundary("start", S),
    "Draft only here",
    formatBoundary("end", S),
    "",
  ].join("\n");
  const MODEL: SectionSnapshot = {
    revision: "r1",
    // Another title in the model: the note's copy differs from it.
    title: "Launch (renamed)",
    ready: true,
    nodes: {},
    order: { "": [] },
    problems: [],
  };

  function repairSetup(text: string) {
    const bases = new MemorySectionBaseStore();
    const kept: PendingCandidate[] = [];
    const t = setup(() => ({
      bases: () => bases,
      model: () => ({ snapshot: () => MODEL, task: () => undefined, taskView: () => undefined }),
      candidates: () => ({
        putCandidate: async (c) => {
          kept.push(c);
        },
        allCandidates: async () => kept,
        resolveCandidate: async () => undefined,
      }),
    }));
    t.notes.files.set("Plan.md", text);
    return { ...t, bases, kept };
  }
  type Repair = Parameters<SectionPrompter["repair"]>;
  const opened = (t: { prompter: RecordingPrompter }) =>
    t.prompter.dialogs.find((d) => d.kind === "repair")?.args as Repair;

  it("still starting: no dialog", async () => {
    const t = setup();
    await t.actions.repairNote(t.editor.at());
    expect(t.prompter.dialogs).toEqual([]);
    expect(t.prompter.notices).toEqual(["Shared Tasks: still starting. Try again in a moment."]);
  });

  it("a boundary is placed only on the note it was computed for", async () => {
    const broken = ["## Launch", formatBoundary("start", S), "- [ ] One", "", "## Other", ""].join(
      "\n",
    );
    const t = repairSetup(broken);
    await t.actions.repairNote(t.editor.at());
    const [items, , actions] = opened(t);
    const item = items[0];
    if (item?.kind !== "missing-end") throw new Error(item?.kind);
    t.notes.files.set("Plan.md", `${broken}changed\n`);
    await actions.boundary(item, 2);
    expect(t.notes.writes).toEqual([]);
    t.notes.files.set("Plan.md", broken);
    await actions.boundary(item, 2);
    expect(t.notes.writes).toHaveLength(1);
    expect(t.notes.files.get("Plan.md")).toContain(formatBoundary("end", S));
    actions.locate(4);
    await flush();
    expect(t.notes.located).toEqual([["Plan.md", 4]]);
  });

  it("stale: taking the shared version of a changed note keeps the copy and replaces nothing", async () => {
    const t = repairSetup(LOST);
    await t.actions.repairNote(t.editor.at());
    const [, lost, actions] = opened(t);
    expect(lost.map((l) => l.key)).toEqual([KEY]);
    t.notes.files.set("Plan.md", LOST.replace("Draft", "Edited"));
    await actions.useShared(KEY);
    expect(t.kept.map((c) => c.sourceText)).toEqual([LOST.split("\n").slice(0, 4).join("\n")]);
    expect(t.notes.writes).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the note changed meanwhile. Nothing was replaced; open the repair again.",
    ]);
  });

  it("taking the shared version keeps the copy first, then writes the model's version", async () => {
    const t = repairSetup(LOST);
    await t.actions.repairNote(t.editor.at());
    const [, , actions] = opened(t);
    await actions.useShared(KEY);
    expect(t.kept).toHaveLength(1);
    expect(t.notes.files.get("Plan.md")).not.toContain("Draft only here");
    expect(t.calls).toEqual(["pass Plan.md"]);
    expect(await t.bases.projectionsOf("Plan.md")).toEqual([]);
  });

  /** The vault renames `from` to `to`: its file moves and the executor hears the event. */
  const rename = (t: ReturnType<typeof repairSetup>, from: string, to: string) => {
    t.notes.files.set(to, t.notes.files.get(from) ?? "");
    t.notes.files.delete(from);
    t.actions.noteRenamed(from, to);
  };

  it("F1 (review of 009): a repair left open follows a rename; its choices act at the new path", async () => {
    const t = repairSetup(LOST);
    await t.actions.repairNote(t.editor.at());
    const [, , actions] = opened(t);
    rename(t, "Plan.md", "Moved.md");
    await actions.shareMine(KEY);
    // The base is the renamed note's: a base at the old path would be a lost base again.
    expect(await t.bases.projectionsOf("Plan.md")).toEqual([]);
    expect(await t.bases.projectionsOf("Moved.md")).toHaveLength(1);
    expect(t.calls).toEqual(["pass Moved.md"]);
    actions.locate(2);
    await flush();
    expect(t.notes.located).toEqual([["Moved.md", 2]]);
  });

  it("F1: a boundary chosen after a rename is placed in the renamed note; after a delete, nowhere", async () => {
    const broken = ["## Launch", formatBoundary("start", S), "- [ ] One", "", "## Other", ""].join(
      "\n",
    );
    const t = repairSetup(broken);
    await t.actions.repairNote(t.editor.at());
    const [items, , actions] = opened(t);
    const item = items[0];
    if (item?.kind !== "missing-end") throw new Error(item?.kind);
    rename(t, "Plan.md", "Moved.md");
    await actions.boundary(item, 2);
    expect(t.notes.writes.map((w) => w.path)).toEqual(["Moved.md"]);
    expect(t.notes.files.get("Moved.md")).toContain(formatBoundary("end", S));
    expect(t.calls).toEqual(["pass Moved.md"]);
    // Deleted while the dialog is open: nothing is written, at either path.
    t.notes.files.set("Moved.md", broken);
    t.notes.files.delete("Moved.md");
    t.actions.noteDeleted("Moved.md");
    t.notes.files.set("Plan.md", broken);
    await actions.boundary(item, 2);
    expect(t.notes.writes).toHaveLength(1);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the note was deleted. Nothing was repaired.",
    ]);
  });

  it("F1: the note is held only while the dialog is open: a later note at the old path is another one", async () => {
    const t = repairSetup(LOST);
    await t.actions.repairNote(t.editor.at());
    const [, , actions] = opened(t);
    const dialog = t.prompter.open("repair")[0];
    dialog?.answer(undefined);
    await flush();
    // Released once closed: the closed dialog no longer follows the note (its hold is given back).
    rename(t, "Plan.md", "Moved.md");
    await actions.shareMine(KEY);
    expect(await t.bases.projectionsOf("Plan.md")).toHaveLength(1);
  });

  it("P3-4: a repair that throws before its dialog opens gives its note back", async () => {
    const t = repairSetup(LOST);
    t.bases.projectionsOf = async () => {
      throw new Error("store gone");
    };
    await expect(t.actions.repairNote(t.editor.at())).rejects.toThrow("store gone");
    expect(t.prompter.dialogs).toEqual([]);
    expect(t.actions.heldNotes()).toBe(0);
  });

  it("P3-4: a dialog closed while a choice runs keeps the note until the choice ends", async () => {
    const broken = ["## Launch", formatBoundary("start", S), "- [ ] One", "", "## Other", ""].join(
      "\n",
    );
    const t = repairSetup(broken);
    let finish: () => void = () => undefined;
    const edit = t.notes.edit.bind(t.notes);
    t.notes.edit = async (path, fn) => {
      await new Promise<void>((r) => {
        finish = r;
      });
      return edit(path, fn);
    };
    await t.actions.repairNote(t.editor.at());
    const [items, , actions] = opened(t);
    const item = items[0];
    if (item?.kind !== "missing-end") throw new Error(item?.kind);
    expect(t.actions.heldNotes()).toBe(1);
    // The modal closes first, then runs the choice (RepairModal: close(), then the action).
    t.prompter.open("repair")[0]?.answer(undefined);
    const running = actions.boundary(item, 2);
    await flush();
    expect(t.actions.heldNotes()).toBe(1);
    finish();
    await running;
    await flush();
    expect(t.notes.writes.map((w) => w.path)).toEqual(["Plan.md"]);
    expect(t.actions.heldNotes()).toBe(0);
  });

  it("keeping this note's version adopts a base for it, and says so", async () => {
    const t = repairSetup(LOST);
    await t.actions.repairNote(t.editor.at());
    const [, , actions] = opened(t);
    await actions.shareMine(KEY);
    expect(await t.bases.projectionsOf("Plan.md")).toHaveLength(1);
    expect(t.notes.writes).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: this note's version is kept as this copy's base. Whether its edits are sent shows in the pane and on the section card.",
    ]);
  });
});

describe("restore an import (LFCP-03-008 over 054)", () => {
  it("rolls back the latest import of the note; none, or one not in the note, is said", async () => {
    const t = setup();
    await t.actions.restoreImport("Plan.md");
    const imported = entry("op-9", "Plan.md", { title: "Plan" } as SharePreview);
    const rolled: string[] = [];
    t.creation.imports = async () => [entry("op-8", "Plan.md", {} as SharePreview), imported];
    t.creation.rollback = async (e) => {
      rolled.push(e.operationId);
      return { kind: rolled.length === 1 ? "restored" : "none", entry: e };
    };
    await t.actions.restoreImport("Plan.md");
    await t.actions.restoreImport("Plan.md");
    expect(rolled).toEqual(["op-9", "op-9"]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: no section import to restore in this note.",
      "Shared Tasks: the note shows its content from before the import again. The new shared section still exists; to stop sharing it, remove people's access.",
      "Shared Tasks: this import cannot be restored here (its section is not in the note).",
    ]);
  });
});

describe("the section card (LFCP-03-008 over 059/060/061)", () => {
  /** Current, access verified with the server: what lets the card offer Invite. */
  const current = statusView({
    session: "s",
    revision: 1,
    replica: "loaded",
    access: "writer",
    accessVerifiedAt: 1,
    accessCurrent: true,
    pendingControl: [],
    connection: "connected",
    catchUp: "current-at-checkpoint",
    problems: [],
    batches: [],
    acceptanceEvidence: "available",
    projections: [],
  });
  const card = (over: Record<string, unknown> = {}) =>
    ({
      heading: "Launch",
      status: "Current",
      facts: [],
      problems: [],
      shared: [],
      technical: [],
      held: [],
      access: { canInvite: true, invite: true },
      view: current,
      hosting: "hosted",
      ...over,
    }) as unknown as SectionCard;
  type CardArgs = Parameters<SectionPrompter["card"]>;

  function cardSetup(over: (calls: string[]) => Partial<SectionServices> = () => ({})) {
    let content: SectionCard | null = card();
    const commandCalls: string[] = [];
    const t = setup((calls) => ({
      cardContent: async () => content,
      known: () => true,
      commands: () => ({
        inviteTo: async () => {
          commandCalls.push("inviteTo");
        },
        resourceStatusOf: async () => {
          commandCalls.push("resourceStatusOf");
        },
      }),
      ...over(calls),
    }));
    const opened = () => {
      const all = t.prompter.dialogs.filter((d) => d.kind === "card");
      return all.at(-1)?.args as CardArgs;
    };
    const press = (label: string) => {
      const a = opened()[1].find((x) => x.label === label);
      if (a === undefined) throw new Error(`no ${label}: ${opened()[1].map((x) => x.label)}`);
      a.run();
    };
    return {
      ...t,
      commandCalls,
      opened,
      press,
      set: (c: SectionCard | null) => {
        content = c;
      },
    };
  }

  it("refused before the card: another instance holds the data; a section still loading", async () => {
    const held = cardSetup(() => ({ unavailable: () => "Shared Tasks: another instance." }));
    await held.actions.openCard(KEY, "Launch");
    const loading = cardSetup();
    loading.set(null);
    await loading.actions.openCard(KEY, "Launch");
    expect(held.prompter.notices).toEqual(["Shared Tasks: another instance."]);
    expect(loading.prompter.notices).toEqual([
      "Shared Tasks: this section is still loading. Try again in a moment.",
    ]);
    expect([...held.prompter.dialogs, ...loading.prompter.dialogs]).toEqual([]);
  });

  it("offers what the facts allow, in order; read-only offers no invite and no removal", async () => {
    const t = cardSetup(() => ({
      recoveryItems: () => [{ kind: "stale-work" } as unknown as RecoveryItem],
    }));
    t.set(card({ held: [{ path: "Plan.md", line: 4, cause: "boundary" }] }));
    await t.actions.openCard(KEY, "Launch");
    expect(t.opened()[1].map((a) => a.label)).toEqual([
      "Review conflicts…",
      "Invite collaborator…",
      "Go to line 5",
      "Repair shared sections in this note",
      "Resource status",
    ]);
    expect(Object.keys(t.opened()[3])).toEqual(["alias", "remove"]);

    // A5, D10: Invite applies but is blocked on a read-only device: shown, disabled, with why.
    const readOnly = cardSetup(() => ({ readOnly: () => true }));
    await readOnly.actions.openCard(KEY, "Launch");
    expect(readOnly.opened()[1].map((a) => [a.label, a.disabled])).toEqual([
      ["Invite collaborator…", `${SECTIONS_READ_ONLY}.`],
      ["Resource status", undefined],
    ]);
    expect(Object.keys(readOnly.opened()[3])).toEqual(["alias"]);
  });

  it("A5/D10: Invite reads the same descriptor as the pane; blocked, it is disabled with its reason", async () => {
    const invite = async (over: Record<string, unknown>) => {
      const t = cardSetup();
      t.set(card(over));
      await t.actions.openCard(KEY, "Launch");
      return t.opened()[1].find((a) => a.label === "Invite collaborator…");
    };
    expect((await invite({}))?.disabled).toBeUndefined();
    // Unknown access is neither a grant nor a denial: it waits.
    expect((await invite({ access: { canInvite: false, invite: null } }))?.disabled).toBe(
      "Inviting waits until this device has checked access with the server.",
    );
    expect((await invite({ access: undefined }))?.disabled).toBe(
      "Inviting waits until this device has checked access with the server.",
    );
    expect((await invite({ access: { canInvite: false, invite: false } }))?.disabled).toBe(
      "You can't invite others to this section.",
    );
    // I4: a local-only share is not ready for an invitation.
    expect((await invite({ hosting: "pending" }))?.disabled).toBe(
      "Not on its server yet: nobody can join until it is hosted.",
    );
    // A disabled button runs nothing.
    const t = cardSetup();
    t.set(card({ access: { canInvite: false, invite: false } }));
    await t.actions.openCard(KEY, "Launch");
    expect(t.opened()[1].find((a) => a.label === "Invite collaborator…")?.disabled).toBeDefined();
  });

  it("LFCP-03-041: the executor's inviteRefusal is the card's Invite reason, read now", async () => {
    const cases: Record<string, unknown>[] = [
      {},
      { access: { canInvite: false, invite: null } },
      { access: undefined },
      { access: { canInvite: false, invite: false } },
      { hosting: "pending" },
    ];
    for (const over of cases) {
      const t = cardSetup();
      t.set(card(over));
      await t.actions.openCard(KEY, "Launch");
      const shown = t.opened()[1].find((a) => a.label === "Invite collaborator…")?.disabled;
      expect(await t.actions.inviteRefusal(KEY)).toBe(shown ?? null);
    }
    // Read-only: the host's guard, as the card says it.
    const readOnly = cardSetup(() => ({ readOnly: () => true }));
    expect(await readOnly.actions.inviteRefusal(KEY)).toBe(`${SECTIONS_READ_ONLY}.`);
    // No status yet: it waits; never a grant.
    const loading = cardSetup();
    loading.set(null);
    expect(await loading.actions.inviteRefusal(KEY)).toBe(
      "Inviting waits until this device has checked access with the server.",
    );
  });

  it("LFCP-03-012: the card links to the pane once the host gives it an entry", async () => {
    const t = cardSetup();
    let opened = 0;
    t.actions.paneEntry(() => {
      opened++;
    });
    await t.actions.openCard(KEY, "Launch");
    expect(t.opened()[1].map((a) => a.label)).toEqual([
      "Invite collaborator…",
      "Resource status",
      "Open Shared Tasks pane",
    ]);
    t.press("Open Shared Tasks pane");
    expect(opened).toBe(1);
    expect(t.prompter.notices).toEqual([]);
  });

  it("T4 (LFCP-03-009): Repair from the card on a note only in Reading view says to open it for editing", async () => {
    const t = cardSetup();
    t.set(card({ held: [{ path: "Plan.md", line: 4, cause: "boundary" }] }));
    // Reading view: the note opens, but no editor is open for editing.
    t.notes.goToLine = async () => null;
    await t.actions.openCard(KEY, "Launch");
    t.press("Repair shared sections in this note");
    await flush(20);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: open the note for editing to repair it (it is in Reading view).",
    ]);
    expect(t.prompter.dialogs.filter((d) => d.kind === "repair")).toEqual([]);
    // A note gone: the host has said so; nothing more is said here.
    t.notes.files.delete("Plan.md");
    await t.actions.openCard(KEY, "Launch");
    t.press("Repair shared sections in this note");
    await flush(20);
    expect(t.prompter.notices).toHaveLength(1);
  });

  it("an action on a section no longer here runs nothing; one still here runs its command", async () => {
    let known = true;
    const t = cardSetup(() => ({ known: () => known }));
    await t.actions.openCard(KEY, "Launch");
    t.press("Invite collaborator…");
    known = false;
    t.press("Resource status");
    await flush();
    expect(t.commandCalls).toEqual(["inviteTo"]);
    expect(t.prompter.notices).toEqual(["Shared Tasks: this section is no longer on this device."]);
  });

  it("LFCP-03-010: the card's buttons run through the dispatcher, to the same handlers", async () => {
    const t = cardSetup(() => ({
      recoveryItems: () => [{ kind: "stale-work" } as unknown as RecoveryItem],
      model: () => ({
        snapshot: () => undefined,
        task: () => undefined,
        taskView: () => undefined,
      }),
    }));
    const ran: string[] = [];
    const d = new ActionDispatcher(
      coreHandlers({
        sections: () => t.actions,
        collab: {
          joinCollaboration: async () => undefined,
          inviteCollaborator: async () => undefined,
          inviteTo: async (r) => void ran.push(`inviteTo ${toBase64url(r)}`),
          resourceStatus: async () => undefined,
        },
      }),
    );
    t.actions.dispatchThrough((id, request, surface) => {
      ran.push(`${surface} ${id} ${request.section?.key}`);
      return d.run(id, request, surface);
    });
    await t.actions.openCard(KEY, "Launch");
    t.press("Review conflicts…");
    t.press("Invite collaborator…");
    await flush();
    expect(ran).toEqual([
      `card review-conflicts ${KEY}`,
      `card invite ${KEY}`,
      `inviteTo ${KEY.slice(0, KEY.indexOf("#"))}`,
    ]);
    expect(t.prompter.dialogs.filter((x) => x.kind === "review")).toHaveLength(1);
  });

  it("removing access: an unknown outcome says the access list decides; the open card is redrawn", async () => {
    let outcome: () => Promise<RevokeOutcome | null> = () => Promise.reject(new Error("timeout"));
    const t = cardSetup(() => ({ revokeAccess: () => outcome() }));
    await t.actions.openCard(KEY, "Launch");
    t.prompter.script.confirm = [true, true, false, true];
    t.opened()[3].remove?.("ab".repeat(16), "Member abababab");
    await flush(20);
    outcome = async () => ({ kind: "refused", reason: "NOT_OWNER" });
    t.opened()[3].remove?.("ab".repeat(16), "Member abababab");
    await flush(20);
    // Cancelled: nothing asked of the runtime.
    outcome = () => Promise.reject(new Error("must not run"));
    t.opened()[3].remove?.("ab".repeat(16), "Member abababab");
    await flush(20);
    // Not running: nothing said.
    outcome = async () => null;
    t.opened()[3].remove?.("ab".repeat(16), "Member abababab");
    await flush(20);
    expect(t.prompter.notices[0]).toBe(
      "Shared Tasks: Removing access failed. The access list shows whether a change is pending.",
    );
    expect(t.prompter.notices).toHaveLength(2);
    expect(t.prompter.cardUpdates).toHaveLength(2);
  });

  it("discards kept copies after asking; the status is recomputed", async () => {
    const resolved: string[] = [];
    const kept = [
      { candidateId: "c1", projectionId: `x#${KEY}#y`, reason: "rejected", sourceText: "t" },
      { candidateId: "c2", projectionId: "other", reason: "rejected", sourceText: "t" },
    ] as PendingCandidate[];
    const t = cardSetup(() => ({
      bases: () => new MemorySectionBaseStore(),
      candidates: () => ({
        putCandidate: async () => undefined,
        allCandidates: async () => kept,
        resolveCandidate: async (id) => {
          resolved.push(id);
        },
      }),
    }));
    await t.actions.openCard(KEY, "Launch");
    t.prompter.script.confirm = [false, true];
    t.press("Discard the local copy…");
    await flush(20);
    expect(resolved).toEqual([]);
    t.press("Discard the local copy…");
    await flush(20);
    expect(resolved).toEqual(["c1"]);
    expect(t.prompter.notices).toEqual(["Shared Tasks: the local copy was discarded."]);
    expect(t.calls).toEqual(["scheduleStatus"]);
  });

  it("LFCP-03-019: discard stays secondary, with the same exact confirmation from the pane and the card", async () => {
    const kept = [
      { candidateId: "c1", projectionId: `x#${KEY}#y`, reason: "rejected", sourceText: "t" },
    ] as PendingCandidate[];
    const t = cardSetup(() => ({
      bases: () => new MemorySectionBaseStore(),
      candidates: () => ({
        putCandidate: async () => undefined,
        allCandidates: async () => kept,
        resolveCandidate: async () => undefined,
      }),
    }));
    const d = new ActionDispatcher(
      coreHandlers({
        sections: () => t.actions,
        collab: {
          joinCollaboration: async () => undefined,
          inviteCollaborator: async () => undefined,
          inviteTo: async () => undefined,
          resourceStatus: async () => undefined,
        },
      }),
    );
    t.prompter.script.confirm = [false, false];
    await d.run("discard-local-copy", { section: { key: KEY, title: "Launch" } }, "pane");
    await t.actions.openCard(KEY, "Launch");
    t.press("Discard the local copy…");
    await flush(20);
    const asked = t.prompter.dialogs.filter((x) => x.kind === "confirm").map((x) => x.args[0]);
    const exact = {
      title: 'Local copies of "Launch"',
      message:
        "One copy of this section's text was kept on this device when the sync server refused it. It is not shared. Discard it? Your note and the shared section are not changed.",
      action: "Discard",
    };
    expect(asked).toEqual([exact, exact]);
    expect(t.prompter.notices).toEqual([]);
  });

  it("A7: every card button runs its action through the dispatcher, to the one handler", async () => {
    const resolved: string[] = [];
    const kept = [
      { candidateId: "c1", projectionId: `x#${KEY}#y`, reason: "rejected", sourceText: "t" },
    ] as PendingCandidate[];
    const t = cardSetup(() => ({
      bases: () => new MemorySectionBaseStore(),
      candidates: () => ({
        putCandidate: async () => undefined,
        allCandidates: async () => kept,
        resolveCandidate: async (id) => {
          resolved.push(id);
        },
      }),
    }));
    t.set(card({ held: [{ path: "Plan.md", line: 4, cause: "boundary" }] }));
    const ran: string[] = [];
    const d = new ActionDispatcher(
      coreHandlers({
        sections: () => t.actions,
        collab: {
          joinCollaboration: async () => undefined,
          inviteCollaborator: async () => undefined,
          inviteTo: async () => undefined,
          resourceStatus: async () => undefined,
        },
      }),
    );
    t.actions.dispatchThrough((id, request, surface) => {
      ran.push(
        `${surface} ${id} ${request.at === undefined ? "" : `${request.at.path}:${request.at.line}`}`,
      );
      return d.run(id, request, surface);
    });
    await t.actions.openCard(KEY, "Launch");
    t.prompter.script.confirm = [true];
    for (const label of [
      "Go to line 5",
      "Repair shared sections in this note",
      "Resource status",
      "Discard the local copy…",
    ])
      t.press(label);
    await flush(30);
    expect(ran).toEqual([
      "card go-to-problem Plan.md:4",
      "card repair-sections Plan.md:4",
      "card resource-status ",
      "card discard-local-copy ",
    ]);
    // The handlers ran: the line located, then the repair's note opened (its services
    // are not running here, so it says so), the Resource's status, the copy discarded.
    expect(t.notes.located.map(([path]) => path)).toEqual(["Plan.md", "Plan.md"]);
    expect(t.notes.located[0]).toEqual(["Plan.md", 4]);
    expect(t.commandCalls).toEqual(["resourceStatusOf"]);
    expect(resolved).toEqual(["c1"]);
  });

  it("only the open card is redrawn; a new card closes the previous one", async () => {
    const t = cardSetup();
    await t.actions.refreshCard();
    await t.actions.openCard(KEY, "Launch");
    await t.actions.openCard(KEY, "Launch");
    expect(t.prompter.open("card")).toHaveLength(1);
    await t.actions.refreshCard();
    expect(t.prompter.cardUpdates).toHaveLength(1);
    t.opened()[2]();
    await t.actions.refreshCard();
    expect(t.prompter.cardUpdates).toHaveLength(1);
  });

  it("review conflicts at the cursor: refused outside a section or while loading; else the review", async () => {
    const applied: string[] = [];
    let known = false;
    const t = cardSetup(() => ({
      known: () => known,
      model: () => ({
        snapshot: () => undefined,
        task: () => undefined,
        taskView: () => undefined,
      }),
      resolveRecovery: async (key) => {
        applied.push(key);
        return { items: [], note: null };
      },
    }));
    t.actions.reviewConflictsAt(BOUND, 0);
    t.actions.reviewConflictsAt(BOUND, 3);
    known = true;
    t.actions.reviewConflictsAt(BOUND, 3);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: put the cursor in a shared section to review its conflicts.",
      "Shared Tasks: this section is still loading. Try again in a moment.",
    ]);
    const review = t.prompter.dialogs.find((d) => d.kind === "review");
    expect(review?.args[0]).toBe("Launch");
    const apply = review?.args[2] as (i: RecoveryItem, c: RecoveryChoice) => Promise<unknown>;
    await apply({} as RecoveryItem, {} as RecoveryChoice);
    expect(applied).toEqual([KEY]);
  });

  it("details at the cursor open that section's card", async () => {
    const t = cardSetup();
    t.notes.files.set("Plan.md", BOUND);
    t.editor.line = 0;
    t.actions.openCardAt(t.editor.at());
    t.editor.line = 3;
    t.actions.openCardAt(t.editor.at());
    await flush(20);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: put the cursor in a shared section to see its details.",
    ]);
    expect(t.prompter.open("card")).toHaveLength(1);
  });
});

describe("stable target and exact selection (LFCP-03-009, U03-03/04/05/12)", () => {
  const TAIL = "PRIVATE_TAIL_c0ffee: stays on this device.";
  const NEXT = "PRIVATE_NEXT_beef: another section.";
  const SEL = ["## Plan", "- [ ] Alpha", "- [ ] Beta", "", TAIL, "", "## Later", NEXT, ""].join(
    "\n",
  );
  const sel = (from: [number, number], to: [number, number]) => [
    { anchor: { line: from[0], ch: from[1] }, head: { line: to[0], ch: to[1] } },
  ];
  /** The share setup on SEL, recording the previews prepare was given. */
  function selSetup() {
    const t = setup();
    t.notes.files.set("Plan.md", SEL);
    t.editor.line = 0;
    const prepared: SharePreview[] = [];
    const prepare = t.creation.prepare.bind(t.creation);
    t.creation.prepare = async (path, md, preview) => {
      prepared.push(preview);
      return prepare(path, md, preview);
    };
    return { ...t, prepared };
  }
  const shown = (t: { prompter: RecordingPrompter }, i = 0) =>
    t.prompter.dialogs.filter((d) => d.kind === "share")[i]?.args[0] as SharePreview | undefined;

  it("U03-04: an exact selection is previewed and created as it is; the text after it stays out", async () => {
    const t = selSetup();
    // Heading through Beta; the selection ends at column 0 of the blank line (that ends it on Beta).
    t.editor.selections = sel([0, 3], [3, 0]);
    t.prompter.script.share = [true];
    await t.actions.share(t.editor.at());
    const preview = shown(t);
    expect(preview?.range).toEqual({ headingLine: 0, lastLine: 2 });
    expect(preview?.title).toBe("Plan");
    expect(preview?.content).toBe("- [ ] Alpha\n- [ ] Beta");
    expect(preview?.warnings).toContain("private-text-before-next-heading");
    expect(t.prepared.map((p) => p.range)).toEqual([{ headingLine: 0, lastLine: 2 }]);
    expect(JSON.stringify(t.prepared)).not.toContain("PRIVATE_NEXT");
    expect(t.prepared[0]?.content).not.toContain("PRIVATE_TAIL");
    expect(t.prompter.dialogs.map((d) => d.kind)).toEqual(["share"]);
  });

  it("S1/S2: an ineligible selection is never widened by itself; the fallback is chosen and previewed anew", async () => {
    const declined = selSetup();
    declined.editor.selections = sel([1, 0], [2, 10]);
    declined.prompter.script.confirm = [false];
    await declined.actions.share(declined.editor.at());
    const ask = declined.prompter.dialogs[0];
    expect(ask?.kind).toBe("confirm");
    expect(ask?.args[0]).toMatchObject({
      title: "Share section",
      action: "Share the whole section…",
    });
    expect((ask?.args[0] as { message: string } | undefined)?.message).toContain(
      "A shared section starts at its heading. Your selection does not.",
    );
    expect(declined.prompter.dialogs).toHaveLength(1);
    expect(declined.calls).toEqual([]);

    const chosen = selSetup();
    chosen.editor.selections = sel([1, 0], [2, 10]);
    chosen.prompter.script.confirm = [true];
    chosen.prompter.script.share = [true];
    await chosen.actions.share(chosen.editor.at());
    expect(chosen.prompter.dialogs.map((d) => d.kind)).toEqual(["confirm", "share"]);
    // The whole heading section, from proposeRange: a new preview, private tail included as shown.
    expect(shown(chosen)?.range).toEqual({ headingLine: 0, lastLine: 4 });
    expect(shown(chosen)?.content).toContain("PRIVATE_TAIL");
    expect(chosen.prepared.map((p) => p.range)).toEqual([{ headingLine: 0, lastLine: 4 }]);
  });

  it("Share the whole section… from a surface opens the whole section's preview without asking", async () => {
    const t = selSetup();
    t.editor.selections = sel([1, 0], [2, 4]);
    t.prompter.script.share = [false];
    await t.actions.shareWholeSection(t.editor.at());
    expect(t.prompter.dialogs.map((d) => d.kind)).toEqual(["share"]);
    expect(shown(t)?.range).toEqual({ headingLine: 0, lastLine: 4 });
  });

  it("a selection with no fallback is refused with its reason, before any dialog", async () => {
    const crossing = selSetup();
    crossing.editor.selections = sel([0, 0], [7, 5]);
    await crossing.actions.share(crossing.editor.at());
    expect(crossing.prompter.dialogs).toEqual([]);
    expect(crossing.prompter.notices).toEqual([
      "Shared Tasks: The selection runs past the end of the heading's section.",
    ]);
    const two = selSetup();
    two.editor.selections = [...sel([0, 0], [1, 11]), ...sel([6, 0], [7, 4])];
    await two.actions.share(two.editor.at());
    expect(two.prompter.dialogs).toEqual([]);
    expect(two.prompter.notices).toEqual([
      "Shared Tasks: Several parts of the note are selected. Select one range of lines.",
    ]);
    expect([...crossing.calls, ...two.calls]).toEqual([]);
  });

  it("U03-05: an exact selection whose note changed while the preview was open is refused, not widened", async () => {
    const t = selSetup();
    t.editor.selections = sel([0, 0], [2, 10]);
    const flow = t.actions.share(t.editor.at());
    await flush();
    t.notes.files.set("Plan.md", SEL.replace("- [ ] Beta", "- [ ] Beta\n- [ ] Gamma"));
    t.prompter.open("share")[0]?.answer(true);
    await flow;
    expect(t.prompter.dialogs.map((d) => d.kind)).toEqual(["share"]);
    expect(t.calls).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the note changed while the preview was open. Nothing was shared; select the lines and share again.",
    ]);
  });

  it("U03-03: another note active and the flow's own note closed: the flow still shares its note", async () => {
    const t = setup();
    const flow = t.actions.share(t.editor.at());
    await flush();
    // The tab now shows Other.md; Plan.md is closed (its file unchanged).
    t.notes.files.set("Other.md", "## Other\n- [ ] Elsewhere\n");
    t.notes.open.clear();
    t.notes.open.add("Other.md");
    t.prompter.open("share")[0]?.answer(true);
    await flow;
    expect(t.calls.slice(0, 2)).toEqual(['prepare Plan.md "Plan"', "run op-1"]);
    expect(t.prompter.notices).toEqual(['Shared Tasks: section "Plan" is shared.']);
  });

  it("IME, Reading view and a capture older than the note: refused before any dialog", async () => {
    const composing = setup();
    composing.editor.composing = true;
    await composing.actions.share(composing.editor.at());
    await composing.actions.insertSection(composing.editor.at());
    expect(composing.prompter.notices).toEqual([
      "Shared Tasks: finish typing first (text is still being composed). Nothing was shared.",
      "Shared Tasks: finish typing first (text is still being composed). Nothing was inserted.",
    ]);
    const reading = setup();
    reading.editor.mode = "reading";
    await reading.actions.share(reading.editor.at());
    expect(reading.prompter.notices).toEqual([
      "Shared Tasks: open the note for editing first (it is in Reading view). Nothing was shared.",
    ]);
    const old = setup();
    const at = old.editor.at();
    old.notes.files.set("Plan.md", `${NOTE}more\n`);
    await old.actions.share(at);
    expect(old.prompter.notices).toEqual([
      "Shared Tasks: the note changed since you started. Nothing was shared; try again.",
    ]);
    for (const t of [composing, reading, old]) {
      expect(t.prompter.dialogs).toEqual([]);
      expect(t.calls).toEqual([]);
    }
  });

  it("an IME composition in the note when Share is approved: nothing created", async () => {
    const t = setup();
    const flow = t.actions.share(t.editor.at());
    await flush();
    t.notes.composing.add("Plan.md");
    t.prompter.open("share")[0]?.answer(true);
    await flow;
    expect(t.calls).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: finish typing first (text is still being composed). Nothing was shared.",
    ]);
  });

  describe("insert", () => {
    const choice = { resource: new Uint8Array(32), sectionId: "s1", title: "Shared" };
    function insertSetup() {
      const calls: string[] = [];
      const insertion = fakeInsertion(calls);
      const t = setup(() => ({
        insertion: () => insertion,
        sectionChoices: async () => [choice],
        watch: async () => undefined,
        indexed: (path) => calls.push(`indexed ${path}`),
        pass: (path, text) => calls.push(`pass ${path}${text === undefined ? "" : " (file)"}`),
      }));
      t.prompter.script.pick = [choice];
      return { ...t, calls };
    }

    it("U03-12: a note closed and another opened meanwhile gets the block at the captured line; the result names it", async () => {
      const t = insertSetup();
      const flow = t.actions.insertSection(t.editor.at());
      await flush(20);
      t.notes.files.set("Other.md", "## Other\n");
      t.notes.open.clear();
      t.notes.open.add("Other.md");
      t.prompter.open("insert")[0]?.answer(true);
      await flow;
      expect(t.calls).toEqual([
        "preview",
        `prepare Plan.md line ${PLAN} rev ${NOTE.length}`,
        "run ins-1",
        "indexed Plan.md",
        // Closed: passed through its file, as a share passes it (LFCP-03-016).
        "pass Plan.md (file)",
      ]);
      expect(t.prompter.notices).toEqual(['Shared Tasks: section "Shared" inserted into "Plan".']);
    });

    it("U03-12: renamed meanwhile, the block goes into the renamed note, never at the old path", async () => {
      const t = insertSetup();
      const flow = t.actions.insertSection(t.editor.at());
      await flush(20);
      t.actions.noteRenamed("Plan.md", "Projects/Plan 2.md");
      t.notes.files.set("Projects/Plan 2.md", NOTE);
      t.notes.files.delete("Plan.md");
      t.notes.open.clear();
      t.notes.open.add("Projects/Plan 2.md");
      t.prompter.open("insert")[0]?.answer(true);
      await flow;
      expect(t.calls).toContain(`prepare Projects/Plan 2.md line ${PLAN} rev ${NOTE.length}`);
      expect(t.calls.some((c) => c.includes(" Plan.md"))).toBe(false);
      expect(t.prompter.notices).toEqual([
        'Shared Tasks: section "Shared" inserted into "Plan 2".',
      ]);
    });
  });

  it("detach: a note deleted during the confirmation is not written", async () => {
    const t = setup(() => loadedSection());
    t.notes.files.set("Plan.md", BOUND);
    t.editor.line = 3;
    const flow = t.actions.detachSectionAt(t.editor.at());
    await flush();
    t.actions.noteDeleted("Plan.md");
    t.prompter.open("confirm")[0]?.answer(true);
    await flow;
    expect(t.notes.writes).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the note was deleted. Nothing was detached.",
    ]);
  });
});

describe("one dispatcher for every surface (LFCP-03-010, U03-07, U03-09)", () => {
  function dispatch(t: ReturnType<typeof setup>, host?: HostEntry) {
    const collab: string[] = [];
    const d = new ActionDispatcher(
      coreHandlers({
        sections: () => t.actions,
        collab: {
          joinCollaboration: async () => void collab.push("join"),
          inviteCollaborator: async () => void collab.push("invite (choose)"),
          inviteTo: async (r) => void collab.push(`invite ${toBase64url(r)}`),
          resourceStatus: async () => void collab.push("resource status (choose)"),
        },
        ...(host === undefined ? {} : { host }),
      }),
    );
    return { d, collab };
  }

  it("LFCP-03-013: every action of the catalogue has its handler; none is a dead button", async () => {
    const t = setup();
    const host: string[] = [];
    const { d } = dispatch(t, {
      nextProblem: (at) => void host.push(`next problem ${at.path}`),
      openForEditing: async (at) => void host.push(`edit ${at.path}`),
      openSettings: () => void host.push("settings"),
      copyReadable: async (at) => void host.push(`copy ${at.path}`),
      copySharedSection: async (at) => void host.push(`copy shared ${at.path}:${at.cursorLine}`),
    });
    for (const id of ACTION_IDS) expect(d.handles(id), id).toBe(true);
    const at = t.editor.at();
    await d.run("open-for-editing", { target: at }, "pane");
    await d.run("open-settings", {}, "pane");
    await d.run("copy-readable", { target: at }, "pane");
    await d.run("copy-shared-section", { target: at }, "pane");
    // No held copy for the section: the note's next problem, as the palette's command.
    await d.run("go-to-problem", { target: at, section: { key: KEY, title: "Launch" } }, "pane");
    expect(host).toEqual([
      "edit Plan.md",
      "settings",
      "copy Plan.md",
      `copy shared Plan.md:${at.cursorLine}`,
      "next problem Plan.md",
    ]);
  });

  it("sync details, local changes and removing access open the section's card; discard says when nothing is kept", async () => {
    const t = setup(() => ({
      cardContent: async () =>
        ({
          heading: "Launch",
          facts: [],
          problems: [],
          held: [],
          view: statusView({
            session: "s",
            revision: 1,
            replica: "loaded",
            access: "writer",
            pendingControl: [],
            connection: "connected",
            catchUp: "current-at-checkpoint",
            problems: [],
            batches: [],
            acceptanceEvidence: "available",
            projections: [],
          }),
        }) as never,
      known: () => true,
      held: (key) =>
        key === KEY
          ? [
              { path: "Other.md", line: 7, cause: "read-only", count: 5 } as never,
              { path: "Plan.md", line: 2, cause: "read-only", count: 1 } as never,
            ]
          : [],
    }));
    const { d } = dispatch(t);
    const section = { key: KEY, title: "Launch" };
    for (const id of ["sync-details", "review-local-changes", "remove-access"] as const)
      await d.run(id, { section }, "pane");
    expect(t.prompter.dialogs.filter((x) => x.kind === "card")).toHaveLength(3);
    await d.run("discard-local-copy", { section }, "pane");
    expect(t.prompter.notices.at(-1)).toBe(
      'Shared Tasks: no local copy of "Launch" is kept on this device.',
    );
    // Go to the problem: the held copy in the note in view first, then the one holding the most.
    t.notes.files.set("Other.md", "x\n".repeat(10));
    await d.run("go-to-problem", { section, target: t.editor.at() }, "pane");
    await d.run("go-to-problem", { section }, "card");
    expect(t.notes.located).toEqual([
      ["Plan.md", 2],
      ["Other.md", 7],
    ]);
  });

  it("continue-flow brings the running flow forward; a late click on a closed flow does nothing", async () => {
    const t = setup();
    const { d } = dispatch(t);
    const first = d.run("share-section", { target: t.editor.at() }, "palette");
    await flush();
    const [flow] = t.actions.flows();
    await d.run("continue-flow", { flow: flow?.generation ?? 0 }, "pane");
    expect(t.prompter.dialogs[0]?.forward).toBe(1);
    t.prompter.open("share")[0]?.answer(false);
    await first;
    await d.run("continue-flow", { flow: flow?.generation ?? 0 }, "pane");
    expect(t.prompter.dialogs[0]?.forward).toBe(1);
    expect(t.prompter.notices).toEqual([]);
  });

  it("palette, menu and pane on one note: one preview, brought forward, nothing created twice", async () => {
    const t = setup();
    const { d } = dispatch(t);
    const first = d.run("share-section", { target: t.editor.at() }, "palette");
    await flush();
    await d.run("share-section", { target: t.editor.at() }, "pane");
    await d.run("insert-into-note", { target: t.editor.at() }, "pane");
    await d.run("share-whole-section", { target: t.editor.at() }, "menu");
    expect(t.prompter.dialogs).toHaveLength(1);
    expect(t.prompter.dialogs[0]?.forward).toBe(3);
    t.prompter.open("share")[0]?.answer(true);
    await first;
    expect(t.calls.filter((c) => c.startsWith("prepare"))).toEqual(['prepare Plan.md "Plan"']);
    expect(t.prompter.notices).toEqual(['Shared Tasks: section "Plan" is shared.']);
  });

  it("D12 across surfaces: palette share unknown, the pane's Check the result settles the same operation", async () => {
    const t = setup();
    const { d } = dispatch(t);
    t.prompter.script.share = [true];
    t.creation.result = () => Promise.reject(new Error("socket closed"));
    await d.run("share-section", { target: t.editor.at() }, "palette");
    const [flow] = t.actions.flows();
    // The menu's repeat: checked (still unknown), not a new preview.
    await d.run("share-section", { target: t.editor.at() }, "menu");
    await flush();
    expect(t.prompter.dialogs).toHaveLength(1);
    t.creation.result = (e) => Promise.resolve({ kind: "hosted", entry: e });
    // A late click for another generation does nothing.
    await d.run("check-result", { flow: (flow?.generation ?? 0) + 100 }, "pane");
    expect(t.calls.filter((c) => c === "run op-1")).toHaveLength(2);
    await d.run("check-result", { flow: flow?.generation ?? 0 }, "pane");
    expect(t.calls.filter((c) => c === "run op-1")).toHaveLength(3);
    expect(t.calls).not.toContain("run op-2");
    expect(t.prompter.notices.at(-1)).toBe('Shared Tasks: section "Plan" is shared.');
    expect(t.actions.flows()).toEqual([]);
  });

  it("the card, the pane and the palette reach the same collaboration handlers", async () => {
    const t = setup();
    const { d, collab } = dispatch(t);
    const section = { key: `${R0}#s1`, title: "Plan" };
    await d.run("invite", { section }, "card");
    await d.run("invite", { section }, "pane");
    await d.run("invite", {}, "palette");
    await d.run("join-with-link", {}, "palette");
    await d.run("join-with-link", {}, "pane");
    await d.run("resource-status", {}, "palette");
    expect(collab).toEqual([
      `invite ${R0}`,
      `invite ${R0}`,
      "invite (choose)",
      "join",
      "join",
      "resource status (choose)",
    ]);
    // Without the host's part (the editor, the clipboard, the settings), those actions have no handler.
    for (const id of [
      "open-for-editing",
      "open-settings",
      "copy-readable",
      "copy-shared-section",
    ] as const)
      expect(d.handles(id)).toBe(false);
  });
});

describe("problem hub resolvers (LFCP-03-018, U03-16)", () => {
  const ITEMS: RecoveryItem[] = [
    { kind: "title", key: "title", values: ["Launch", "Go-live"] },
    {
      kind: "lifecycle",
      key: "lifecycle:n1",
      nodeId: "n1",
      label: 'Task "Alpha"',
    },
  ];
  const MODEL: SectionSnapshot = {
    revision: "r1",
    title: "Launch",
    ready: true,
    nodes: {},
    order: { "": [] },
    problems: [],
  };
  const handlers = (actions: SectionActions) =>
    new ActionDispatcher(
      coreHandlers({
        sections: () => actions,
        collab: {
          joinCollaboration: async () => undefined,
          inviteCollaborator: async () => undefined,
          inviteTo: async () => undefined,
          resourceStatus: async () => undefined,
        },
      }),
    );

  function conflictSetup(items: () => RecoveryItem[]) {
    const resolved: string[] = [];
    const t = setup(() => ({
      model: () => ({ snapshot: () => MODEL, task: () => undefined, taskView: () => undefined }),
      known: () => true,
      recoveryItems: () => items(),
      resolveRecovery: async (_key, item: RecoveryItem, _choice: RecoveryChoice) => {
        resolved.push(item.key);
        // Applied, but the model has not changed yet: the item is still there.
        return { items: items(), note: null };
      },
    }));
    let changes = 0;
    t.actions.onFlowsChange(() => changes++);
    return { ...t, resolved, changes: () => changes };
  }
  type Review = Parameters<SectionPrompter["review"]>;
  /** The arguments of the dialog of `kind` that was opened; throws when none was. */
  const argsOf = <T>(t: { prompter: RecordingPrompter }, kind: string): T => {
    const d = t.prompter.dialogs.find((x) => x.kind === kind);
    if (d === undefined) throw new Error(`no ${kind} dialog`);
    return d.args as T;
  };

  it("a conflict row opens the review on its RecoveryItem.key, that item first", async () => {
    const t = conflictSetup(() => ITEMS);
    await handlers(t.actions).run(
      "review-conflicts",
      {
        section: { key: KEY, title: "Launch" },
        problem: { kind: "conflict", key: "lifecycle:n1" },
      },
      "pane",
    );
    const [title, items] = argsOf<Review>(t, "review");
    expect(title).toBe("Launch");
    expect(items.map((i) => i.key)).toEqual(["lifecycle:n1", "title"]);
  });

  it("stale choice: a conflict resolved meanwhile opens nothing and says so", async () => {
    const t = conflictSetup(() => ITEMS.slice(0, 1));
    t.actions.reviewConflicts(KEY, "Launch", "lifecycle:n1");
    expect(t.prompter.dialogs).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: this conflict is no longer there; nothing needs a choice for it now.",
    ]);
    // The pane reads its rows again.
    expect(t.changes()).toBe(1);
  });

  it("after a choice the pane reads the facts again; the item stays until the model drops it", async () => {
    let items = ITEMS;
    const t = conflictSetup(() => items);
    t.actions.reviewConflicts(KEY, "Launch", "title");
    const [, , apply] = argsOf<Review>(t, "review");
    const first = await apply(ITEMS[0] as RecoveryItem, { value: "Launch" });
    expect(t.resolved).toEqual(["title"]);
    // Nothing hides it: the review shows the items as the model has them.
    expect(first.items.map((i) => i.key)).toEqual(["title", "lifecycle:n1"]);
    expect(t.changes()).toBe(1);
    items = ITEMS.slice(1);
    const second = await apply(ITEMS[1] as RecoveryItem, { keep: true });
    expect(second.items.map((i) => i.key)).toEqual(["lifecycle:n1"]);
    expect(t.changes()).toBe(2);
  });

  describe("repair rows", () => {
    const BROKEN = [
      "# Notes",
      "## Launch",
      formatBoundary("start", S),
      "- [ ] One",
      "",
      "## Other",
      "",
    ].join("\n");
    const ref = (text: string, line = 2) => ({
      kind: "repair" as const,
      path: "Plan.md",
      key: `missing-end:${KEY}`,
      line,
      revision: contentHash(text),
    });
    function repairRowSetup(text: string) {
      const t = setup(() => ({
        bases: () => new MemorySectionBaseStore(),
        model: () => ({
          snapshot: () => undefined,
          task: () => undefined,
          taskView: () => undefined,
        }),
        candidates: () => ({
          putCandidate: async () => undefined,
          allCandidates: async () => [],
          resolveCandidate: async () => undefined,
        }),
      }));
      t.notes.files.set("Plan.md", text);
      return t;
    }
    type Repair = Parameters<SectionPrompter["repair"]>;

    it("same revision: the repair opens on the item at its line, nothing written", async () => {
      const t = repairRowSetup(BROKEN);
      await handlers(t.actions).run("repair-sections", { problem: ref(BROKEN) }, "pane");
      const [items] = argsOf<Repair>(t, "repair");
      expect(items.map((i) => [i.kind, i.line])).toEqual([["missing-end", 2]]);
      expect(t.notes.located).toEqual([["Plan.md", 2]]);
      expect(t.notes.writes).toEqual([]);
    });

    it("stale revision: the note is parsed again and the item found at its new line, nothing written", async () => {
      const t = repairRowSetup(BROKEN);
      const drawn = ref(BROKEN);
      // Two lines typed above the section after the pane drew the row.
      const moved = BROKEN.replace("# Notes\n", "# Notes\nNew line\nAnother\n");
      t.notes.files.set("Plan.md", moved);
      await t.actions.repairProblem(drawn);
      const [items, , actions] = argsOf<Repair>(t, "repair");
      expect(items.map((i) => [i.kind, i.line])).toEqual([["missing-end", 4]]);
      expect(t.notes.located).toEqual([["Plan.md", 4]]);
      expect(t.notes.writes).toEqual([]);
      expect(t.prompter.notices).toEqual([]);
      // Its candidates are the note's as it is now: a choice writes the marker there.
      const item = items[0];
      if (item?.kind !== "missing-end") throw new Error(item?.kind);
      expect(item.candidates.map((c) => c.afterLine)).toContain(5);
      await actions.boundary(item, 5);
      expect(t.notes.files.get("Plan.md")?.split("\n")[6]).toBe(formatBoundary("end", S));
    });

    it("changed/gone: a problem fixed meanwhile opens nothing and writes nothing", async () => {
      const t = repairRowSetup(BROKEN);
      const drawn = ref(BROKEN);
      t.notes.files.set(
        "Plan.md",
        BROKEN.replace("- [ ] One\n", `- [ ] One\n${formatBoundary("end", S)}\n`),
      );
      let changes = 0;
      t.actions.onFlowsChange(() => changes++);
      await t.actions.repairProblem(drawn);
      expect(t.prompter.dialogs).toEqual([]);
      expect(t.notes.writes).toEqual([]);
      expect(t.notes.located).toEqual([]);
      expect(t.prompter.notices).toEqual([
        "Shared Tasks: this problem is no longer in the note (it changed meanwhile). Nothing was changed.",
      ]);
      expect(changes).toBe(1);
    });

    it("same revision, another line: an item is never taken by its key alone at the same text", async () => {
      const t = repairRowSetup(BROKEN);
      await t.actions.repairProblem({ ...ref(BROKEN), line: 5 });
      expect(t.prompter.dialogs).toEqual([]);
      expect(t.notes.writes).toEqual([]);
    });

    it("a problem to locate goes to its line as the note is now; the note gone, nothing", async () => {
      const inside = [
        "## Launch",
        formatBoundary("start", S),
        "### Inside",
        formatBoundary("end", S),
        "",
      ].join("\n");
      const t = repairRowSetup(inside);
      const key = `locate:This content cannot be shared by this version yet: edit it, or end the section before it.:### Inside`;
      const drawn = {
        kind: "repair" as const,
        path: "Plan.md",
        key,
        line: 2,
        revision: contentHash(inside),
      };
      t.notes.files.set("Plan.md", `Intro\n${inside}`);
      await handlers(t.actions).run("go-to-problem", { problem: drawn }, "pane");
      expect(t.notes.located).toEqual([["Plan.md", 3]]);
      expect(t.prompter.dialogs).toEqual([]);
      t.notes.files.delete("Plan.md");
      t.notes.open.delete("Plan.md");
      await t.actions.repairProblem(drawn);
      expect(t.prompter.notices).toEqual(["Shared Tasks: the note is gone. Nothing was repaired."]);
      expect(t.notes.writes).toEqual([]);
    });

    it("post-repair: a placed boundary tells the pane to read the facts again", async () => {
      const t = repairRowSetup(BROKEN);
      let changes = 0;
      t.actions.onFlowsChange(() => changes++);
      await t.actions.repairProblem(ref(BROKEN));
      const [items, , actions] = argsOf<Repair>(t, "repair");
      const item = items[0];
      if (item?.kind !== "missing-end") throw new Error(item?.kind);
      await actions.boundary(item, 3);
      expect(t.calls).toEqual(["pass Plan.md"]);
      expect(changes).toBe(1);
    });
  });
});

describe("repair of a section the engine keeps waiting (LFCP-03-043 review)", () => {
  const T = "019a2f85-7b31-7c42-b85a-fc843e2f4009";
  const REF = `  <!-- lfcp-ref: lfcp1:${R0}#task:${T} -->`;
  const me = principalId(new Uint8Array(32).fill(4));
  const noteWith = (line: string) =>
    ["## Launch", formatBoundary("start", S), line, REF, formatBoundary("end", S), ""].join("\n");
  const MODEL_NOTE = noteWith("- [ ] Original 📅 2026-11-01");
  const CTX: PassContext = { caretLine: null, deletedIds: new Set(), origin: "other" };

  /** A real engine and the repair actions on one base store, the model a fake port and a replica. */
  function wired(
    text: string,
    view: (r: SharedObjectsReplica) => TaskView | undefined = (r) => r.task(T),
  ) {
    const { replica } = SharedObjectsReplica.create({
      resource: resourceId(fromBase64url(R0)),
      principal: me,
    });
    replica.apply(
      createTask({ id: T as never, title: "Original", createdBy: me, due: "2026-11-01" }).intent,
    );
    const port = new FakeSectionPort();
    const s = parseSections(MODEL_NOTE).sections[0];
    if (s === undefined) throw new Error("no section");
    port.host(R0, SID, markdownState(MODEL_NOTE, s).state);
    port.onTaskIntents = (intents) => {
      for (const i of intents) replica.apply(i as never);
    };
    const bases = new MemorySectionBaseStore();
    const journal = new MemorySectionJournalStore();
    const kept: PendingCandidate[] = [];
    const t = setup(() => ({
      bases: () => bases,
      model: () => ({
        snapshot: (r, sid) => port.snapshot(r, sid),
        task: (_r, id) => (id === T ? view(replica)?.task : undefined),
        taskView: (_r, id) => (id === T ? view(replica) : undefined),
      }),
      candidates: () => ({
        putCandidate: async (c) => {
          kept.push(c);
        },
        allCandidates: async () => kept,
        resolveCandidate: async () => undefined,
      }),
    }));
    t.notes.files.set("Plan.md", text);
    let op = 0;
    const engine = new SectionEngine({
      port,
      bases,
      journal,
      newNodeId: () => T,
      newOperationId: () => `op-${++op}`,
      newProjectionId: () => `projection-${op}`,
      createdBy: me,
      tasks: (_r, id) => (id === T ? { view: view(replica) } : undefined),
      newTask: () => ({ id: T, title: "unused" }),
    });
    /** Passes on the note as the host would, writing their changes. */
    const passes = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const md = t.notes.files.get("Plan.md") ?? "";
        const pass = await engine.pass("Plan.md", md, CTX);
        const out = applyChanges(md, pass.changes);
        t.notes.files.set("Plan.md", out);
        await engine.written(pass, out);
      }
      return t.notes.files.get("Plan.md") ?? "";
    };
    return { ...t, port, replica, bases, kept, passes };
  }
  type Repair = Parameters<SectionPrompter["repair"]>;
  const opened = (t: { prompter: RecordingPrompter }) =>
    t.prompter.dialogs.find((d) => d.kind === "repair")?.args as Repair;

  it("a Task-only difference is listed; Keep my version sends the note's fields", async () => {
    const edited = noteWith("- [ ] Local edit 📅 2026-11-05");
    const t = wired(edited);
    expect((await t.passes(1)).includes("Local edit")).toBe(true);
    await t.actions.repairNote(t.notes.editorOf("Plan.md", 0).at());
    const [, lost, actions] = opened(t);
    expect(lost.map((l) => [l.key, l.sharedUnavailable])).toEqual([[KEY, undefined]]);
    expect(lost[0]?.lines.some((l) => l.kind !== "same")).toBe(true);
    await actions.shareMine(KEY);
    expect(await t.passes(3)).toBe(edited);
    expect(t.replica.task(T)?.task?.title).toBe("Local edit");
    expect(t.replica.task(T)?.task?.due).toBe("2026-11-05");
  });

  it("a Task-only difference: Use the shared version shows the model, keeps a copy, then seeds", async () => {
    const edited = noteWith("- [ ] Local edit 📅 2026-11-05");
    const t = wired(edited);
    await t.passes(1);
    await t.actions.repairNote(t.notes.editorOf("Plan.md", 0).at());
    const [, , actions] = opened(t);
    await actions.useShared(KEY);
    expect(t.kept.map((c) => c.sourceText)).toEqual([edited.split("\n").slice(0, 5).join("\n")]);
    const out = await t.passes(2);
    expect(out).toContain("- [ ] Original");
    expect(out).toContain("📅 2026-11-01");
    expect(out).not.toContain("Local edit");
    expect(await t.bases.projectionsOf("Plan.md")).toHaveLength(1);
    expect(t.port.changes).toEqual([]);
  });

  it("a repeated 📅 the engine cannot read as the model's: listed, and Keep my version leaves it waiting no more", async () => {
    const edited = noteWith("- [ ] Original 📅 2026-11-01 📅 2026-11-02");
    const t = wired(edited);
    await t.passes(1);
    expect(await t.bases.projectionsOf("Plan.md")).toEqual([]);
    await t.actions.repairNote(t.notes.editorOf("Plan.md", 0).at());
    const [, lost, actions] = opened(t);
    expect(lost.map((l) => l.key)).toEqual([KEY]);
    await actions.shareMine(KEY);
    await t.passes(2);
    expect(await t.bases.projectionsOf("Plan.md")).toHaveLength(1);
  });

  it("a Task not here yet: Keep my version guesses no base; once it arrives the edit is asked about again, never lost", async () => {
    const edited = noteWith("- [ ] Local edit 📅 2026-11-05");
    let here = false;
    const t = wired(edited, (r) => (here ? r.task(T) : undefined));
    await t.passes(1);
    expect(await t.bases.projectionsOf("Plan.md")).toEqual([]);
    await t.actions.repairNote(t.notes.editorOf("Plan.md", 0).at());
    const [, lost, actions] = opened(t);
    expect(lost.map((l) => [l.key, l.sharedUnavailable])).toEqual([[KEY, true]]);
    await actions.useShared(KEY);
    expect(t.notes.writes).toEqual([]);
    expect(t.prompter.notices.at(-1)).toBe(
      "Shared Tasks: the shared version cannot be written here yet. Nothing was replaced.",
    );
    await actions.shareMine(KEY);
    expect(t.prompter.notices.at(-1)).toBe(
      "Shared Tasks: this note's version is kept as it is. A Task in it is still loading; once it has, the section asks again if the two versions differ.",
    );
    expect(await t.passes(2)).toBe(edited);
    expect(await t.bases.projectionsOf("Plan.md")).toEqual([]);
    // The Task arrives: the note still differs, so nothing is seeded or rendered over it.
    here = true;
    expect(await t.passes(3)).toBe(edited);
    expect(await t.bases.projectionsOf("Plan.md")).toEqual([]);
    expect(t.port.changes).toEqual([]);
    // Repair offers the choice again; Keep my version now sends the note's fields.
    t.prompter.dialogs.length = 0;
    await t.actions.repairNote(t.notes.editorOf("Plan.md", 0).at());
    const [, again, actions2] = opened(t);
    expect(again.map((l) => [l.key, l.sharedUnavailable])).toEqual([[KEY, undefined]]);
    await actions2.shareMine(KEY);
    expect(await t.passes(3)).toBe(edited);
    expect(t.replica.task(T)?.task?.title).toBe("Local edit");
    expect(t.replica.task(T)?.task?.due).toBe("2026-11-05");
  });

  it("a Task not here yet that the note shows as the model seeds once it arrives", async () => {
    let here = false;
    const t = wired(MODEL_NOTE, (r) => (here ? r.task(T) : undefined));
    await t.passes(1);
    expect(await t.bases.projectionsOf("Plan.md")).toEqual([]);
    here = true;
    expect(await t.passes(1)).toBe(MODEL_NOTE);
    expect(await t.bases.projectionsOf("Plan.md")).toHaveLength(1);
  });

  it("a note that shows the model is not listed", async () => {
    const t = wired(MODEL_NOTE);
    await t.actions.repairNote(t.notes.editorOf("Plan.md", 0).at());
    const [, lost] = opened(t) ?? [[], []];
    expect(lost ?? []).toEqual([]);
  });
});
