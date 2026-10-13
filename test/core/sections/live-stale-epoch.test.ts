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

import { connect, createServer, type Server, type Socket } from "node:net";
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

/** A TCP proxy to the server for one member only: off() drops its connections and refuses new ones. */
async function proxyTo(url: string) {
  const target = new URL(url.replace("ws://", "http://"));
  const sockets = new Set<Socket>();
  let listening: Server | null = null;
  let port = 0;
  const on = () =>
    new Promise<void>((ok) => {
      const s = createServer((c) => {
        const u = connect(Number(target.port), target.hostname);
        sockets.add(c).add(u);
        c.pipe(u).pipe(c);
        const end = () => {
          c.destroy();
          u.destroy();
          sockets.delete(c);
          sockets.delete(u);
        };
        c.on("error", end).on("close", end);
        u.on("error", end).on("close", end);
      });
      listening = s;
      s.listen(port, "127.0.0.1", () => {
        const a = s.address();
        port = typeof a === "object" && a !== null ? a.port : 0;
        ok();
      });
    });
  const off = () =>
    new Promise<void>((ok) => {
      for (const x of sockets) x.destroy();
      if (listening === null) ok();
      else listening.close(() => ok());
    });
  await on();
  return { url: `ws://127.0.0.1:${port}${target.pathname}`, on, off };
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

/** A owns [Alpha, Beta, Gamma]; B (behind its proxy) and C are members; B has one accepted edit. */
async function setup() {
  const a = await peer(server.url);
  const proxy = await proxyTo(server.url);
  const b = await peer(proxy.url);
  const c = await peer(server.url);
  stopping.push(a, b, c);
  a.files.set("A.md", ["## Plan", "", "- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", ""].join("\n"));
  const { resource: R } = await a.share("A.md", "## Plan");
  const link = async () => (await a.collab.invite(R, "read-write")).link.reveal();
  b.files.set("B.md", ["# B", "", "Insert below.", ""].join("\n"));
  await b.joinAndInsert(
    (await link()).replace(encodeURIComponent(server.url), encodeURIComponent(proxy.url)),
    "B.md",
    3,
  );
  c.files.set("C.md", ["# C", "", "Insert below.", ""].join("\n"));
  await c.joinAndInsert(await link(), "C.md", 3);
  b.files.set("B.md", (b.files.get("B.md") as string).replace("- [ ] Alpha", "- [ ] Alpha by B"));
  await b.pass("B.md");
  await waitFor(async () =>
    JSON.stringify(a.runtime.sectionProfile(R)?.replica.toJSON()).includes("Alpha by B")
      ? true
      : undefined,
  );
  return { a, b, c, R, proxy };
}

/** B edits offline (`edit`, one pass); A removes C meanwhile; B comes back. */
async function offlineThenRotation(
  s: Awaited<ReturnType<typeof setup>>,
  edit: (md: string) => string,
) {
  const { a, b, c, R, proxy } = s;
  await proxy.off();
  await new Promise((r) => setTimeout(r, 1500));
  b.files.set("B.md", edit(b.files.get("B.md") as string));
  await b.pass("B.md");
  let removed = await a.runtime.revokeSectionAccess(R, c.principal as never);
  for (let i = 0; i < 40 && removed.kind !== "queued"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    removed = await a.runtime.revokeSectionAccess(R, c.principal as never);
  }
  expect(removed.kind).toBe("queued");
  await new Promise((r) => setTimeout(r, 2000));
  await proxy.on();
  await new Promise((r) => setTimeout(r, 8000));
  for (let i = 0; i < 3; i++) await b.pass("B.md");
  const storage = b.runtime.storage;
  if (storage === null) throw new Error("B's runtime has no storage");
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

// TODO(stale-epoch, beta.15): skipped until sections re-apply stale own
// work (§19.1). Today each case fails as described in the header.
describe.skipIf(skip !== null)("offline work across an unrelated removal (§19.1)", () => {
  it.skip("a title edit stays in B's note and reaches A", async () => {
    const s = await setup();
    const { quarantined } = await offlineThenRotation(s, (md) =>
      md.replace("- [ ] Beta", "- [ ] Beta retitled offline"),
    );
    expect(quarantined.length).toBeGreaterThan(0);
    expect(tasks(s.b.files.get("B.md") as string)).toContain("Beta retitled offline");
    expect(await aShows(s.a, s.R, (t) => t.includes("Beta retitled offline"))).toContain(
      "Beta retitled offline",
    );
  }, 90_000);

  it.skip("a move stays in B's note and reaches A", async () => {
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
  }, 90_000);

  it.skip("a new Task stays in B's note and reaches A", async () => {
    const s = await setup();
    await offlineThenRotation(s, (md) =>
      md.replace(/(- \[ \] Gamma\n(?:\s+<!--[^\n]*\n)?)/, "$1- [ ] Delta new offline\n"),
    );
    expect(tasks(s.b.files.get("B.md") as string)).toContain("Delta new offline");
    expect(await aShows(s.a, s.R, (t) => t.includes("Delta new offline"))).toContain(
      "Delta new offline",
    );
  }, 90_000);
});
