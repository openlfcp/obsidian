// LFCP-03-016 (U03-12, U03-13, U03-15): "Insert into a note…" with a chosen
// destination, on the plugin's runtime and the real SDK, offline, through
// the section actions: the note the insert started on (after the paragraph
// at the cursor), another existing note (at its end, closed or open), or a
// new note the user names (created empty, never over a note already
// there). The notes' text, the projection's base and the placement index
// are asserted as they are after each step; renames, deletions and closing
// during the flow; a repeated operation whose result was unknown (D12);
// and the placements a new explicit insertion shows.

import { fromBase64url, type ResourceId, toBase64url } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { ActionDispatcher, coreHandlers } from "../../../src/core/actions/dispatcher";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import type {
  DestinationChoice,
  InsertDestination,
  InsertPlace,
  NoticeAction,
  SectionChoice,
  SectionNotes,
  SectionPrompter,
  SectionServices,
  TextChange,
} from "../../../src/core/sections/action-ports";
import { SectionActions } from "../../../src/core/sections/actions";
import { SectionCreation } from "../../../src/core/sections/create";
import { applyChanges } from "../../../src/core/sections/engine";
import { type InsertionDeps, SectionInsertion } from "../../../src/core/sections/insert";
import { parseSections } from "../../../src/core/sections/parser";
import { noteSections, PlacementIndex } from "../../../src/core/sections/placement-index";
import { preflight, proposeRange } from "../../../src/core/sections/share";
import { KeyValueSectionBaseStore } from "../../../src/core/sections/stores";
import type { TargetCapture } from "../../../src/core/sections/target";
import { newSectionTask } from "../../../src/core/sections/task-fields";
import { Device, FakeLocal } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const SOURCE = ["## Launch", "- [ ] Prepare contract", "", "Draft the plan.", ""].join("\n");
const WEEK = ["# Week", "", "Private intro,", "two lines.", "", "## Later", "Private.", ""].join(
  "\n",
);
const OTHER = ["# Other", "", "Kept as it is.", ""].join("\n");

/** A dialog the test answers. */
class Dialog<T> {
  answered = false;
  forward = 0;
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

class Prompter implements SectionPrompter {
  readonly notices: string[] = [];
  readonly actions = new Map<string, NoticeAction>();
  readonly dialogs: Dialog<unknown>[] = [];
  #open<T>(kind: string, ...args: unknown[]): Dialog<T> {
    const d = new Dialog<T>(kind, args);
    this.dialogs.push(d as Dialog<unknown>);
    return d;
  }
  /** The open dialog of `kind` (the last one). */
  open<T>(kind: string): Dialog<T> {
    const d = this.dialogs.filter((x) => x.kind === kind && !x.answered).at(-1);
    if (d === undefined) throw new Error(`no open ${kind} dialog`);
    return d as Dialog<T>;
  }
  notice(message: string, action?: NoticeAction): void {
    this.notices.push(message);
    if (action !== undefined) this.actions.set(message, action);
  }
  announce(): void {}
  pickSection(choices: readonly SectionChoice[]) {
    return this.#open<SectionChoice | null>("pick", choices);
  }
  insertPreview(preview: unknown, place?: InsertPlace) {
    return this.#open<boolean>("insert", preview, place);
  }
  chooseDestination(choice: DestinationChoice) {
    return this.#open<InsertDestination | null>("destination", choice);
  }
  sharePreview = unused;
  importPreview = unused;
  confirm = unused;
  alias = unused;
  repair = unused;
  review = unused;
  card = unused;
}

function unused(): never {
  throw new Error("not used here");
}

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

const flush = async (times = 40) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A runtime with the section of SOURCE created in Launch.md, and the actions over it. */
async function setup() {
  const r = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(r);
  const status = r.status;
  if (status.kind !== "ready") throw new Error(status.kind);
  const port = new SdkSectionPort({
    profile: (res) => r.sectionProfile(res),
    commit: (res, intents, o) => r.commitSection(res, intents, o),
    storage: r.storage as LfcpStorage,
    canWrite: (res) => r.canWriteSection(res),
  });
  const files = new Map([
    ["Launch.md", SOURCE],
    ["Week.md", WEEK],
    ["Other.md", OTHER],
  ]);
  /** Notes with an editor (Source mode); the others are closed. */
  const open = new Set(["Week.md"]);
  const fail = { afterWrite: false };
  const writes: string[] = [];
  const edit = async (path: string, fn: (current: string) => readonly TextChange[] | null) => {
    const current = files.get(path);
    if (current === undefined) return;
    const changes = fn(current);
    if (changes === null) return;
    files.set(path, applyChanges(current, changes));
    writes.push(`${open.has(path) ? "editor" : "file"} ${path}`);
    if (fail.afterWrite) {
      fail.afterWrite = false;
      throw new Error("crash after the note was written");
    }
  };
  let n = 0;
  const creation = new SectionCreation({
    host: {
      createSectionResource: (o) => r.createSectionResource(o),
      openSection: (R) => r.openSection(R),
      discard: (R) => r.discardUnhosted(R),
      host: async () => ({ kind: "hosted" }),
    },
    port,
    edit,
    journal: r.localState,
    createdBy: status.principalId,
    server: () => URL,
    newResourceId: () => new Uint8Array(32).fill(++n) as ResourceId,
    newNodeId: () => `0192e4a0-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`,
    newOperationId: () => `create-${++n}`,
    newTask: (line, id) => newSectionTask(line, status.principalId, id),
  });
  const range = proposeRange(SOURCE, 0);
  if (range === null) throw new Error("no range");
  const created = await creation.run(
    await creation.prepare("Launch.md", SOURCE, preflight(SOURCE, range)),
  );
  writes.length = 0;
  const R = created.entry.resource;
  const sectionId = created.entry.sectionId;
  const key = `${R}#${sectionId}`;
  const bases = new KeyValueSectionBaseStore(r.localState);
  const deps: InsertionDeps = {
    port,
    bases,
    journal: r.localState,
    loaded: () => true,
    task: (res, taskId) => port.task(res, taskId),
    edit,
    newInsertionId: () => `insert-${++n}`,
  };
  const insertion = new SectionInsertion(deps);
  const index = new PlacementIndex();
  index.begin();
  for (const [path, text] of files) index.index(path, noteSections(parseSections(text)));
  index.end();
  const calls: string[] = [];
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const resource = fromBase64url(R);
  const services = {
    insertion: () => insertion,
    creation: () => null,
    bases: () => bases,
    candidates: () => null,
    model: () => null,
    readOnly: () => false,
    server: () => URL,
    refPlacement: () => "child-line",
    sectionChoices: async () => [{ resource, sectionId, title: "Launch" }],
    onPlacements: (l: () => void) => index.onChange(l),
    placements: (res: Uint8Array) =>
      index.state === "complete" ? index.placements(hex(res)).map((p) => p.path) : null,
    watch: async () => undefined,
    indexed: (path: string, text: string) => index.index(path, noteSections(parseSections(text))),
    pass: (path: string, text?: string) =>
      calls.push(`pass ${path}${text === undefined ? "" : " (file)"}`),
    unavailable: () => null,
  } as unknown as SectionServices;
  const located: [string, number][] = [];
  const notes: SectionNotes = {
    capture: (path) => (open.has(path) ? at(path) : null),
    read: async (path) => files.get(path) ?? null,
    edit,
    goToLine: async (path, line) => {
      located.push([path, line]);
      return files.has(path) ? at(path, line) : null;
    },
    create: async (path) => {
      if (files.has(path)) return "exists";
      files.set(path, "");
      index.index(path, noteSections(parseSections("")));
      return "created";
    },
  };
  const at = (path: string, cursorLine = 2, selections: TargetCapture["selections"] = []) => ({
    path,
    text: files.get(path) ?? "",
    mode: "source" as const,
    cursorLine,
    selections,
    composing: false,
  });
  const prompter = new Prompter();
  const actions = new SectionActions({ prompter, notes, services });
  /** Renames a note as the vault does, its events fed to the actions. */
  const rename = (from: string, to: string) => {
    const text = files.get(from);
    if (text === undefined) return;
    files.delete(from);
    files.set(to, text);
    index.rename(from, to);
    actions.noteRenamed(from, to);
  };
  const remove = (path: string) => {
    files.delete(path);
    index.unindex(path);
    actions.noteDeleted(path);
  };
  /** The copies of the section a note holds. */
  const copies = (path: string) =>
    parseSections(files.get(path) ?? "").sections.filter(
      (s) => toBase64url(s.ref.resourceId) === R && s.ref.sectionId === sectionId,
    );
  /** The projections recorded for a note (their bases), by path. */
  const projected = (path: string) => bases.projectionsOf(path);
  return {
    r,
    R,
    key,
    files,
    open,
    fail,
    writes,
    calls,
    located,
    index,
    prompter,
    actions,
    at,
    rename,
    remove,
    copies,
    projected,
  };
}

type Env = Awaited<ReturnType<typeof setup>>;

/** Starts an insert on Week.md and waits for its preview, the section picked. */
async function startInsert(env: Env, at = env.at("Week.md")) {
  const done = env.actions.insertSection(at);
  await flush();
  env.prompter
    .open<SectionChoice | null>("pick")
    .answer((env.prompter.open("pick").args[0] as SectionChoice[])[0] as SectionChoice);
  await flush();
  const preview = env.prompter.open<boolean>("insert");
  return { done, preview, place: preview.args[1] as InsertPlace };
}

/** Chooses `d` in the place's destination choice. */
async function choose(env: Env, place: InsertPlace, d: InsertDestination) {
  const changing = place.change?.();
  await flush();
  env.prompter.open<InsertDestination | null>("destination").answer(d);
  await changing;
}

describe("Insert into a note… with a destination (LFCP-03-016)", () => {
  it("U03-12: into another existing, closed note: at its end, through its file; the result offers Open", async () => {
    const env = await setup();
    const { done, preview, place } = await startInsert(env);
    expect(place.where).toBe("into this note after the paragraph at the cursor");
    await choose(env, place, { kind: "note", path: "Other.md" });
    expect(place.where).toBe('at the end of "Other"');
    preview.answer(true);
    await done;

    const other = env.files.get("Other.md") as string;
    // The note's own text is kept as it was; the block follows it, set apart.
    expect(other.startsWith(`${OTHER}\n## Launch\n<!-- lfcp-section: `)).toBe(true);
    expect(env.copies("Other.md")).toHaveLength(1);
    expect(env.copies("Other.md")[0]?.nodes.map((x) => x.id)).toEqual(
      env.copies("Launch.md")[0]?.nodes.map((x) => x.id),
    );
    // The note the insert started on is untouched.
    expect(env.files.get("Week.md")).toBe(WEEK);
    expect(env.writes).toEqual(["file Other.md"]);
    // Its projection has a base at its path, and the index lists it.
    expect(await env.projected("Other.md")).toHaveLength(1);
    expect(env.index.placements(hexOf(env.R)).map((p) => p.path)).toEqual([
      "Launch.md",
      "Other.md",
    ]);
    // A closed note is passed through its file (the defect behind this pass is fixed).
    expect(env.calls).toEqual(["pass Other.md (file)"]);
    const text = 'Shared Tasks: section "Launch" inserted into "Other".';
    expect(env.prompter.notices).toEqual([text]);
    env.prompter.actions.get(text)?.run();
    expect(env.located).toEqual([["Other.md", OTHER.split("\n").length]]);
    expect(env.actions.heldNotes()).toBe(0);
  });

  it("U03-12: into this note, the selected private text is kept; an open note is passed in its editor", async () => {
    const env = await setup();
    const selected = env.at("Week.md", 3, [
      { anchor: { line: 2, ch: 0 }, head: { line: 3, ch: 10 } },
    ] as unknown as TargetCapture["selections"]);
    const { done, preview } = await startInsert(env, selected);
    preview.answer(true);
    await done;
    const week = env.files.get("Week.md") as string;
    expect(week).toContain("Private intro,\ntwo lines.\n\n## Launch\n");
    expect(week.endsWith("\n\n## Later\nPrivate.\n")).toBe(true);
    expect(env.writes).toEqual(["editor Week.md"]);
    expect(env.calls).toEqual(["pass Week.md"]);
    expect(env.prompter.notices).toEqual(['Shared Tasks: section "Launch" inserted into "Week".']);
  });

  it("U03-12: into a new note: created empty, then the block; never over a note already there", async () => {
    const env = await setup();
    const { done, preview, place } = await startInsert(env);
    await choose(env, place, { kind: "new", path: "Plans/Fresh.md" });
    expect(place.where).toBe('into a new note "Fresh"');
    preview.answer(true);
    await done;
    const fresh = env.files.get("Plans/Fresh.md") as string;
    expect(fresh.startsWith("## Launch\n<!-- lfcp-section: ")).toBe(true);
    expect(env.copies("Plans/Fresh.md")).toHaveLength(1);
    expect(await env.projected("Plans/Fresh.md")).toHaveLength(1);
    expect(env.files.get("Week.md")).toBe(WEEK);

    // A note made with that name while the preview was open is not overwritten.
    const again = await startInsert(env);
    await choose(env, again.place, { kind: "new", path: "Taken.md" });
    env.files.set("Taken.md", "Someone else's note.\n");
    again.preview.answer(true);
    await again.done;
    expect(env.files.get("Taken.md")).toBe("Someone else's note.\n");
    expect(env.prompter.notices.at(-1)).toBe(
      'Shared Tasks: a note named "Taken" already exists. Nothing was inserted; choose it as an existing note, or another name.',
    );
  });

  it("U03-13: renamed during the flow, the block goes into the renamed note; deleted, nothing is written or recreated", async () => {
    const env = await setup();
    const renamed = await startInsert(env);
    await choose(env, renamed.place, { kind: "note", path: "Other.md" });
    env.rename("Other.md", "Archive/Other.md");
    expect(renamed.place.where).toBe('at the end of "Other"');
    renamed.preview.answer(true);
    await renamed.done;
    expect(env.files.has("Other.md")).toBe(false);
    expect(env.copies("Archive/Other.md")).toHaveLength(1);
    expect(env.prompter.notices.at(-1)).toBe(
      'Shared Tasks: section "Launch" inserted into "Other".',
    );

    const deleted = await startInsert(env);
    await choose(env, deleted.place, { kind: "note", path: "Archive/Other.md" });
    env.remove("Archive/Other.md");
    deleted.preview.answer(true);
    await deleted.done;
    expect(env.files.has("Archive/Other.md")).toBe(false);
    expect(env.prompter.notices.at(-1)).toBe(
      "Shared Tasks: the note was deleted while the preview was open. Nothing was inserted.",
    );
    expect(env.actions.heldNotes()).toBe(0);
  });

  it("U03-13: this note closed during the flow is written through its file and passed there", async () => {
    const env = await setup();
    const { done, preview } = await startInsert(env);
    env.open.delete("Week.md");
    preview.answer(true);
    await done;
    expect(env.writes).toEqual(["file Week.md"]);
    expect(env.calls).toEqual(["pass Week.md (file)"]);
    expect(env.copies("Week.md")).toHaveLength(1);
  });

  it("U03-13: a note whose end is inside an unclosed fence is refused, untouched", async () => {
    const env = await setup();
    const fenced = "# Code\n\n```\nnot closed\n";
    env.files.set("Code.md", fenced);
    const { done, preview, place } = await startInsert(env);
    await choose(env, place, { kind: "note", path: "Code.md" });
    preview.answer(true);
    await done;
    expect(env.files.get("Code.md")).toBe(fenced);
    expect(env.prompter.notices.at(-1)).toBe(
      'Shared Tasks: the end of "Code" is inside a code block or a comment that is not closed. Nothing was inserted; choose another note.',
    );
  });

  it("U03-15 (D12): a write whose result was lost is checked again, never written twice", async () => {
    const env = await setup();
    env.fail.afterWrite = true;
    const first = await startInsert(env);
    await choose(env, first.place, { kind: "note", path: "Other.md" });
    first.preview.answer(true);
    await first.done;
    expect(env.actions.flows()).toMatchObject([
      { kind: "insert", outcome: "unknown", path: "Other.md" },
    ]);
    expect(env.copies("Other.md")).toHaveLength(1);

    // The same operation again into Other.md: the same insertion ID is checked; no second copy.
    const again = await startInsert(env);
    await choose(env, again.place, { kind: "note", path: "Other.md" });
    again.preview.answer(true);
    await again.done;
    await flush();
    expect(env.copies("Other.md")).toHaveLength(1);
    expect(env.writes).toEqual(["file Other.md"]);
    expect(env.actions.flows()).toEqual([]);
    expect(env.prompter.notices.at(-1)).toBe(
      'Shared Tasks: section "Launch" inserted into "Other".',
    );
  });

  it("U03-15: a new explicit insertion shows where the section already is, and makes a second copy", async () => {
    const env = await setup();
    const first = await startInsert(env);
    await choose(env, first.place, { kind: "note", path: "Other.md" });
    first.preview.answer(true);
    await first.done;

    const second = await startInsert(env);
    expect(second.place.placements).toEqual(["Launch.md", "Other.md"]);
    const changing = second.place.change?.();
    await flush();
    const asked = env.prompter.open<InsertDestination | null>("destination");
    expect(asked.args[0]).toEqual({
      title: "Launch",
      current: "Week.md",
      placements: ["Launch.md", "Other.md"],
    });
    asked.answer({ kind: "note", path: "Other.md" });
    await changing;
    second.preview.answer(true);
    await second.done;
    expect(env.copies("Other.md")).toHaveLength(2);
    expect(await env.projected("Other.md")).toHaveLength(2);

    // While the notes are still being read, no placement is claimed.
    env.index.begin();
    const third = await startInsert(env);
    expect(third.place.placements).toBeNull();
    third.preview.answer(false);
    await third.done;
  });

  it("LFCP-03-061: an open preview reads the index again, and is told when it learns a note", async () => {
    const env = await setup();
    env.index.begin();
    const open = await startInsert(env);
    expect(open.place.placements).toBeNull();
    let told = 0;
    const off = open.place.subscribe?.(() => told++);
    // The index finishes: no copy found, and the open preview is told.
    env.index.end();
    expect(open.place.placements).toEqual([]);
    expect(told).toBe(1);
    // A note learned later (a share's write) shows in the same preview.
    env.index.index("Source.md", { copies: [hexOf(env.R)], damaged: [] });
    expect(open.place.placements).toEqual(["Source.md"]);
    expect(told).toBe(2);
    off?.();
    open.preview.answer(false);
    await open.done;
  });

  it("the pane's joined section needs no choice: Insert into a note… previews it at once", async () => {
    const env = await setup();
    const dispatcher = new ActionDispatcher(
      coreHandlers({
        sections: () => env.actions,
        collab: {
          joinCollaboration: async () => undefined,
          inviteCollaborator: async () => undefined,
          inviteTo: async () => undefined,
          resourceStatus: async () => undefined,
        },
      }),
    );
    const done = dispatcher.run(
      "insert-into-note",
      { target: env.at("Week.md"), section: { key: env.key, title: "Launch" } },
      "pane",
    );
    await flush();
    expect(env.prompter.dialogs.map((d) => d.kind)).toEqual(["insert"]);
    env.prompter.open<boolean>("insert").answer(false);
    await done;
    expect(env.files.get("Week.md")).toBe(WEEK);
  });

  it("obsidian#30: a pane row keyed by its Resource (model not read yet) resolves to its one section, no picker", async () => {
    const env = await setup();
    const placed: string[] = [];
    const dispatcher = new ActionDispatcher(
      coreHandlers({
        sections: () => env.actions,
        collab: {
          joinCollaboration: async () => undefined,
          inviteCollaborator: async () => undefined,
          inviteTo: async () => undefined,
          resourceStatus: async () => undefined,
          joinPlaced: (r) => placed.push(toBase64url(r)),
        },
      }),
    );
    // host-facts rowFocus: `row.key ?? row.resource`, the Resource alone before the model names the section.
    const done = dispatcher.run(
      "insert-into-note",
      { target: env.at("Week.md"), section: { key: env.R, title: "Launch" } },
      "pane",
    );
    await flush();
    expect(env.prompter.dialogs.map((d) => d.kind)).toEqual(["insert"]);
    env.prompter.open<boolean>("insert").answer(true);
    await done;
    expect(env.copies("Week.md")).toHaveLength(1);
    // The join flow it ends is that Resource's (the full key's Resource, not a cut one).
    expect(placed).toEqual([env.R]);
  });

  it("U03-07 (LFCP-03-023): Insert from the pane, then from the palette and the menu on that note: one preview, one copy", async () => {
    const env = await setup();
    const dispatcher = new ActionDispatcher(
      coreHandlers({
        sections: () => env.actions,
        collab: {
          joinCollaboration: async () => undefined,
          inviteCollaborator: async () => undefined,
          inviteTo: async () => undefined,
          resourceStatus: async () => undefined,
        },
      }),
    );
    const pane = dispatcher.run(
      "insert-into-note",
      { target: env.at("Week.md"), section: { key: env.key, title: "Launch" } },
      "pane",
    );
    await flush();
    const preview = env.prompter.open<boolean>("insert");
    // The palette's command and the menu's item on the same note bring the open preview forward.
    await dispatcher.run("insert-into-note", { target: env.at("Week.md") }, "palette");
    await dispatcher.run("insert-into-note", { target: env.at("Week.md") }, "menu");
    await flush();
    expect(env.prompter.dialogs.map((d) => d.kind)).toEqual(["insert"]);
    expect(preview.forward).toBe(2);
    preview.answer(true);
    await pane;
    expect(env.copies("Week.md")).toHaveLength(1);
    expect(env.actions.flows()).toEqual([]);
  });

  it("a key naming no section of this device still asks which one", async () => {
    const env = await setup();
    const other = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    for (const key of [other, `${env.R}#another-section`]) {
      const done = env.actions.insertSection(env.at("Week.md"), key);
      await flush();
      expect(env.prompter.open("pick")).toBeDefined();
      env.prompter.open<SectionChoice | null>("pick").answer(null);
      await done;
    }
    expect(env.files.get("Week.md")).toBe(WEEK);
  });
});

const hexOf = (b64: string) =>
  [...fromBase64url(b64)].map((x) => x.toString(16).padStart(2, "0")).join("");
