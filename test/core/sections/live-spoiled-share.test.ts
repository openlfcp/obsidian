// LFCP-03-063, live: a section Resource whose epoch-0 key is not its Genesis's
// (what two creations at once made in 0.4.1 and 0.4.2) can never be written.
// Never shared, it is given up by the user's choice and the section is created
// again from the note's text, under a new operation: the new one is hosted and
// a member gets it; the old Resource is gone from the device, and the note
// is as the user left it until the new creation binds it. Reference server at
// LFCP_SERVER_BIN; skipped without one.

import { fromBase64url, type ResourceId } from "@openlfcp/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CreationKeyMismatch } from "../../../src/core/sections/create";
import { parseSections } from "../../../src/core/sections/parser";
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

const NOTE = ["# Notes", "", "## Plan", "", "- [ ] Alpha", "- [ ] Beta", ""].join("\n");

describe.skipIf(skip !== null)("a spoiled section Resource, shared again", () => {
  it("fails typed, is given up on the user's choice, and the new section is hosted", async () => {
    const a = await peer(server.url);
    stopping.push(a);
    a.files.set("A.md", NOTE);
    const range = proposeRange(NOTE, NOTE.split("\n").indexOf("## Plan"));
    if (range === null) throw new Error("no section");
    const entry = await a.creation.prepare("A.md", NOTE, preflight(NOTE, range));
    const R = fromBase64url(entry.resource) as ResourceId;

    // The state the race left: the Resource's epoch-0 key is another key.
    const slots = a.device.slots.values;
    const before = new Set(slots.keys());
    await a.runtime.createSectionResource({
      name: "Plan",
      endpoints: [server.url],
      coordinatorUrl: server.url,
      resourceId: R,
    });
    const mine = [...slots.keys()].filter((k) => !before.has(k));
    const mid = new Set(slots.keys());
    const donorR = new Uint8Array(32).fill(249) as ResourceId;
    await a.runtime.createSectionResource({
      name: "donor",
      endpoints: [server.url],
      coordinatorUrl: server.url,
      resourceId: donorR,
    });
    const donor = [...slots.keys()].filter((k) => !mid.has(k));
    expect(mine).toHaveLength(1);
    expect(donor).toHaveLength(1);
    slots.set(mine[0] as string, slots.get(donor[0] as string) as string);
    // The donor is not part of this scenario.
    await a.runtime.discardUnhosted(donorR);

    // Every run fails the same typed way; nothing was sent, the note is untouched.
    await expect(a.creation.run(entry)).rejects.toBeInstanceOf(CreationKeyMismatch);
    await expect(a.creation.run(entry)).rejects.toBeInstanceOf(CreationKeyMismatch);
    expect(a.files.get("A.md")).toBe(NOTE);
    expect(await a.creation.canShareAgain(entry)).toBe(true);

    // The user's choice: a new creation under a new operation, the old one given up.
    const swapped = await a.creation.shareAgain(entry, NOTE, preflight(NOTE, range));
    if (swapped === null) throw new Error("refused");
    expect(swapped.fresh.operationId).not.toBe(entry.operationId);
    expect(swapped.old.phase).toBe("cancelled");
    const storage = a.runtime.storage;
    if (storage === null) throw new Error("no storage");
    expect(await storage.resources.get(R)).toBeUndefined();
    expect(a.files.get("A.md")).toBe(NOTE);

    const created = await a.creation.run(swapped.fresh);
    expect(created.kind).toBe("hosted");
    expect(parseSections(a.files.get("A.md") as string).sections).toHaveLength(1);
    const resource = fromBase64url(swapped.fresh.resource) as ResourceId;

    // A member gets it.
    const b = await peer(server.url);
    stopping.push(b);
    b.files.set("B.md", ["# B", "", "Insert below.", ""].join("\n"));
    await b.joinAndInsert((await a.collab.invite(resource, "read-write")).link.reveal(), "B.md", 3);
    await waitFor(async () =>
      (b.files.get("B.md") as string).includes("- [ ] Beta") ? true : undefined,
    );
  }, 120_000);
});
