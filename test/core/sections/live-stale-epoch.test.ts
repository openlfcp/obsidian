// Offline work in a shared section when the owner removes someone else
// meanwhile (0.4.0-beta.14, found 2026-10-13): A owns the section, B and C
// are members. B, offline, edits; A removes C, so the Data Epoch rotates
// (LFCP-WIRE-01 §19, "member revoked"); B comes back. B's offline units
// are beyond the closed epoch's final frontier: the SDK quarantines them
// and rebuilds B's replica without them (§19.1). §19.1 asks that this
// stale work be surfaced, and kept work re-applied as new units in the
// current epoch. Sections do neither today. A title edit or a move is
// silently undone in B's note, and a new Task stays in B's note but in no
// model. Nobody else ever gets any of it, and nothing says so. Reference
// server at LFCP_SERVER_BIN; skipped without one.

import type { WebSocketFactory } from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

/**
 * One member's network, switchable: every WebSocket its runtime opens, to
 * any URL (the invitation's, or the Genesis's own server URL), goes through
 * it. off() closes them and points new ones at a closed port; on() lets
 * them through. (A proxy in front of one URL left B online through the
 * other on a slower runner.)
 */
function networkSwitch() {
  const open = new Set<WebSocket>();
  let offline = false;
  const factory: WebSocketFactory = (url, protocols) => {
    const ws = new WebSocket(offline ? "ws://127.0.0.1:9/v1/ws" : url, [...protocols]);
    open.add(ws);
    ws.addEventListener("close", () => open.delete(ws));
    return ws as unknown as ReturnType<WebSocketFactory>;
  };
  return {
    factory,
    off: async () => {
      offline = true;
      for (const ws of open) ws.close();
    },
    on: async () => {
      offline = false;
    },
  };
}

const tasks = (md: string) =>
  md
    .split("\n")
    .filter((l) => /^\s*- \[.\] /.test(l))
    .map((l) => l.replace(/^\s*- \[.\] /, ""));

const stopping: Peer[] = [];
afterEach(async () => {
  for (const p of stopping.splice(0)) await p.stop();
});

/** A owns [Alpha, Beta, Gamma]; B (with its own network switch) and C are members; B has one accepted edit. */
async function setup() {
  const a = await peer(server.url);
  const net = networkSwitch();
  const b = await peer(server.url, undefined, { webSocket: net.factory });
  const c = await peer(server.url);
  stopping.push(a, b, c);
  a.files.set("A.md", ["## Plan", "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n"));
  const { resource: R } = await a.share("A.md", "## Plan");
  const link = async () => (await a.collab.invite(R, "read-write")).link.reveal();
  b.files.set("B.md", ["# B", "", "Insert below.", ""].join("\n"));
  await b.joinAndInsert(await link(), "B.md", 3);
  c.files.set("C.md", ["# C", "", "Insert below.", ""].join("\n"));
  await c.joinAndInsert(await link(), "C.md", 3);
  b.files.set("B.md", (b.files.get("B.md") as string).replace("- [ ] Alpha", "- [ ] Alpha by B"));
  await b.pass("B.md");
  await waitFor(async () =>
    JSON.stringify(a.runtime.sectionProfile(R)?.replica.toJSON()).includes("Alpha by B")
      ? true
      : undefined,
  );
  return { a, b, c, R, net };
}

/** B edits offline (`edit`, one pass); A removes C meanwhile; B comes back. */
async function offlineThenRotation(
  s: Awaited<ReturnType<typeof setup>>,
  edit: (md: string) => string,
  meanwhile: () => Promise<void> = async () => undefined,
) {
  const { a, b, c, R, net } = s;
  await net.off();
  // B is offline for real: its Resource leaves LIVE before it edits.
  await waitFor(
    async () => (b.runtime.phase(R as ResourceId) !== "LIVE" ? true : undefined),
    20_000,
  );
  b.files.set("B.md", edit(b.files.get("B.md") as string));
  await b.pass("B.md");
  await meanwhile();
  let removed = await a.runtime.revokeSectionAccess(R, c.principal as never);
  for (let i = 0; i < 40 && removed.kind !== "queued"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    removed = await a.runtime.revokeSectionAccess(R, c.principal as never);
  }
  expect(removed.kind).toBe("queued");
  // The removal (and the new epoch's Key Packages) at the server before B comes back.
  const aStorage = a.runtime.storage;
  if (aStorage === null) throw new Error("A's runtime has no storage");
  await waitFor(
    async () => ((await aStorage.outbound.list(R as ResourceId)).length === 0 ? true : undefined),
    45_000,
  );
  await new Promise((r) => setTimeout(r, 1000));
  await net.on();
  // B is back: its offline unit is cut off by the Key Epoch (quarantined), then
  // re-applied or put to review; nothing waits any more, nothing is left to send.
  const storage = b.runtime.storage;
  if (storage === null) throw new Error("B's runtime has no storage");
  const r64 = b.b64(R);
  await waitFor(async () => {
    const queued = (await storage.outbound.list(R as ResourceId)).filter(
      (i) => i.kind === "data-unit",
    ).length;
    // Re-applied: nothing waits and nothing is queued. In review: its stale unit stays
    // queued (blocked) until the user chooses.
    const done = !b.stale.waiting(r64) && queued === 0;
    const review = b.stale.counts(r64).review > 0;
    return (done || review) && b.runtime.phase(R as ResourceId) === "LIVE" ? true : undefined;
  }, 60_000);
  for (let i = 0; i < 3; i++) await b.pass("B.md");
  return { quarantined: await storage.dataUnits.withStatus(R as ResourceId, "quarantined") };
}

/**
 * The Task titles of A's model, in its order, once they satisfy `want` (or
 * at the deadline). The model, not A's note: the peer's share leaves A's
 * note without a base, so it is not projected here.
 */
async function aShows(a: Peer, R: ResourceId, want: (titles: string[]) => boolean) {
  const titles = () => {
    const replica = a.runtime.sectionProfile(R)?.replica;
    if (replica === undefined) return [];
    return replica
      .tree()
      .tree.filter((e) => e.kind === "task")
      .map((e) => replica.task(e.id)?.task?.title ?? e.id);
  };
  return waitFor(async () => (want(titles()) ? titles() : undefined), 20_000).catch(() => titles());
}

describe.skipIf(skip !== null)("offline work across an unrelated removal (§19.1)", () => {
  it("a title edit stays in B's note and reaches A", async () => {
    const s = await setup();
    const { quarantined } = await offlineThenRotation(s, (md) =>
      md.replace("- [ ] Beta", "- [ ] Beta retitled offline"),
    );
    // B was offline for real: its unit was cut off by the Key Epoch.
    expect(quarantined.length).toBeGreaterThan(0);
    expect(tasks(s.b.files.get("B.md") as string)).toContain("Beta retitled offline");
    expect(await aShows(s.a, s.R, (t) => t.includes("Beta retitled offline"))).toContain(
      "Beta retitled offline",
    );
  }, 150_000);

  it("a move stays in B's note and reaches A", async () => {
    const s = await setup();
    await offlineThenRotation(s, (md) => {
      const L = md.split("\n");
      const block = L.splice(
        L.findIndex((l) => l.includes("] Gamma")),
        2,
      );
      L.splice(
        L.findIndex((l) => l.includes("] Alpha")),
        0,
        ...block,
      );
      return L.join("\n");
    });
    expect(tasks(s.b.files.get("B.md") as string)).toEqual(["Gamma", "Alpha by B", "Beta"]);
    expect(await aShows(s.a, s.R, (t) => t[0] === "Gamma")).toEqual([
      "Gamma",
      "Alpha by B",
      "Beta",
    ]);
  }, 150_000);

  it("a new Task stays in B's note and reaches A", async () => {
    const s = await setup();
    await offlineThenRotation(s, (md) =>
      md.replace(/(- \[ \] Gamma\n(?:\s+<!--[^\n]*\n)?)/, "$1- [ ] Delta new offline\n"),
    );
    expect(tasks(s.b.files.get("B.md") as string)).toContain("Delta new offline");
    expect(await aShows(s.a, s.R, (t) => t.includes("Delta new offline"))).toContain(
      "Delta new offline",
    );
  }, 150_000);

  it("the same title changed by A meanwhile: B's goes to review, never a silent win; Keep sends it", async () => {
    const s = await setup();
    const r64 = s.a.b64(s.R);
    const L = (s.b.files.get("B.md") as string).split("\n");
    const beta = /#task:([0-9a-f-]{36})/.exec(
      L[L.findIndex((l) => l.includes("] Beta")) + 1] ?? "",
    )?.[1];
    expect(beta).toBeDefined();
    await offlineThenRotation(
      s,
      (text) => text.replace("- [ ] Beta", "- [ ] Beta by B offline"),
      async () => {
        await s.a.port.commit(
          r64,
          [{ intent: "task.set_title", id: beta, title: "Beta by A" } as never],
          { operationId: crypto.randomUUID() },
        );
      },
    );
    await waitFor(async () => (s.b.stale.counts(r64).review > 0 ? true : undefined), 45_000);
    expect(s.b.stale.counts(r64)).toEqual({ pending: 0, review: 1 });
    // B's note keeps its text; A's title stays A's until B chooses.
    expect(tasks(s.b.files.get("B.md") as string)).toContain("Beta by B offline");
    expect(await aShows(s.a, s.R, (t) => t.includes("Beta by A"))).toContain("Beta by A");
    const [item] = s.b.stale.review(r64);
    expect(await s.b.stale.resolve(r64, item?.operationId as string, true)).toBe("Sent again.");
    expect(await aShows(s.a, s.R, (t) => t.includes("Beta by B offline"))).toContain(
      "Beta by B offline",
    );
  }, 150_000);
});
