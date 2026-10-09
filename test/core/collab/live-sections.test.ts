// LFCP-02-051 against the reference server: a shared section created and
// hosted from a note (050), an invitation offered only once it is hosted
// and ready, a second vault joining it through the one-time claim with the
// sections profile, loading it completely and inserting it (052); a
// client without the profile leaves the link unused; a second claim of the
// same link is refused. Skipped without a server binary.

import {
  fromBase64url,
  generateObjectId,
  generateResourceId,
  type ResourceId,
  toBase64url,
  toHex,
} from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JoinStage } from "../../../src/core/collab";
import { CollabError, Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { SectionCreation } from "../../../src/core/sections/create";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import { type InsertPreview, SectionInsertion } from "../../../src/core/sections/insert";
import { parseSections } from "../../../src/core/sections/parser";
import { preflight, proposeRange } from "../../../src/core/sections/share";
import {
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { newSectionTask } from "../../../src/core/sections/task-fields";
import { accessView } from "../../../src/core/status/access";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

const skip = liveSkipReason();
let server: LiveServer;
const running: LfcpRuntime[] = [];

beforeAll(async () => {
  if (skip === null) server = await startLiveServer();
}, 30_000);
afterAll(async () => {
  for (const r of running.splice(0)) await r.stop();
  await server?.stop();
});

const NOTE = [
  "PRIVATE_BEFORE_8f3a: budget.",
  "",
  "## Launch",
  "- [ ] Prepare contract",
  "",
  "Draft the plan.",
  "",
  "## Other",
  "PRIVATE_AFTER_71c2: do not transmit.",
  "",
].join("\n");

/** A vault online, with its notes in memory and the section flows over its runtime. */
async function vault(sections = true, serverUrl?: string, snapshotEvery?: number) {
  const d = new Device();
  const { webSocket: _offline, ...online } = d.env(new FakeLocal(), { tickMs: 20 });
  const runtime = await LfcpRuntime.start({
    ...online,
    ...(snapshotEvery === undefined ? {} : { snapshotEvery }),
  });
  running.push(runtime);
  const status = runtime.status;
  if (status.kind !== "ready") throw new Error(status.kind);
  const collab = new Collaboration(runtime, { connectTimeoutMs: 5000, sleep, sections });
  const port = new SdkSectionPort({
    profile: (r) => runtime.sectionProfile(r),
    commit: (r, intents, o) => runtime.commitSection(r, intents, o),
    storage: runtime.storage as LfcpStorage,
    canWrite: (r) => runtime.canWriteSection(r),
  });
  const files = new Map<string, string>();
  const edit = async (
    path: string,
    fn: (current: string) => readonly { from: number; to: number; insert: string }[] | null,
  ) => {
    const current = files.get(path);
    if (current === undefined) return;
    const changes = fn(current);
    if (changes !== null) files.set(path, applyChanges(current, changes));
  };
  const creation = new SectionCreation({
    host: {
      createSectionResource: (o) => runtime.createSectionResource(o),
      openSection: (R) => runtime.openSection(R),
      host: async (R) => {
        const h = await collab.host(R);
        return h.kind === "hosted" ? { kind: "hosted" } : h;
      },
    },
    port,
    edit,
    journal: runtime.localState,
    createdBy: status.principalId,
    server: () => serverUrl ?? server.url,
    newResourceId: () => generateResourceId(),
    newNodeId: () => generateObjectId(),
    newOperationId: () => crypto.randomUUID(),
    newTask: (line, id) => newSectionTask(line, status.principalId, id),
  });
  const insertion = new SectionInsertion({
    port,
    bases: new KeyValueSectionBaseStore(runtime.localState),
    journal: runtime.localState,
    loaded: (r) => runtime.sectionLoad(fromB64(r))?.loaded === true,
    task: (r, id) => port.task(r, id),
    edit,
    newInsertionId: () => crypto.randomUUID(),
  });
  // The engine as the plugin runs it: section Tasks render and send their fields.
  const engine = new SectionEngine({
    port,
    journal: new KeyValueSectionJournalStore(runtime.localState),
    bases: new KeyValueSectionBaseStore(runtime.localState),
    newNodeId: () => generateObjectId(),
    newOperationId: () => crypto.randomUUID(),
    createdBy: status.principalId,
    newProjectionId: () => crypto.randomUUID(),
    tasks: (r, taskId) => ({ view: port.taskView(r, taskId) }),
    newTask: (line, id) => newSectionTask(line, status.principalId, id),
  });
  /** One engine pass over a note, written as the plugin writes it. */
  const pass = async (path: string) => {
    const md = files.get(path) as string;
    const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };
    const p = await engine.pass(path, md, ctx);
    const out = applyChanges(md, p.changes);
    files.set(path, out);
    await engine.written(p, out);
    return out;
  };
  return {
    runtime,
    collab,
    port,
    files,
    creation,
    insertion,
    pass,
    principal: status.principalId,
  };
}

const fromB64 = (b64: string) => fromBase64url(b64) as ResourceId;

async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(skip !== null)("LFCP-02-051 live: invite to and join a shared section", () => {
  it("creates and hosts, invites once ready, joins, loads and inserts it in a second vault", async () => {
    // The owner shares the section of a note: created, imported, bound and hosted.
    const owner = await vault();
    owner.files.set("Launch.md", NOTE);
    const range = proposeRange(NOTE, 2);
    if (range === null) throw new Error("no range");
    const created = await owner.creation.run(
      await owner.creation.prepare("Launch.md", NOTE, preflight(NOTE, range)),
    );
    expect(created.kind).toBe("hosted");
    const R = fromB64(created.entry.resource);
    const sectionId = created.entry.sectionId;

    // A client without the sections profile: refused before the claim, the link stays unused.
    const invitation = await owner.collab.invite(R, "read-write");
    expect(invitation.confirmed).toBe(true);
    const old = await vault(false);
    const refused = await old.collab.join(invitation.link.reveal(), { name: "Old" });
    expect(refused).toMatchObject({ kind: "needs-newer-version" });
    expect(await old.runtime.hasResource(R)).toBe(false);

    // The second vault joins with the same link: every stage, then the section loaded.
    const member = await vault();
    const stages: JoinStage[] = [];
    const joined = await member.collab.join(invitation.link.reveal(), {
      name: "Launch",
      onStage: (s) => stages.push(s),
    });
    expect(joined).toMatchObject({
      kind: "joined",
      abilities: ["data/read", "data/write"],
      section: { loaded: true },
    });
    expect(stages).toEqual([
      "connecting",
      "validating invitation",
      "retrieving key",
      "claiming capability",
      "synchronizing",
      "loading section",
    ]);

    // Inserted there, complete: the same nodes as the owner's note.
    member.files.set("Week.md", "# Week\n\nMine.\n");
    const preview = await until("the section on the member", async () => {
      const p = await member.insertion.preview(R, sectionId);
      return "refused" in p ? undefined : (p as InsertPreview);
    });
    const inserted = await member.insertion.run(
      await member.insertion.prepare("Week.md", "# Week\n\nMine.\n", 2, preview),
    );
    expect(inserted.kind).toBe("inserted");
    const week = member.files.get("Week.md") as string;
    expect(week).not.toContain("PRIVATE_");
    const ids = (md: string) =>
      parseSections(md).sections[0]?.nodes.map((n) => n.id) ?? ["no section"];
    expect(ids(week)).toEqual(ids(owner.files.get("Launch.md") as string));
    expect(week).toContain("- [ ] Prepare contract\n");
    expect(week).toContain("Draft the plan.\n");

    // An owner's edit reaches the member's model.
    const paragraph = parseSections(owner.files.get("Launch.md") as string).sections[0]?.nodes[1]
      ?.id as string;
    const snap = owner.port.snapshot(toBase64url(R), sectionId);
    await owner.port.commit(
      toBase64url(R),
      [
        {
          intent: "text.edit",
          id: paragraph,
          edits: [{ index: 15, deleteCount: 0, insert: " Today" }],
          base: snap?.revision as string,
        },
      ],
      { operationId: "edit-1" },
    );
    await until("the owner's edit on the member", async () =>
      member.port.snapshot(toBase64url(R), sectionId)?.nodes[paragraph]?.text ===
      "Draft the plan. Today"
        ? true
        : undefined,
    );

    // Task fields in the section, both ways through the real SDK TaskView:
    // the owner checks the Task and gives it a due date; the member's note
    // shows both, and the member's own edit of the date comes back.
    // The owner's note shows its own edit, as the editor would have written it.
    owner.files.set(
      "Launch.md",
      (owner.files.get("Launch.md") as string).replace("Draft the plan.", "Draft the plan. Today"),
    );
    await owner.pass("Launch.md");
    await member.pass("Week.md");
    owner.files.set(
      "Launch.md",
      (owner.files.get("Launch.md") as string).replace(
        "- [ ] Prepare contract",
        "- [x] Prepare contract 📅 2026-10-20",
      ),
    );
    await owner.pass("Launch.md");
    const taskId = parseSections(owner.files.get("Launch.md") as string).sections[0]?.nodes[0]
      ?.id as string;
    expect(owner.port.taskView(toBase64url(R), taskId)?.task).toMatchObject({
      status: "done",
      due: "2026-10-20",
    });
    const memberLine = await until("the checked Task on the member", async () => {
      const md = await member.pass("Week.md");
      const line = md.split("\n").find((l) => l.includes("Prepare contract"));
      return line?.startsWith("- [x] Prepare contract") && line.includes("📅 2026-10-20")
        ? line
        : undefined;
    });
    expect(memberLine).toMatch(/^- \[x\] Prepare contract .*📅 2026-10-20/);
    member.files.set(
      "Week.md",
      (member.files.get("Week.md") as string).replace("📅 2026-10-20", "📅 2026-10-27"),
    );
    await member.pass("Week.md");
    await until("the member's date on the owner", async () =>
      owner.port.taskView(toBase64url(R), taskId)?.task?.due === "2026-10-27" ? true : undefined,
    );
    expect((await owner.pass("Launch.md")).includes("📅 2026-10-27")).toBe(true);

    // A reader (§6): the SDK says read-only; an edit writes nothing and stays local.
    const readInvite = await owner.collab.invite(R, "read");
    const reader = await vault();
    expect(
      await reader.collab.join(readInvite.link.reveal(), { name: "Launch (read)" }),
    ).toMatchObject({ kind: "joined", abilities: ["data/read"] });
    expect(await reader.port.canWrite(toBase64url(R))).toMatchObject({
      allowed: false,
      reason: "read-only",
    });
    reader.files.set("Read.md", "# Mine\n");
    const readPreview = (await reader.insertion.preview(R, sectionId)) as InsertPreview;
    expect(readPreview.readOnly).toBe(true);
    await reader.insertion.run(
      await reader.insertion.prepare("Read.md", "# Mine\n", 0, readPreview),
    );
    await reader.pass("Read.md");
    reader.files.set(
      "Read.md",
      (reader.files.get("Read.md") as string).replace("Draft the plan. Today", "Reader's change"),
    );
    const kept = await reader.pass("Read.md");
    expect(kept).toContain("Reader's change");
    const units = (await reader.runtime.storage?.outbound.list(R))?.filter(
      (i) => i.kind === "data-unit",
    );
    expect(units).toEqual([]);
    await sleep(500);
    expect(
      Object.values(owner.port.snapshot(toBase64url(R), sectionId)?.nodes ?? {}).map((n) => n.text),
    ).not.toContain("Reader's change");

    // 060: who has access, from each vault's validated Control state.
    const view = async (v: Awaited<ReturnType<typeof vault>>) => {
      const mine = await v.runtime.sectionAccessState(R);
      return accessView({
        participants: (await v.collab.status(R)).participants,
        mine: {
          allowed: mine.allowed,
          current: mine.current,
          verifiedAt: mine.verifiedAt,
          abilities: mine.abilities,
          owner: mine.owner,
          pendingControl: mine.pendingControl.map((p) => p.type),
        },
        aliases: {},
        connected: true,
        time: () => "now",
      });
    };
    const ownerView = await until("both members on the owner's view", async () => {
      const v = await view(owner);
      return v.rows.length >= 3 ? v : undefined;
    });
    expect(ownerView.rows.map((r) => [r.you, r.role])).toEqual(
      expect.arrayContaining([
        [true, "owner"],
        [false, "can edit"],
        [false, "can read"],
      ]),
    );
    expect(ownerView.rows.filter((r) => !r.you).every((r) => r.removable)).toBe(true);
    expect(ownerView.canInvite).toBe(true);
    const readerView = await view(reader);
    expect(readerView.canInvite).toBe(false);
    expect(readerView.rows.every((r) => !r.removable)).toBe(true);

    // One-time: the same link is refused for a third vault.
    const late = await vault();
    expect(await late.collab.join(invitation.link.reveal(), { name: "Late" })).toMatchObject({
      kind: "refused",
      code: "AUTHORIZATION_FAILED",
    });
    expect(await late.runtime.hasResource(R)).toBe(false);
  }, 90_000);

  it("POST-007: the owner's plugin publishes a Snapshot; a new member catches up from it and the tail", async () => {
    const owner = await vault(true, undefined, 3);
    const published: string[] = [];
    owner.runtime.on((e) => {
      if (e.type === "snapshot-published") published.push(toHex(e.snapshotId));
    });
    owner.files.set("Launch.md", NOTE);
    const range = proposeRange(NOTE, 2);
    if (range === null) throw new Error("no range");
    const created = await owner.creation.run(
      await owner.creation.prepare("Launch.md", NOTE, preflight(NOTE, range)),
    );
    expect(created.kind).toBe("hosted");
    const R = fromB64(created.entry.resource);
    const sectionId = created.entry.sectionId;
    const b64 = toBase64url(R);
    // A few edits: past the threshold, the plugin publishes a Snapshot (snapshot/publish: owner).
    const paragraph = parseSections(owner.files.get("Launch.md") as string).sections[0]?.nodes[1]
      ?.id as string;
    for (const [n, word] of ["one", "two", "three", "four"].entries()) {
      const snap = owner.port.snapshot(b64, sectionId);
      const text = snap?.nodes[paragraph]?.text ?? "";
      await owner.port.commit(
        b64,
        [
          {
            intent: "text.edit",
            id: paragraph,
            edits: [{ index: [...text].length, deleteCount: 0, insert: ` ${word}` }],
            base: snap?.revision as string,
          },
        ],
        { operationId: `edit-${n}` },
      );
    }
    await until(
      "a Snapshot published by the owner's plugin",
      async () => (published.length > 0 ? true : undefined),
      20_000,
    );
    // The tail after it: one more edit.
    const snap = owner.port.snapshot(b64, sectionId);
    await owner.port.commit(
      b64,
      [
        {
          intent: "text.edit",
          id: paragraph,
          edits: [
            {
              index: [...(snap?.nodes[paragraph]?.text ?? "")].length,
              deleteCount: 0,
              insert: " tail",
            },
          ],
          base: snap?.revision as string,
        },
      ],
      { operationId: "edit-tail" },
    );
    await until("the tail sent", async () =>
      ((await owner.runtime.storage?.outbound.list(R)) ?? []).length === 0 ? true : undefined,
    );

    const member = await vault();
    const loaded: string[] = [];
    member.runtime.on((e) => {
      if (e.type === "snapshot-loaded") loaded.push(toHex(e.snapshotId));
    });
    const invitation = await owner.collab.invite(R, "read-write");
    const joined = await member.collab.join(invitation.link.reveal(), { name: "Launch" });
    expect(joined).toMatchObject({ kind: "joined", section: { loaded: true } });
    const expected = owner.port.snapshot(b64, sectionId)?.nodes[paragraph]?.text;
    expect(expected).toBe("Draft the plan. one two three four tail");
    await until("the section on the member", async () =>
      member.port.snapshot(b64, sectionId)?.nodes[paragraph]?.text === expected ? true : undefined,
    );
    console.log(`EVIDENCE ${JSON.stringify({ id: "SNAPSHOT-JOIN", published, loaded })}`);
    expect(loaded.length).toBeGreaterThan(0);
    expect(published).toContain(loaded[0]);
    // And the member writes on top.
    const mine = member.port.snapshot(b64, sectionId);
    await member.port.commit(
      b64,
      [
        {
          intent: "text.edit",
          id: paragraph,
          edits: [{ index: 0, deleteCount: 0, insert: "Mine: " }],
          base: mine?.revision as string,
        },
      ],
      { operationId: "member-edit" },
    );
    await until(
      "the member's edit on the owner",
      async () =>
        owner.port.snapshot(b64, sectionId)?.nodes[paragraph]?.text?.startsWith("Mine: ") === true
          ? true
          : undefined,
      20_000,
    );
  }, 120_000);

  it("offers no invitation before the section is hosted", async () => {
    const owner = await vault(true, "ws://127.0.0.1:9/v1/ws");
    owner.files.set("Launch.md", NOTE);
    const range = proposeRange(NOTE, 2);
    if (range === null) throw new Error("no range");
    // An unreachable server: created and bound here, not hosted.
    const offline = owner.creation;
    const out = await offline.run(await offline.prepare("Launch.md", NOTE, preflight(NOTE, range)));
    expect(out.kind).toBe("local");
    const R = fromB64(out.entry.resource);
    await expect(owner.collab.invite(R, "read-write")).rejects.toMatchObject({
      code: "NOT_HOSTED",
    });
    await expect(owner.collab.invite(R, "read-write")).rejects.toBeInstanceOf(CollabError);
  }, 30_000);
});
