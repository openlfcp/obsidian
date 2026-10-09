// LFCP-02-110 in the plugin, against the reference server: a claim whose
// answer is lost. The SDK journals it before sending; the plugin then
// joins with the same link without spending it twice, or settles it at the
// next start without the link, or gives it up. Skipped without a server.

import type { ResourceId } from "@openlfcp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { DropTap, isControlPutAck } from "../../support/drop-tap";
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

/** One vault: its device, its local store, and a runtime through `tap`. */
async function vault(tap = new DropTap(), device = new Device(), local = new FakeLocal()) {
  const { webSocket: _offline, ...env } = device.env(local, { tickMs: 20 });
  const runtime = await LfcpRuntime.start({ ...env, webSocket: tap.factory });
  running.push(runtime);
  const collab = new Collaboration(runtime, {
    sleep,
    connectTimeoutMs: 5000,
    joinTimeoutMs: 4000,
  });
  return { runtime, collab, tap, device, local };
}

/** An owner with a hosted collaboration and a one-time invitation to it. */
async function invited() {
  const owner = await vault();
  const created = await owner.collab.create({ name: "Team", server: server.url });
  expect(created.hosting.kind).toBe("hosted");
  const invitation = await owner.collab.invite(created.resourceId, "read-write");
  expect(invitation.confirmed).toBe(true);
  return { R: created.resourceId as ResourceId, link: invitation.link.reveal() };
}

describe.skipIf(skip !== null)("LFCP-02-110 live: a claim whose answer is lost", () => {
  it("joins with the same link again, spending it once", async () => {
    const { R, link } = await invited();
    const member = await vault();
    member.tap.dropNext(isControlPutAck);
    const lost = await member.collab.join(link, { name: "Ours" });
    expect(member.tap.dropped).toBe(1);
    expect(lost).toMatchObject({ kind: "unavailable" });
    expect(lost.kind === "unavailable" && lost.message).toContain("kept on this device");
    expect(await member.collab.pendingJoins()).toEqual([{ resourceId: R, name: "Ours" }]);

    const again = await member.collab.join(link, { name: "Ours" });
    expect(again).toMatchObject({ kind: "joined", abilities: ["data/read", "data/write"] });
    expect(await member.collab.pendingJoins()).toEqual([]);
    expect((await member.runtime.registry()).map((e) => e.localName)).toEqual(["Ours"]);
    // Spent once: another vault is refused.
    const late = await vault();
    expect(await late.collab.join(link, { name: "Late" })).toMatchObject({
      kind: "refused",
      code: "AUTHORIZATION_FAILED",
    });
  }, 60_000);

  it("settles at the next start without the link; or is given up", async () => {
    const { R, link } = await invited();
    const member = await vault();
    member.tap.dropNext(isControlPutAck);
    expect((await member.collab.join(link, { name: "Restarted" })).kind).toBe("unavailable");
    await member.runtime.stop();
    // The next start: the same device and vault, no link.
    const next = await vault(new DropTap(), member.device, member.local);
    expect(await next.collab.pendingJoins()).toEqual([{ resourceId: R, name: "Restarted" }]);
    expect(await next.collab.resumeJoin(R)).toMatchObject({ kind: "joined" });
    expect((await next.runtime.registry()).map((e) => e.localName)).toEqual(["Restarted"]);
    expect(await next.collab.pendingJoins()).toEqual([]);

    // Given up: the journal is dropped, nothing is stored.
    const second = await invited();
    const quitter = await vault();
    quitter.tap.dropNext(isControlPutAck);
    expect((await quitter.collab.join(second.link, { name: "Quit" })).kind).toBe("unavailable");
    await quitter.collab.abandonJoin(second.R);
    expect(await quitter.collab.pendingJoins()).toEqual([]);
    expect(await quitter.runtime.hasResource(second.R)).toBe(false);
  }, 90_000);
});
