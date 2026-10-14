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
  SectionEditor,
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
import type { SharePreview } from "../../../src/core/sections/share";

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

/** Notes in memory; `open` paths have an editor. Writes recorded. */
class MemoryNotes implements SectionNotes {
  readonly files = new Map<string, string>();
  readonly open = new Set<string>();
  readonly writes: { path: string; changes: readonly TextChange[] }[] = [];
  editorOf(path: string, line = 0): SectionEditor & { line: number } {
    const files = this.files;
    return {
      line,
      text: () => files.get(path) ?? "",
      cursorLine() {
        return this.line;
      },
      setCursor(l: number) {
        this.line = l;
      },
    };
  }
  openEditor(path: string): SectionEditor | null {
    return this.open.has(path) ? this.editorOf(path) : null;
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
  async goToLine(path: string): Promise<SectionEditor | null> {
    return this.files.has(path) ? this.editorOf(path) : null;
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
    await t.actions.share(t.editor, "Plan.md");
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
    const first = t.actions.share(t.editor, "Plan.md");
    await flush();
    expect(t.prompter.open("share")).toHaveLength(1);
    await t.actions.share(t.editor, "Plan.md");
    // The insert entry shares the note's reservation.
    await t.actions.insertSection(t.editor, "Plan.md");
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
    const first = t.actions.share(t.editor, "Plan.md");
    await flush();
    await t.actions.share(t.editor, "Plan.md");
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
    await t.actions.share(t.editor, "Plan.md");
    expect(t.prompter.dialogs.filter((d) => d.kind === "share")).toHaveLength(2);
  });

  it("stale: a creation whose range changed is cancelled, nothing watched or bound", async () => {
    const t = setup();
    t.prompter.script.share = [true];
    t.creation.result = (e) => Promise.resolve({ kind: "stale", entry: e });
    await t.actions.share(t.editor, "Plan.md");
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
    await t.actions.share(t.editor, "Plan.md");
    expect(t.calls).toEqual(['prepare Plan.md "Plan"', "run op-1"]);
    expect(t.prompter.notices).toEqual([
      'Shared Tasks: creating section "Plan" stopped (socket closed). It goes on at the next start.',
    ]);
    await t.actions.share(t.editor, "Plan.md");
    expect(t.prompter.dialogs.filter((d) => d.kind === "share")).toHaveLength(2);
  });

  it("stale preview: a note changed while the preview was open is shown again; a lost heading shares nothing", async () => {
    const t = setup();
    const first = t.actions.share(t.editor, "Plan.md");
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
    const first = t.actions.share(t.editor, "Plan.md");
    await flush();
    t.actions.noteDeleted("Plan.md");
    t.prompter.open("share")[0]?.answer(true);
    await first;
    expect(t.calls).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the note was deleted while the preview was open. Nothing was shared.",
    ]);

    const second = t.actions.share(t.editor, "Plan.md");
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
    await readOnly.actions.share(readOnly.editor, "Plan.md");
    expect(readOnly.prompter.notices).toEqual([`Shared Tasks: ${SECTIONS_READ_ONLY}.`]);

    const noHeading = setup();
    noHeading.editor.line = 0;
    noHeading.notes.files.set("Plan.md", `intro\n${NOTE.replace(/^#.*$/gm, "text")}`);
    await noHeading.actions.share(noHeading.editor, "Plan.md");
    expect(noHeading.prompter.notices).toEqual([
      "Shared Tasks: put the cursor on or under a heading to share its section.",
    ]);

    const starting = setup(() => ({ creation: () => null }));
    starting.prompter.script.share = [true];
    await starting.actions.share(starting.editor, "Plan.md");
    expect(starting.prompter.notices).toEqual([
      "Shared Tasks: still starting. Share the section again in a moment.",
    ]);

    const noServer = setup(() => ({ server: () => " " }));
    noServer.prompter.script.share = [true];
    await noServer.actions.share(noServer.editor, "Plan.md");
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
    await t.actions.share(t.editor, "Plan.md");
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
    await t.actions.insertSection(t.editor, "Plan.md");
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
    await t.actions.insertSection(t.editor, "Plan.md");
    expect(t.calls.at(-1)).toBe("run ins-1");
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: the note changed where the section would go. Insert it again.",
    ]);
  });

  it("a refused preview, a cancelled choice, a deleted note and no section write nothing", async () => {
    const refused = insertSetup();
    refused.insertion.refused = "importing";
    refused.prompter.script.pick = [choice];
    await refused.actions.insertSection(refused.editor, "Plan.md");
    expect(refused.calls).toEqual(["preview"]);
    expect(refused.prompter.notices).toHaveLength(1);
    expect(refused.prompter.open()).toEqual([]);

    const cancelled = insertSetup();
    cancelled.prompter.script.pick = [null];
    await cancelled.actions.insertSection(cancelled.editor, "Plan.md");
    expect(cancelled.calls).toEqual([]);

    const deleted = insertSetup();
    deleted.prompter.script.pick = [choice];
    const flow = deleted.actions.insertSection(deleted.editor, "Plan.md");
    await flush(20);
    deleted.actions.noteDeleted("Plan.md");
    deleted.prompter.open("insert")[0]?.answer(true);
    await flow;
    expect(deleted.calls).toEqual(["preview", "watch"]);
    expect(deleted.prompter.notices).toEqual([
      "Shared Tasks: the note was deleted while the preview was open. Nothing was inserted.",
    ]);

    const none = insertSetup([]);
    await none.actions.insertSection(none.editor, "Plan.md");
    expect(none.prompter.notices).toEqual(["Shared Tasks: no shared section on this device yet."]);
    const starting = insertSetup(null);
    await starting.actions.insertSection(starting.editor, "Plan.md");
    expect(starting.prompter.notices).toEqual([
      "Shared Tasks: still starting. Try again in a moment.",
    ]);
  });

  it("a second insert while the insert preview is open brings it forward", async () => {
    const t = insertSetup();
    t.prompter.script.pick = [choice];
    const first = t.actions.insertSection(t.editor, "Plan.md");
    await flush(20);
    await t.actions.insertSection(t.editor, "Plan.md");
    await t.actions.share(t.editor, "Plan.md");
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
    await t.actions.detachSectionAt(t.editor, "Plan.md");
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
    const flow = t.actions.detachSectionAt(t.editor, "Plan.md");
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
    await t.actions.detachSectionAt(t.editor, "Plan.md");
    t.editor.line = 0;
    await t.actions.detachSectionAt(t.editor, "Plan.md");
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
    await t.actions.repairNote(t.editor, "Plan.md");
    expect(t.prompter.dialogs).toEqual([]);
    expect(t.prompter.notices).toEqual(["Shared Tasks: still starting. Try again in a moment."]);
  });

  it("a boundary is placed only on the note it was computed for", async () => {
    const broken = ["## Launch", formatBoundary("start", S), "- [ ] One", "", "## Other", ""].join(
      "\n",
    );
    const t = repairSetup(broken);
    await t.actions.repairNote(t.editor, "Plan.md");
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
    expect(t.editor.cursorLine()).toBe(4);
  });

  it("stale: taking the shared version of a changed note keeps the copy and replaces nothing", async () => {
    const t = repairSetup(LOST);
    await t.actions.repairNote(t.editor, "Plan.md");
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
    await t.actions.repairNote(t.editor, "Plan.md");
    const [, , actions] = opened(t);
    await actions.useShared(KEY);
    expect(t.kept).toHaveLength(1);
    expect(t.notes.files.get("Plan.md")).not.toContain("Draft only here");
    expect(t.calls).toEqual(["pass Plan.md"]);
    expect(await t.bases.projectionsOf("Plan.md")).toEqual([]);
  });

  it("keeping this note's version adopts a base for it, and says so", async () => {
    const t = repairSetup(LOST);
    await t.actions.repairNote(t.editor, "Plan.md");
    const [, , actions] = opened(t);
    await actions.shareMine(KEY);
    expect(await t.bases.projectionsOf("Plan.md")).toHaveLength(1);
    expect(t.notes.writes).toEqual([]);
    expect(t.prompter.notices).toEqual([
      "Shared Tasks: your version of this section is being shared.",
    ]);
  });
});
