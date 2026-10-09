// LFCP-02-052: inserting a loaded shared section into a note, on the
// plugin's runtime and the real SDK, offline: one complete projection at a
// block boundary, nothing published, a retry that finds its own block, a
// deliberate second projection, a changed target note, read-only, cancel.

import { fromBase64url, type ResourceId, toBase64url } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { splitLines } from "../../../src/core/refs/lines";
import { SectionCreation } from "../../../src/core/sections/create";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import {
  type InsertionDeps,
  type InsertPreview,
  insertionLine,
  SectionInsertion,
} from "../../../src/core/sections/insert";
import { parseSections } from "../../../src/core/sections/parser";
import { preflight, proposeRange } from "../../../src/core/sections/share";
import {
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { newSectionTask } from "../../../src/core/sections/task-fields";
import { Device, FakeLocal } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const SOURCE = [
  "## Launch",
  "- [ ] Prepare contract",
  "  - [ ] Legal review",
  "",
  "Draft the plan.",
  "",
  "- Venue",
  "",
].join("\n");
const TARGET = ["# Week", "", "Private intro,", "two lines.", "", "## Later", "Private.", ""].join(
  "\n",
);

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

/** A runtime with the section of SOURCE created in it, and an insertion over it. */
async function setup() {
  const r = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(r);
  const status = r.status;
  if (status.kind !== "ready") throw new Error(status.kind);
  let writable = true;
  const port = new SdkSectionPort({
    profile: (res) => r.sectionProfile(res),
    commit: (res, intents, o) => r.commitSection(res, intents, o),
    storage: r.storage as LfcpStorage,
    canWrite: async (res) =>
      writable
        ? r.canWriteSection(res)
        : { allowed: false, reason: "read-only", controlHead: null, verifiedAt: null },
  });
  const files = new Map([
    ["Launch.md", SOURCE],
    ["Week.md", TARGET],
  ]);
  const fail = { edit: false };
  const edit: InsertionDeps["edit"] = async (path, fn) => {
    const current = files.get(path);
    if (current === undefined) return;
    const changes = fn(current);
    if (changes === null) return;
    files.set(path, applyChanges(current, changes));
    if (fail.edit) throw new Error("crash after the note was written");
  };
  let n = 0;
  const newNodeId = () => `0192e4a0-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`;
  const newTask = (line: string, id: string) => newSectionTask(line, status.principalId, id);
  const creation = new SectionCreation({
    host: {
      createSectionResource: (o) => r.createSectionResource(o),
      openSection: (R) => r.openSection(R),
      host: async () => ({ kind: "hosted" }),
    },
    port,
    edit,
    journal: r.localState,
    createdBy: status.principalId,
    server: () => URL,
    newResourceId: () => new Uint8Array(32).fill(++n) as ResourceId,
    newNodeId,
    newOperationId: () => `create-${++n}`,
    newTask,
  });
  const range = proposeRange(SOURCE, 0);
  if (range === null) throw new Error("no range");
  const created = await creation.run(
    await creation.prepare("Launch.md", SOURCE, preflight(SOURCE, range)),
  );
  const R = created.entry.resource;
  const sectionId = created.entry.sectionId;
  const bases = new KeyValueSectionBaseStore(r.localState);
  let loaded = true;
  const deps: InsertionDeps = {
    port,
    bases,
    journal: r.localState,
    loaded: () => loaded,
    task: (res, taskId) => port.task(res, taskId),
    edit,
    newInsertionId: () => `insert-${++n}`,
  };
  const engine = new SectionEngine({
    port,
    journal: new KeyValueSectionJournalStore(r.localState),
    bases,
    newNodeId,
    newOperationId: () => `op-${++n}`,
    createdBy: status.principalId,
    newProjectionId: () => `projection-${++n}`,
    tasks: () => undefined,
    newTask,
  });
  const outbound = async () => (await r.storage?.outbound.list(resourceOf(R)))?.length ?? 0;
  return {
    r,
    R,
    sectionId,
    files,
    fail,
    deps,
    engine,
    outbound,
    setWritable: (w: boolean) => {
      writable = w;
    },
    setLoaded: (l: boolean) => {
      loaded = l;
    },
  };
}

const resourceOf = (b64: string) => fromBase64url(b64) as ResourceId;

const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };

describe("the insertion line", () => {
  it("is the start of a top-level block outside sections, fences and lists", () => {
    // On a paragraph: after it, before the next block.
    expect(insertionLine(TARGET, 2)).toBe(5);
    expect(insertionLine(TARGET, 3)).toBe(5);
    // On a blank line: the block that follows.
    expect(insertionLine(TARGET, 1)).toBe(2);
    // After a heading, even without a blank line.
    expect(insertionLine("Text\n## Next\n", 0)).toBe(1);
    // A list item's continuation after a blank line belongs to the item.
    expect(insertionLine("- one\n\n  more\n\nText\n", 0)).toBe(4);
    // A fence is passed whole.
    expect(insertionLine("```\na\n\nb\n```\n\nAfter\n", 2)).toBe(6);
    // A section is passed whole.
    const S =
      "lfcp1:yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE#section:0192e4a0-0000-7000-8000-000000000001";
    expect(
      insertionLine(
        `## A\n<!-- lfcp-section: ${S} -->\n\nx\n<!-- /lfcp-section: ${S} -->\n\nEnd\n`,
        0,
      ),
    ).toBe(6);
    // The end of the note.
    expect(insertionLine("Only\nline\n", 1)).toBe(splitLines("Only\nline\n").length);
  });
});

describe("inserting a shared section", () => {
  it("writes one complete projection at a block boundary and publishes nothing", async () => {
    const env = await setup();
    const insertion = new SectionInsertion(env.deps);
    const preview = (await insertion.preview(resourceOf(env.R), env.sectionId)) as InsertPreview;
    expect(preview.block).toContain("- [ ] Prepare contract");
    expect(preview.block).toContain("Draft the plan.");
    expect(preview.readOnly).toBe(false);
    const queued = await env.outbound();
    const entry = await insertion.prepare("Week.md", TARGET, 2, preview);
    const out = await insertion.run(entry);
    expect(out.kind).toBe("inserted");
    const md = env.files.get("Week.md") as string;
    // Before "## Later", after the private paragraph, set apart by blank lines.
    expect(
      md.startsWith("# Week\n\nPrivate intro,\ntwo lines.\n\n## Launch\n<!-- lfcp-section: "),
    ).toBe(true);
    expect(md.endsWith(`\n\n## Later\nPrivate.\n`)).toBe(true);
    expect(md).toContain(preview.block);
    // The same nodes, bound to the same IDs as the creator's note.
    const launch = parseSections(env.files.get("Launch.md") as string).sections[0];
    const week = parseSections(md).sections[0];
    expect(week?.nodes.map((x) => x.id)).toEqual(launch?.nodes.map((x) => x.id));
    expect(week?.nodes[0]?.children.map((x) => x.id)).toEqual(
      launch?.nodes[0]?.children.map((x) => x.id),
    );
    // The engine takes it as it is: its base is the model; nothing to send.
    expect(await env.deps.bases.projectionsOf("Week.md")).toEqual([entry.insertionId]);
    const pass = await env.engine.pass("Week.md", md, ctx);
    expect(applyChanges(md, pass.changes)).toBe(md);
    expect(pass.sections.flatMap((s) => s.entries)).toEqual([]);
    expect(await env.outbound()).toBe(queued);
    expect(await insertion.unfinished()).toEqual([]);
  });

  it("is refused while the section imports or is not fully loaded", async () => {
    const env = await setup();
    const insertion = new SectionInsertion(env.deps);
    env.setLoaded(false);
    expect(await insertion.preview(resourceOf(env.R), env.sectionId)).toEqual({
      refused: "not-loaded",
    });
    expect(
      await insertion.preview(resourceOf(env.R), "0192e4a0-0000-7000-8000-0000000000ff"),
    ).toEqual({
      refused: "not-loaded",
    });
    // A section without `ready` (SSP §12.1).
    const status = env.r.status;
    if (status.kind !== "ready") throw new Error(status.kind);
    const R = await env.r.createSectionResource({
      name: "Draft",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await env.r.openSection(R);
    const S = "0192e4a0-0000-7000-8000-0000000000aa";
    await env.r.commitSection(
      R,
      [
        {
          intent: "section.create",
          sectionId: S,
          title: "Draft",
          createdBy: status.principalId,
          ready: false,
        },
      ],
      { operationId: "importing" },
    );
    env.setLoaded(true);
    expect(await insertion.preview(R, S)).toEqual({ refused: "importing" });
  });

  it("a retry after a crash finds its block; a deliberate second insertion is a second projection", async () => {
    const env = await setup();
    const insertion = new SectionInsertion(env.deps);
    const preview = (await insertion.preview(resourceOf(env.R), env.sectionId)) as InsertPreview;
    const entry = await insertion.prepare("Week.md", TARGET, 0, preview);
    env.fail.edit = true;
    await expect(insertion.run(entry)).rejects.toThrow("crash after the note was written");
    env.fail.edit = false;
    const [again] = await new SectionInsertion(env.deps).unfinished();
    expect(again?.insertionId).toBe(entry.insertionId);
    expect((await insertion.run(again ?? entry)).kind).toBe("inserted");
    let md = env.files.get("Week.md") as string;
    expect(parseSections(md).sections).toHaveLength(1);
    expect(await env.deps.bases.projectionsOf("Week.md")).toEqual([entry.insertionId]);

    const second = await insertion.prepare("Week.md", md, 0, preview);
    expect(second.insertionId).not.toBe(entry.insertionId);
    expect((await insertion.run(second)).kind).toBe("inserted");
    md = env.files.get("Week.md") as string;
    expect(parseSections(md).sections).toHaveLength(2);
    expect(await env.deps.bases.projectionsOf("Week.md")).toHaveLength(2);
  });

  it("a changed target note: the same anchor still takes it; a removed anchor waits for a new choice", async () => {
    const env = await setup();
    const insertion = new SectionInsertion(env.deps);
    const preview = (await insertion.preview(resourceOf(env.R), env.sectionId)) as InsertPreview;
    const moved = await insertion.prepare("Week.md", TARGET, 2, preview);
    env.files.set("Week.md", `New line.\n\n${TARGET}`);
    expect((await insertion.run(moved)).kind).toBe("inserted");
    expect(env.files.get("Week.md")).toContain("two lines.\n\n## Launch\n");

    env.files.set("Week.md", TARGET);
    await env.deps.bases.save(moved.insertionId, null);
    const gone = await insertion.prepare("Week.md", TARGET, 2, preview);
    const changed = TARGET.replace("## Later", "## Renamed");
    env.files.set("Week.md", changed);
    expect((await insertion.run(gone)).kind).toBe("stale");
    expect(env.files.get("Week.md")).toBe(changed);
  });

  it("a read-only section is inserted and says so; cancel writes nothing", async () => {
    const env = await setup();
    const insertion = new SectionInsertion(env.deps);
    env.setWritable(false);
    const preview = (await insertion.preview(resourceOf(env.R), env.sectionId)) as InsertPreview;
    expect(preview.readOnly).toBe(true);
    const entry = await insertion.prepare("Week.md", TARGET, 0, preview);
    const cancelled = await insertion.cancel(entry);
    expect((await insertion.run(cancelled)).kind).toBe("cancelled");
    expect(env.files.get("Week.md")).toBe(TARGET);
    expect(await insertion.unfinished()).toEqual([]);
    const again = await insertion.prepare("Week.md", TARGET, 0, preview);
    expect((await insertion.run(again)).kind).toBe("inserted");
    expect(toBase64url(resourceOf(env.R))).toBe(env.R);
  });
});
