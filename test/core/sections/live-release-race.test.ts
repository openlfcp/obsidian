// A section's status stuck at "pending" (the soak of 0.4.0-beta.17,
// finding #1): the plugin releases a batch's receipt when its pass is done
// (commit.ts finish), outside the SDK's own queue. When the ACK of that
// batch lands at the same moment, the SDK reports the batch from a status
// read half before the release (the receipt still there) and half after
// it (the status, forgotten as final): "pending", for a batch that is
// accepted and gone. Nothing reports it again, so the section said
// "1 local update waiting" for ever. Here the interleaving is forced: the
// SDK's read of the accepted status waits until the release is committed.
// The status the host keeps (SdkStatusTracker) drops a batch the SDK no
// longer holds. Reference server at LFCP_SERVER_BIN; skipped without one.

import { releaseReceipt } from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseSections } from "../../../src/core/sections/parser";
import { runtimeStatusSource, SdkStatusTracker } from "../../../src/core/status/sdk-tracker";
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
  for (const p of stopping.splice(0)) await p.stop().catch(() => undefined);
});

describe.skipIf(skip !== null)("soak #1: a release racing an ACK's report", () => {
  it("the batch reported pending across the release is not left pending", async () => {
    const a = await peer(server.url);
    stopping.push(a);
    a.files.set("A.md", ["## Plan", "", "- [ ] Alpha", "", "A paragraph.", ""].join("\n"));
    const { resource } = await a.share("A.md", "## Plan");
    const R = resource as ResourceId;
    const storage = a.runtime.storage;
    if (storage === null || storage === undefined) throw new Error("no storage");

    // The status the host keeps, from the runtime's events.
    const tracker = new SdkStatusTracker(
      runtimeStatusSource({ runtime: () => a.runtime, watched: () => true, changed: () => {} }),
    );
    await tracker.snapshot(R);
    const reports: { op: string; status: string }[] = [];
    a.runtime.on((e) => {
      if (e.type !== "status" || toHex(e.resourceId) !== toHex(R)) return;
      if (e.event.kind === "batch")
        reports.push({ op: e.event.operationId, status: e.event.status });
      tracker.event(e.resourceId, e.event);
    });

    // The SDK's read of the batch's accepted status (its report after the ACK) waits.
    const op = "race-1";
    const marks = storage.localMarks;
    const get = marks.get.bind(marks);
    let armed = true;
    let held: () => void = () => undefined;
    const holding = new Promise<void>((r) => {
      held = r;
    });
    let go: () => void = () => undefined;
    const going = new Promise<void>((r) => {
      go = r;
    });
    marks.get = async (key: string) => {
      const v = await get(key);
      if (
        armed &&
        key.startsWith("batch-status:") &&
        key.endsWith(`:${op}`) &&
        v !== undefined &&
        (JSON.parse(v) as { accepted: string[] }).accepted.length > 0
      ) {
        armed = false;
        held();
        await going;
        return get(key);
      }
      return v;
    };

    // One edit: a batch, sent, acknowledged.
    const sid = parseSections(a.files.get("A.md") as string).sections[0]?.ref.sectionId as string;
    const snap = a.port.snapshot(a.b64(R), sid);
    const paragraph = Object.entries(snap?.nodes ?? {}).find(
      ([, n]) => n.kind === "paragraph",
    )?.[0];
    await a.port.commit(
      a.b64(R),
      [
        {
          intent: "text.edit",
          id: paragraph as string,
          edits: [{ index: 0, deleteCount: 0, insert: "Now: " }],
          base: snap?.revision as string,
        },
      ],
      { operationId: op },
    );
    await holding;
    // The pass is done meanwhile: the plugin releases the receipt (the port then confirms the batch).
    await releaseReceipt(storage, R, op);
    await tracker.confirm(R, op);
    go();

    // The SDK reported the batch "pending" after the release: the race, reproduced.
    await waitFor(async () => (reports.filter((r) => r.op === op).length >= 2 ? true : undefined));
    expect(reports.filter((r) => r.op === op).map((r) => r.status)).toEqual(["pending", "pending"]);
    // The kept status does not keep it pending.
    await waitFor(async () =>
      tracker.get(toHex(R))?.batches.some((b) => b.id === op) === false ? true : undefined,
    );
    marks.get = get;
  }, 60_000);
});
