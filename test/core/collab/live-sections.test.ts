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
} from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JoinStage } from "../../../src/core/collab";
import { CollabError, Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { SectionCreation } from "../../../src/core/sections/create";
import { applyChanges } from "../../../src/core/sections/engine";
import { type InsertPreview, SectionInsertion } from "../../../src/core/sections/insert";
import { parseSections } from "../../../src/core/sections/parser";
import { preflight, proposeRange } from "../../../src/core/sections/share";
import { KeyValueSectionBaseStore } from "../../../src/core/sections/stores";
import { newSectionTask } from "../../../src/core/sections/task-fields";
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
async function vault(sections = true, serverUrl?: string) {
  const d = new Device();
  const { webSocket: _offline, ...online } = d.env(new FakeLocal(), { tickMs: 20 });
  const runtime = await LfcpRuntime.start(online);
  running.push(runtime);
  const status = runtime.status;
  if (status.kind !== "ready") throw new Error(status.kind);
  const collab = new Collaboration(runtime, { connectTimeoutMs: 5000, sleep, sections });
  const port = new SdkSectionPort({
    profile: (r) => runtime.sectionProfile(r),
    commit: (r, intents, o) => runtime.commitSection(r, intents, o),
    storage: runtime.storage as LfcpStorage,
    canWrite: () => ({ allowed: true }),
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
  return { runtime, collab, port, files, creation, insertion, principal: status.principalId };
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
      const p = member.insertion.preview(R, sectionId);
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

    // One-time: the same link is refused for a third vault.
    const late = await vault();
    expect(await late.collab.join(invitation.link.reveal(), { name: "Late" })).toMatchObject({
      kind: "refused",
      code: "AUTHORIZATION_FAILED",
    });
    expect(await late.runtime.hasResource(R)).toBe(false);
  }, 90_000);

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
