// A share given up before its section was hosted, live (F-03, runtime.
// discardUnhosted): the note changed while its Resource was being made, so
// the creation finds it stale and cancels it. The Resource, never sent,
// leaves nothing in storage (no row, no Control state, no epoch, nothing
// queued); sharing the section again, on its new text, works, and a
// member gets it. Reference server at LFCP_SERVER_BIN; skipped without one.

import type { ResourceId } from "@openlfcp/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { preflight, proposeRange } from "../../../src/core/sections/share";
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

const NOTE = ["## Plan", "", "- [ ] Alpha", "- [ ] Beta", ""].join("\n");

describe.skipIf(skip !== null)("a share given up before it was hosted", () => {
  it("leaves nothing in storage; sharing the section again works", async () => {
    const a = await peer(server.url);
    stopping.push(a);
    a.files.set("A.md", NOTE);
    // While its Resource is made, the user edits the section: it no longer binds.
    const create = a.runtime.createSectionResource.bind(a.runtime);
    let made: ResourceId | undefined;
    a.runtime.createSectionResource = async (o) => {
      made = await create(o);
      a.files.set("A.md", NOTE.replace("- [ ] Beta", "- [ ] Beta edited meanwhile"));
      return made;
    };
    const range = proposeRange(NOTE, 0);
    if (range === null) throw new Error("no section");
    const entry = await a.creation.prepare("A.md", NOTE, preflight(NOTE, range));
    const out = await a.creation.run(entry);
    a.runtime.createSectionResource = create;
    expect(out.kind).toBe("stale");
    if (made === undefined) throw new Error("no Resource made");
    const R = made;
    const storage = a.runtime.storage;
    if (storage === null) throw new Error("no storage");
    // Nothing of it stays.
    expect(await storage.resources.get(R)).toBeUndefined();
    expect((await storage.control.head(R)) ?? null).toBeNull();
    expect(await storage.control.epochs(R)).toEqual([]);
    expect(await storage.outbound.list(R)).toEqual([]);
    expect(
      await a.runtime.localState.get(`resource-discarded:${Buffer.from(R).toString("hex")}`),
    ).toBeUndefined();
    expect((await a.runtime.registry()).length).toBe(0);
    // The note is as the user left it, unbound.
    expect(a.files.get("A.md")).not.toContain("lfcp-section");

    // Shared again, on its new text: hosted; a member gets it.
    const { resource } = await a.share("A.md", "## Plan");
    expect(Buffer.from(resource).equals(Buffer.from(R))).toBe(false);
    expect(
      (await a.runtime.registry()).map((e) => Buffer.from(e.resourceId).toString("hex")),
    ).toEqual([Buffer.from(resource).toString("hex")]);
    const b = await peer(server.url);
    stopping.push(b);
    b.files.set("B.md", ["# B", "", "Insert below.", ""].join("\n"));
    await b.joinAndInsert((await a.collab.invite(resource, "read-write")).link.reveal(), "B.md", 3);
    await waitFor(async () =>
      (b.files.get("B.md") as string).includes("- [ ] Beta edited meanwhile") ? true : undefined,
    );
  }, 120_000);
});
