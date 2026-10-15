// LFCP-03-018 (U03-16, F-04), live: a held edit after a repair, as the peer
// sees it. A's copy loses its end marker and A edits a Task in it: the copy
// is held (a damaged boundary), and the peer does not get the edit. The
// pane's repair row (its line key and the note's revision) opens the
// repair through the executor; the boundary the user picks is written at
// the held note's path; the next pass sends what was held, and the peer's
// note shows it. Nothing is assumed: the outcome is read on the peer.
// Reference server at LFCP_SERVER_BIN; skipped without one.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { contentHash } from "../../../src/core/projection/guard";
import type {
  RepairActions,
  SectionDialog,
  SectionNotes,
  SectionPrompter,
  SectionServices,
  TextChange,
} from "../../../src/core/sections/action-ports";
import { SectionActions } from "../../../src/core/sections/actions";
import { applyChanges } from "../../../src/core/sections/engine";
import { keyedRepairs, type RepairItem } from "../../../src/core/sections/repair";
import {
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import type { TargetCapture } from "../../../src/core/sections/target";
import { type Peer, peer, waitFor } from "../../native/peer/main";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

const skip = liveSkipReason();
let server: LiveServer;
beforeAll(async () => {
  if (skip === null) server = await startLiveServer();
}, 30_000);
afterAll(async () => {
  await server?.stop();
});
const stopping: Peer[] = [];
afterEach(async () => {
  for (const p of stopping.splice(0)) await p.stop();
});

const NOTE = ["## Plan", "", "- [ ] Alpha", "- [ ] Beta", "", "## Later", ""].join("\n");

/** The executor on a headless peer: its notes in memory, its stores, a recording repair dialog. */
function executor(p: Peer) {
  const notices: string[] = [];
  const repairs: { items: readonly RepairItem[]; actions: RepairActions }[] = [];
  const unexpected = (name: string) => () => {
    throw new Error(`unexpected ${name}`);
  };
  const prompter = {
    notice: (m: string) => notices.push(m),
    announce: () => undefined,
    repair: (items: readonly RepairItem[], _lost: unknown, actions: RepairActions) => {
      repairs.push({ items, actions });
      return { result: new Promise<void>(() => undefined), bringForward: () => undefined };
    },
    sharePreview: unexpected("sharePreview"),
    importPreview: unexpected("importPreview"),
    pickSection: unexpected("pickSection"),
    insertPreview: unexpected("insertPreview"),
    confirm: unexpected("confirm"),
    alias: unexpected("alias"),
    review: unexpected("review"),
    card: unexpected("card"),
  } as unknown as SectionPrompter;
  const at = (path: string, line: number): TargetCapture | null => {
    const text = p.files.get(path);
    return text === undefined
      ? null
      : { path, text, mode: "source", cursorLine: line, selections: [], composing: false };
  };
  const notes: SectionNotes = {
    capture: () => null,
    read: async (path) => p.files.get(path) ?? null,
    edit: async (path, fn: (current: string) => readonly TextChange[] | null) => {
      const current = p.files.get(path);
      if (current === undefined) return;
      const changes = fn(current);
      if (changes !== null) p.files.set(path, applyChanges(current, changes));
    },
    goToLine: async (path, line) => at(path, line),
  };
  const passed: string[] = [];
  const services = {
    model: () => ({
      snapshot: (r: string, s: string) => p.port.snapshot(r, s),
      task: (r: string, id: string) => p.port.task(r, id),
    }),
    bases: () => new KeyValueSectionBaseStore(p.runtime.localState),
    candidates: () => new KeyValueSectionJournalStore(p.runtime.localState),
    unavailable: () => null,
    readOnly: () => false,
    server: () => server.url,
    refPlacement: () => "child-line",
    pass: (path: string) => passed.push(path),
  } as unknown as SectionServices;
  const actions = new SectionActions({ prompter, notes, services });
  return { actions, notices, repairs, passed };
}

describe.skipIf(skip !== null)("a held edit after a repair (U03-16)", () => {
  it("is held while the boundary is damaged; repaired from its problem row, the peer gets it", async () => {
    const a = await peer(server.url);
    stopping.push(a);
    a.files.set("A.md", NOTE);
    const { resource } = await a.share("A.md", "## Plan");
    // As the plugin does after a share: a pass seeds the copy's base.
    await a.pass("A.md");
    const b = await peer(server.url);
    stopping.push(b);
    b.files.set("B.md", ["# B", "", "Insert below.", ""].join("\n"));
    await b.joinAndInsert((await a.collab.invite(resource, "read-write")).link.reveal(), "B.md", 3);
    await waitFor(async () =>
      (b.files.get("B.md") as string).includes("Beta") ? true : undefined,
    );

    // A's end marker is lost, and A edits a Task inside the copy: the copy is held.
    const shared = a.files.get("A.md") as string;
    const lines = shared.split("\n");
    const end = lines.findIndex((l) => l.startsWith("<!-- /lfcp-section: "));
    expect(end).toBeGreaterThan(0);
    const damaged = lines
      .filter((_, i) => i !== end)
      .join("\n")
      .replace("- [ ] Alpha", "- [ ] Alpha edited while damaged");
    a.files.set("A.md", damaged);
    // The pass finds no section to send: the copy's boundary is damaged.
    expect((await a.pass("A.md")).pass.sections).toEqual([]);
    // The peer does not get it while the boundary is damaged.
    await new Promise((r) => setTimeout(r, 3000));
    await b.pass("B.md");
    expect(b.files.get("B.md")).not.toContain("Alpha edited while damaged");

    // The pane's repair row: its line key and the revision the pane read.
    const now = a.files.get("A.md") as string;
    const row = keyedRepairs(now).find((k) => k.item.kind === "missing-end");
    if (row === undefined) throw new Error(`no missing end in:\n${now}`);
    const x = executor(a);
    await x.actions.repairProblem({
      path: "A.md",
      key: row.key,
      line: row.item.line,
      revision: contentHash(now),
    });
    expect(x.notices).toEqual([]);
    const [opened] = x.repairs;
    const item = opened?.items[0];
    if (item?.kind !== "missing-end") throw new Error(`repair opened on ${item?.kind}`);
    // The user picks the line after the last Task (before "## Later").
    const after = item.candidates.filter((c) => c.afterLine < now.split("\n").indexOf("## Later"));
    const pick = after[after.length - 1];
    if (pick === undefined) throw new Error("no candidate");
    await opened?.actions.boundary(item, pick.afterLine);
    expect(x.passed).toEqual(["A.md"]);
    const repaired = a.files.get("A.md") as string;
    expect(keyedRepairs(repaired)).toEqual([]);

    // The facts after the repair: A's next pass has the section, not skipped; the peer gets the edit.
    const { pass } = await a.pass("A.md");
    expect(pass.sections).toHaveLength(1);
    expect(pass.sections[0]?.skipped).toBeUndefined();
    expect(pass.sections[0]?.held).toEqual([]);
    await waitFor(async () => {
      await b.pass("B.md");
      return (b.files.get("B.md") as string).includes("Alpha edited while damaged")
        ? true
        : undefined;
    }, 30_000);
  }, 120_000);
});
