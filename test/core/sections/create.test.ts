// LFCP-02-050: creating a shared section from an approved preview, journaled
// (SDK-SECTIONS-INTEGRATION-01 §3.1, SSP §12), on the plugin's runtime and
// the real SDK, offline. A crash or a lost answer at every phase resumes from
// the journal with the same Resource, IDs and operation; an edit of the range
// since the preview stops before the note is bound.

import type { ResourceId } from "@openlfcp/core";
import { toBase64url } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import {
  type CreationDeps,
  type CreationHost,
  type HostResult,
  SectionCreation,
} from "../../../src/core/sections/create";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import { parseSections } from "../../../src/core/sections/parser";
import { CommitRefused, type SectionPort } from "../../../src/core/sections/port";
import { preflight, proposeRange } from "../../../src/core/sections/share";
import {
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { newSectionTask } from "../../../src/core/sections/task-fields";
import { Device, FakeLocal } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const BEFORE = "PRIVATE_BEFORE_8f3a: budget.";
const AFTER = "PRIVATE_AFTER_71c2: do not transmit.";
const NOTE = [
  BEFORE,
  "",
  "## Launch",
  "- [ ] Prepare contract",
  "  - [ ] Legal review",
  "",
  "Draft the plan.",
  "",
  "- Venue",
  "",
  "## Other",
  AFTER,
  "",
].join("\n");

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

/** One runtime, one note, and the creation's dependencies with hooks to fail a step. */
async function setup(note = NOTE) {
  const r = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(r);
  const status = r.status;
  if (status.kind !== "ready") throw new Error(status.kind);
  const files = new Map([["Launch.md", note]]);
  const port = new SdkSectionPort({
    profile: (res) => r.sectionProfile(res),
    commit: (res, intents, o) => r.commitSection(res, intents, o),
    storage: r.storage as LfcpStorage,
    canWrite: (res) => r.canWriteSection(res),
  });
  const fail = { create: false, commit: "" as "" | "before" | "after", edit: false, host: false };
  let hostResult: HostResult = { kind: "hosted" };
  const hosted: string[] = [];
  const host: CreationHost = {
    createSectionResource: async (o) => {
      const R = await r.createSectionResource(o);
      if (fail.create) throw new Error("crash after the Resource");
      return R;
    },
    openSection: (R) => r.openSection(R),
    host: async (R) => {
      if (fail.host) throw new Error("crash while hosting");
      if (hostResult.kind === "hosted") hosted.push(toBase64url(R));
      return hostResult;
    },
  };
  const flakyPort: SectionPort = {
    ...port,
    snapshot: (res, s) => port.snapshot(res, s),
    receiptOf: (res, op) => port.receiptOf(res, op),
    releaseReceipt: (res, op) => port.releaseReceipt(res, op),
    canWrite: (res) => port.canWrite(res),
    commit: async (res, intents, o) => {
      if (fail.commit === "before") throw new Error("connection lost");
      const receipt = await port.commit(res, intents, o);
      if (fail.commit === "after") throw new Error("ACK lost");
      return receipt;
    },
  };
  let n = 0;
  const deps: CreationDeps = {
    host,
    port: flakyPort,
    edit: async (path, fn) => {
      const current = files.get(path);
      if (current === undefined) return;
      const changes = fn(current);
      if (changes === null) return;
      files.set(path, applyChanges(current, changes));
      if (fail.edit) throw new Error("crash after the note was written");
    },
    journal: r.localState,
    createdBy: status.principalId,
    server: () => URL,
    newResourceId: () => new Uint8Array(32).fill(++n) as ResourceId,
    newNodeId: () => `0192e4a0-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`,
    newOperationId: () => `create-${++n}`,
    newTask: (line, id) => newSectionTask(line, status.principalId, id),
  };
  const preview = (md = files.get("Launch.md") as string) => {
    const range = proposeRange(md, md.split("\n").indexOf("## Launch"));
    if (range === null) throw new Error("no range");
    return preflight(md, range);
  };
  const sectionResources = async () =>
    (await r.registry()).filter((e) => e.profile !== undefined && e.profile.includes("sections"));
  return {
    r,
    port,
    files,
    fail,
    hosted,
    deps,
    preview,
    sectionResources,
    setHost: (h: HostResult) => {
      hostResult = h;
    },
  };
}

describe("creating a shared section", () => {
  it("imports the range as one operation, binds exactly the range, then hosts", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    const entry = await creation.prepare("Launch.md", NOTE, env.preview());
    expect(entry.intents[0]?.intent).toBe("section.create");
    expect(entry.intents).toHaveLength(5);
    const done = await creation.run(entry);
    expect(done.kind).toBe("hosted");
    const snap = env.port.snapshot(entry.resource, entry.sectionId);
    expect(snap?.ready).toBe(true);
    expect(snap?.title).toBe("Launch");
    expect(Object.values(snap?.nodes ?? {}).map((x) => x.text)).toEqual(
      expect.arrayContaining(["Draft the plan.", "Venue"]),
    );
    // The note: the range bound, private text untouched outside it.
    const md = env.files.get("Launch.md") as string;
    expect(md.startsWith(`${BEFORE}\n\n## Launch\n<!-- lfcp-section: `)).toBe(true);
    expect(md.endsWith(`\n\n## Other\n${AFTER}\n`)).toBe(true);
    const section = parseSections(md).sections[0];
    expect(section?.nodes.map((x) => x.id)).toEqual(
      entry.nodeIds.filter((id) => snap?.nodes[id]?.parent === null),
    );
    expect(JSON.stringify(entry.intents)).not.toContain("PRIVATE_");
    expect(env.hosted).toEqual([entry.resource]);
    expect(await creation.unfinished()).toEqual([]);
    expect(await env.sectionResources()).toHaveLength(1);

    // The engine takes the bound note as is: its base is the model, nothing to send.
    const engine = new SectionEngine({
      port: env.port,
      journal: new KeyValueSectionJournalStore(env.r.localState),
      bases: new KeyValueSectionBaseStore(env.r.localState),
      newNodeId: env.deps.newNodeId,
      newOperationId: env.deps.newOperationId,
      createdBy: env.deps.createdBy,
      newProjectionId: () => "projection",
      tasks: () => undefined,
      newTask: env.deps.newTask,
    });
    const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };
    const pass = await engine.pass("Launch.md", md, ctx);
    expect(applyChanges(md, pass.changes)).toBe(md);
    expect(pass.sections.flatMap((x) => x.entries)).toEqual([]);
  });

  it("resumes after a crash at every phase with the same Resource and operation", async () => {
    const env = await setup();
    const first = new SectionCreation(env.deps);
    const entry = await first.prepare("Launch.md", NOTE, env.preview());
    const resume = async () => {
      const [again] = await new SectionCreation(env.deps).unfinished();
      if (again === undefined) throw new Error("nothing to resume");
      expect(again.operationId).toBe(entry.operationId);
      return new SectionCreation(env.deps).run(again);
    };
    // prepared: after the Resource, before the import.
    env.fail.create = true;
    await expect(first.run(entry)).rejects.toThrow("crash after the Resource");
    env.fail.create = false;
    // local: the note is written, the journal is not.
    env.fail.edit = true;
    await expect(resume()).rejects.toThrow("crash after the note was written");
    env.fail.edit = false;
    // projected: hosting crashes.
    env.fail.host = true;
    await expect(resume()).rejects.toThrow("crash while hosting");
    env.fail.host = false;
    expect((await resume()).kind).toBe("hosted");
    expect(await env.sectionResources()).toHaveLength(1);
    const md = env.files.get("Launch.md") as string;
    expect(md.match(/<!-- lfcp-section: /g)).toHaveLength(1);
    expect(md.match(/lfcp-node: paragraph:/g)).toHaveLength(1);
    const snap = env.port.snapshot(entry.resource, entry.sectionId);
    expect(Object.keys(snap?.nodes ?? {})).toHaveLength(4);
  });

  it("a lost ACK: the receipt decides; no receipt, the next run commits the same batch", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    const entry = await creation.prepare("Launch.md", NOTE, env.preview());
    env.fail.commit = "before";
    await expect(creation.run(entry)).rejects.toThrow("connection lost");
    const [stillPrepared] = await creation.unfinished();
    expect(stillPrepared?.phase).toBe("prepared");
    env.fail.commit = "after";
    const done = await creation.run(stillPrepared ?? entry);
    expect(done.kind).toBe("hosted");
    expect(done.entry.receipt?.operationId).toBe(entry.operationId);
  });

  it("waits for a new review when the range changed since the preview", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    const entry = await creation.prepare("Launch.md", NOTE, env.preview());
    const edited = NOTE.replace("Draft the plan.", "Draft the plan, edited.");
    env.files.set("Launch.md", edited);
    const out = await creation.run(entry);
    expect(out.kind).toBe("stale");
    expect(env.files.get("Launch.md")).toBe(edited);
    expect(env.hosted).toEqual([]);
  });

  it("binds the moved range when only text outside it changed", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    const entry = await creation.prepare("Launch.md", NOTE, env.preview());
    env.files.set("Launch.md", `New first line.\n${NOTE}`);
    expect((await creation.run(entry)).kind).toBe("hosted");
    const md = env.files.get("Launch.md") as string;
    expect(md.startsWith(`New first line.\n${BEFORE}\n\n## Launch\n<!-- lfcp-section: `)).toBe(
      true,
    );
  });

  it("not hosted yet: created and bound here, no invitation, hosting resumes later", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    const entry = await creation.prepare("Launch.md", NOTE, env.preview());
    env.setHost({ kind: "pending", reason: "The server is not reachable now." });
    const out = await creation.run(entry);
    expect(out.kind).toBe("local");
    const [open] = await creation.unfinished();
    expect(open?.phase).toBe("projected");
    env.setHost({ kind: "hosted" });
    expect((await creation.run(open ?? entry)).kind).toBe("hosted");
    expect(env.hosted).toEqual([entry.resource]);
  });

  it("cancel before binding keeps the note; a refused import fails without binding", async () => {
    const env = await setup();
    const creation = new SectionCreation(env.deps);
    const entry = await creation.prepare("Launch.md", NOTE, env.preview());
    const cancelled = await creation.cancel(entry);
    expect((await creation.run(cancelled)).kind).toBe("cancelled");
    expect(env.files.get("Launch.md")).toBe(NOTE);
    expect(await creation.unfinished()).toEqual([]);

    const refusing = new SectionCreation({
      ...env.deps,
      port: {
        ...env.deps.port,
        commit: async () => {
          throw new CommitRefused("BUDGET_EXCEEDED" as never);
        },
      },
    });
    const other = await refusing.prepare("Launch.md", NOTE, env.preview());
    const out = await refusing.run(other);
    expect(out.kind).toBe("failed");
    expect(env.files.get("Launch.md")).toBe(NOTE);
  });
});
