// LFCP-03-017 (U03-13, U03-14): an insertion a restart interrupted, on the
// plugin's runtime and the real SDK, offline, through the section actions.
// A restart here is new SectionActions and a new SectionInsertion over the
// same local store and the same notes: the flows in memory are gone, the
// insertion journal is what is left. Each crash point gives one result:
//
//   journaled, nothing written     listed as unfinished on its note; Continue
//                                  shows the same preview; approved, the same
//                                  insertion writes one block; cancelled,
//                                  nothing is written and it ends
//   written, not registered        the copy is registered, no second block
//   note gone                      nothing written; the insertion ends
//
// A later explicit insert is a new insertion, with a block of its own.

import { fromBase64url, type ResourceId, toBase64url } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import type {
  DestinationChoice,
  InsertDestination,
  InsertPlace,
  SectionChoice,
  SectionNotes,
  SectionPrompter,
  SectionServices,
  TextChange,
} from "../../../src/core/sections/action-ports";
import { SectionActions } from "../../../src/core/sections/actions";
import { SectionCreation } from "../../../src/core/sections/create";
import { applyChanges } from "../../../src/core/sections/engine";
import { type InsertPreview, SectionInsertion } from "../../../src/core/sections/insert";
import { parseSections } from "../../../src/core/sections/parser";
import { preflight, proposeRange } from "../../../src/core/sections/share";
import { KeyValueSectionBaseStore } from "../../../src/core/sections/stores";
import { newSectionTask } from "../../../src/core/sections/task-fields";
import { Device, FakeLocal } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const SOURCE = ["## Launch", "- [ ] Prepare contract", "", "Draft the plan.", ""].join("\n");
const WEEK = ["# Week", "", "Private intro,", "two lines.", "", "## Later", "Private.", ""].join(
  "\n",
);

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
  readonly dialogs: Dialog<unknown>[] = [];
  #open<T>(kind: string, ...args: unknown[]): Dialog<T> {
    const d = new Dialog<T>(kind, args);
    this.dialogs.push(d as Dialog<unknown>);
    return d;
  }
  open<T>(kind: string): Dialog<T> {
    const d = this.dialogs.filter((x) => x.kind === kind && !x.answered).at(-1);
    if (d === undefined) throw new Error(`no open ${kind} dialog`);
    return d as Dialog<T>;
  }
  opened(kind: string): number {
    return this.dialogs.filter((x) => x.kind === kind).length;
  }
  notice(message: string): void {
    this.notices.push(message);
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

/** A runtime with a section of SOURCE created; `boot()` gives the actions of one start. */
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
  ]);
  /** Fails the next note write: before it is applied, or after. */
  const fail = { before: false, after: false };
  let writes = 0;
  const edit = async (path: string, fn: (current: string) => readonly TextChange[] | null) => {
    const current = files.get(path);
    if (current === undefined) return;
    const changes = fn(current);
    if (changes === null) return;
    if (fail.before) {
      fail.before = false;
      throw new Error("crash before the note was written");
    }
    files.set(path, applyChanges(current, changes));
    writes++;
    if (fail.after) {
      fail.after = false;
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
  writes = 0;
  const R = created.entry.resource;
  const sectionId = created.entry.sectionId;
  const bases = new KeyValueSectionBaseStore(r.localState);
  const resource = fromBase64url(R);
  const at = (path: string, cursorLine = 2) => ({
    path,
    text: files.get(path) ?? "",
    mode: "source" as const,
    cursorLine,
    selections: [],
    composing: false,
  });
  /** One start of the plugin: its own insertion journal reader and actions, nothing in memory. */
  const boot = () => {
    const insertion = new SectionInsertion({
      port,
      bases,
      journal: r.localState,
      loaded: () => true,
      task: (res, taskId) => port.task(res, taskId),
      edit,
      newInsertionId: () => `insert-${++n}`,
    });
    const passes: string[] = [];
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
      placements: () => [],
      watch: async () => undefined,
      indexed: () => undefined,
      pass: (path: string) => passes.push(path),
      unavailable: () => null,
    } as unknown as SectionServices;
    const notes: SectionNotes = {
      capture: () => null,
      read: async (path) => files.get(path) ?? null,
      edit,
      goToLine: async (path, line) => (files.has(path) ? at(path, line) : null),
    };
    const prompter = new Prompter();
    const actions = new SectionActions({ prompter, notes, services });
    return { insertion, actions, prompter, passes };
  };
  /** The copies of the section a note holds. */
  const copies = (path: string) =>
    parseSections(files.get(path) ?? "").sections.filter(
      (s) => toBase64url(s.ref.resourceId) === R && s.ref.sectionId === sectionId,
    );
  return {
    files,
    fail,
    writes: () => writes,
    at,
    boot,
    copies,
    projected: (path: string) => bases.projectionsOf(path),
  };
}

type Env = Awaited<ReturnType<typeof setup>>;
type Start = ReturnType<Env["boot"]>;

/** An insert into Week.md at its cursor, picked and approved; settles when its flow body returns. */
async function insert(start: Start, env: Env): Promise<void> {
  const done = start.actions.insertSection(env.at("Week.md"));
  await flush();
  const pick = start.prompter.open<SectionChoice | null>("pick");
  pick.answer((pick.args[0] as SectionChoice[])[0] as SectionChoice);
  await flush();
  start.prompter.open<boolean>("insert").answer(true);
  await done;
  await flush();
}

/** A restart: a new start, every unfinished insertion resumed as the host does it. */
async function restart(env: Env): Promise<Start> {
  const next = env.boot();
  for (const e of await next.insertion.unfinished()) await next.actions.resumeInsertion(e);
  await flush();
  return next;
}

describe("an insertion a restart interrupted (LFCP-03-017)", () => {
  it("journaled, nothing written: unfinished on its note; Continue previews it again and writes it once", async () => {
    const env = await setup();
    const first = env.boot();
    env.fail.before = true;
    await insert(first, env);
    // In this session: the result is unknown, the note reserved (D12).
    expect(first.actions.flows()).toEqual([
      expect.objectContaining({ kind: "insert", path: "Week.md", outcome: "unknown" }),
    ]);
    expect(env.copies("Week.md")).toHaveLength(0);

    const next = await restart(env);
    // Nothing written: listed as unfinished on its note, nothing asked yet, nothing written.
    const [flow] = next.actions.flows();
    expect(flow).toMatchObject({
      kind: "insert",
      path: "Week.md",
      step: "writing",
      outcome: "unfinished",
    });
    expect(next.prompter.dialogs).toEqual([]);
    expect(env.writes()).toBe(0);
    expect(await next.insertion.unfinished()).toHaveLength(1);

    // A new insert on that note opens nothing new: it continues the same insertion.
    const again = next.actions.insertSection(env.at("Week.md"));
    await flush();
    expect(next.prompter.opened("pick")).toBe(0);
    const preview = next.prompter.open<boolean>("insert");
    const place = preview.args[1] as InsertPlace;
    expect(place.where).toBe('into "Week", where it was chosen before');
    expect(place.change).toBeUndefined();
    expect((preview.args[0] as InsertPreview).title).toBe("Launch");
    // While its preview is open, it runs again (the pane's next step goes back to it).
    expect(next.actions.flows()[0]?.outcome).toBe("running");
    preview.answer(true);
    await again;
    await flush();

    expect(env.copies("Week.md")).toHaveLength(1);
    expect(env.writes()).toBe(1);
    expect(env.files.get("Week.md")).toContain("Private intro,");
    expect(await env.projected("Week.md")).toHaveLength(1);
    expect(await next.insertion.unfinished()).toEqual([]);
    expect(next.actions.flows()).toEqual([]);
    expect(next.prompter.notices.at(-1)).toBe(
      'Shared Tasks: section "Launch" inserted into "Week".',
    );

    // Another restart: nothing left to resume. A later explicit insert is a new one.
    const third = await restart(env);
    expect(third.actions.flows()).toEqual([]);
    await insert(third, env);
    expect(env.copies("Week.md")).toHaveLength(2);
    expect(await env.projected("Week.md")).toHaveLength(2);
  });

  it("written, not registered: the restart registers the copy and writes no second block", async () => {
    const env = await setup();
    const first = env.boot();
    env.fail.after = true;
    await insert(first, env);
    expect(env.copies("Week.md")).toHaveLength(1);
    expect(await env.projected("Week.md")).toEqual([]);
    expect(first.actions.flows()[0]?.outcome).toBe("unknown");

    const next = await restart(env);
    expect(env.copies("Week.md")).toHaveLength(1);
    expect(env.writes()).toBe(1);
    expect(await env.projected("Week.md")).toHaveLength(1);
    expect(await next.insertion.unfinished()).toEqual([]);
    expect(next.actions.flows()).toEqual([]);
    expect(next.prompter.dialogs).toEqual([]);
    expect(next.passes).toEqual(["Week.md"]);
    expect(next.prompter.notices).toEqual([
      'Shared Tasks: section "Launch" inserted into "Week". Inserting had not finished before.',
    ]);
  });

  it("Continue, then Cancel: nothing written, the insertion ends; the next start has nothing to resume", async () => {
    const env = await setup();
    const first = env.boot();
    env.fail.before = true;
    await insert(first, env);
    const next = await restart(env);
    const flow = next.actions.flows()[0];
    const going = next.actions.continueFlow(flow?.generation ?? -1);
    await flush();
    next.prompter.open<boolean>("insert").answer(false);
    expect(await going).toBe(true);
    await flush();
    expect(env.writes()).toBe(0);
    expect(env.copies("Week.md")).toHaveLength(0);
    expect(next.actions.flows()).toEqual([]);
    expect(next.prompter.notices.at(-1)).toBe(
      'Shared Tasks: section "Launch" was not inserted. Nothing was written.',
    );
    expect(await next.insertion.unfinished()).toEqual([]);
    expect((await restart(env)).actions.flows()).toEqual([]);
  });

  it("its note gone: nothing written, the insertion ends and says so", async () => {
    const env = await setup();
    const first = env.boot();
    env.fail.before = true;
    await insert(first, env);
    env.files.delete("Week.md");
    const next = await restart(env);
    expect(next.actions.flows()).toEqual([]);
    expect(await next.insertion.unfinished()).toEqual([]);
    expect(next.prompter.notices).toEqual([
      'Shared Tasks: inserting section "Launch" into "Week" had not finished, and the note is no longer there. Nothing was inserted.',
    ]);
  });

  it("its place changed while Obsidian was closed: Continue writes nothing there and ends", async () => {
    const env = await setup();
    const first = env.boot();
    env.fail.before = true;
    await insert(first, env);
    // The anchor line is gone.
    env.files.set("Week.md", ["# Week", "", "Rewritten.", ""].join("\n"));
    const next = await restart(env);
    expect(next.actions.flows()[0]?.outcome).toBe("unfinished");
    const going = next.actions.continueFlow(next.actions.flows()[0]?.generation ?? -1);
    await flush();
    next.prompter.open<boolean>("insert").answer(true);
    await going;
    await flush();
    expect(env.copies("Week.md")).toHaveLength(0);
    expect(next.prompter.notices.at(-1)).toBe(
      "Shared Tasks: the note changed where the section would go. Insert it again.",
    );
    expect(await next.insertion.unfinished()).toEqual([]);
    expect(next.actions.flows()).toEqual([]);
  });

  it("a write that fails again on Continue leaves the result unknown, then checks the same insertion", async () => {
    const env = await setup();
    const first = env.boot();
    env.fail.before = true;
    await insert(first, env);
    const next = await restart(env);
    const generation = next.actions.flows()[0]?.generation ?? -1;
    env.fail.after = true;
    const going = next.actions.continueFlow(generation);
    await flush();
    next.prompter.open<boolean>("insert").answer(true);
    await going;
    await flush();
    expect(next.actions.flows()[0]).toMatchObject({ generation, outcome: "unknown" });
    expect(env.copies("Week.md")).toHaveLength(1);
    // Check the result: the same insertion finds its block, writes nothing more.
    expect(await next.actions.checkResult(generation)).toBe(true);
    await flush();
    expect(env.copies("Week.md")).toHaveLength(1);
    expect(env.writes()).toBe(1);
    expect(await env.projected("Week.md")).toHaveLength(1);
    expect(next.actions.flows()).toEqual([]);
    expect(await next.insertion.unfinished()).toEqual([]);
  });
});
