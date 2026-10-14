// LFCP-03-008 (F-C03, F-C08, U03-07): the section actions on recording
// mock ports, no Obsidian and no runtime. Each case records the dialogs
// asked for, the notices, the writes and the calls into the section
// cores, and checks the stale, unknown-outcome and error paths: nothing is
// written or created after a change, a refusal or a failure the executor
// cannot classify, and a running flow is revealed, never started twice.

import { describe, expect, it } from "vitest";
import { SECTIONS_READ_ONLY } from "../../../src/core/lfcp/runtime";
import type {
  CreationService,
  InsertionService,
  SectionNotes,
  SectionPrompter,
  SectionServices,
  TextChange,
} from "../../../src/core/sections/action-ports";
import { SectionActions } from "../../../src/core/sections/actions";
import { MemorySectionBaseStore, type SectionState } from "../../../src/core/sections/base";
import type { CreationEntry, CreationResult } from "../../../src/core/sections/create";
import { applyChanges } from "../../../src/core/sections/engine";
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
import type { PendingCandidate } from "../../../src/core/sections/journal";
import type { SectionSnapshot } from "../../../src/core/sections/port";
import type { RecoveryChoice, RecoveryItem } from "../../../src/core/sections/recovery";
import type { SharePreview } from "../../../src/core/sections/share";
import type { EditorMode, TargetCapture, TextSelection } from "../../../src/core/sections/target";
import type { RevokeOutcome } from "../../../src/core/status/access";
import type { SectionCard } from "../../../src/core/status/card";

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
  notice(message: string): void {
    this.notices.push(message);
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
  insertPreview(preview: unknown) {
    return this.#open<boolean>("insert", preview);
  }
  confirm(o: { title: string; message: string; action: string }) {
    return this.#open<boolean>("confirm", o);
  }
  async alias(current: string): Promise<string | null> {
    return this.#open<string | null>("alias", current).result;
  }
  repair(...args: unknown[]): void {
    this.#open("repair", ...args);
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

  it("unknown outcome: a creation that throws is left to its journal, said so; the note is free again", async () => {
    const t = setup();
    t.prompter.script.share = [true, false];
    t.creation.result = () => Promise.reject(new Error("socket closed"));
    await t.actions.share(t.editor.at());
    expect(t.calls).toEqual(['prepare Plan.md "Plan"', "run op-1"]);
    expect(t.prompter.notices).toEqual([
      'Shared Tasks: creating section "Plan" stopped (socket closed). It goes on at the next start.',
    ]);
    await t.actions.share(t.editor.at());
    expect(t.prompter.dialogs.filter((d) => d.kind === "share")).toHaveLength(2);
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
function fakeInsertion(calls: string[]) {
  const preview: InsertPreview = {
    resource: R0,
    sectionId: "s1",
    title: "Shared",
    block: "## Shared\n",
    readOnly: false,
    revision: "r1",
  };
  const i = {
    refused: null as InsertRefusal | null,
    result: (e: InsertionEntry): Promise<InsertResult> =>
      Promise.resolve({ kind: "inserted", entry: e }),
    async preview(): Promise<InsertPreview | { readonly refused: InsertRefusal }> {
      calls.push("preview");
      return i.refused === null ? preview : { refused: i.refused };
    },
    async prepare(path: string, markdown: string, line: number, p: InsertPreview) {
      calls.push(`prepare ${path} line ${line} rev ${markdown.length}`);
      const entry: InsertionEntry = {
        insertionId: "ins-1",
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
    expect(t.prompter.notices).toEqual([]);
  });

  it("stale: the note changed where the block would go; nothing indexed, said once", async () => {
    const t = insertSetup();
    t.prompter.script.pick = [choice];
    t.prompter.script.insert = [true];
    t.insertion.result = (e) => Promise.resolve({ kind: "stale", entry: e });
    await t.actions.insertSection(t.editor.at());
    expect(t.calls.at(-1)).toBe("run ins-1");
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

describe("detach (LFCP-03-008 over §10)", () => {
  async function detachSetup() {
    const bases = new MemorySectionBaseStore();
    await bases.save("p1", { locator: { path: "Plan.md", section: S }, state: EMPTY });
    await bases.save("p2", { locator: { path: "Other.md", section: S }, state: EMPTY });
    const t = setup(() => ({ bases: () => bases }));
    t.notes.files.set("Plan.md", BOUND);
    t.editor.line = 3;
    return { ...t, bases };
  }

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
      model: () => ({ snapshot: () => MODEL, task: () => undefined }),
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

  it("keeping this note's version adopts a base for it, and says so", async () => {
    const t = repairSetup(LOST);
    await t.actions.repairNote(t.editor.at());
    const [, , actions] = opened(t);
    await actions.shareMine(KEY);
    expect(await t.bases.projectionsOf("Plan.md")).toHaveLength(1);
    expect(t.notes.writes).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: your version of this section is being shared.",
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
  const card = (over: Record<string, unknown> = {}) =>
    ({
      heading: "Launch",
      status: "Current",
      facts: [],
      problems: [],
      shared: [],
      technical: [],
      held: [],
      access: { canInvite: true },
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

    const readOnly = cardSetup(() => ({ readOnly: () => true }));
    await readOnly.actions.openCard(KEY, "Launch");
    expect(readOnly.opened()[1].map((a) => a.label)).toEqual(["Resource status"]);
    expect(Object.keys(readOnly.opened()[3])).toEqual(["alias"]);
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
      model: () => ({ snapshot: () => undefined, task: () => undefined }),
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
        "pass Plan.md",
      ]);
      expect(t.prompter.notices).toEqual([
        'Shared Tasks: section "Shared" was inserted into "Plan", which is not open.',
      ]);
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
      expect(t.prompter.notices).toEqual([]);
    });
  });

  it("detach: a note deleted during the confirmation is not written", async () => {
    const t = setup();
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
