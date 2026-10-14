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
  SectionEditor,
  SectionNotes,
  SectionPrompter,
  SectionServices,
  TextChange,
} from "../../../src/core/sections/action-ports";
import { SectionActions } from "../../../src/core/sections/actions";
import type { CreationEntry, CreationResult } from "../../../src/core/sections/create";
import { applyChanges } from "../../../src/core/sections/engine";
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
    await t.actions.reserve("Plan.md", "insert", async () => {
      throw new Error("must not run");
    });
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
