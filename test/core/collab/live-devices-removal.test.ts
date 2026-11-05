// IDENTITY draft §7.4 scenarios 4, 5, 10 and 13 against the reference
// server (LFCP-04-414): removing a device, from the person's other
// devices, with what each section's key does and what the removed device
// sees; a managing device lost with the devices it added; a leaked link.

import { toHex } from "@openlfcp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintOf } from "../../../src/core/identity/people";
import {
  invite,
  type LiveDevices,
  type LiveInstallation,
  pairDevice,
  serverChain,
  settled,
  until,
  LiveDevices as World,
} from "../../support/live-devices";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

const skip = liveSkipReason();
let server: LiveServer | undefined;
let world: LiveDevices | undefined;

afterEach(async () => {
  await world?.stop();
  await server?.stop();
  world = undefined;
  server = undefined;
});

async function live(ctx: { skip(note?: string): never }): Promise<LiveDevices> {
  if (skip !== null) ctx.skip(`no reference server: ${skip}`);
  server = await startLiveServer();
  world = new World(server.url);
  return world;
}

const epochs = async (who: LiveInstallation, R: Parameters<typeof serverChain>[1]) =>
  (await serverChain(who, R)).state.epochs.size;

describe("§7.4 scenario 4: lost device", () => {
  it("removed from a Full device: own sections rotate at once, a colleague's when the colleague's client sees it; later edits refused", async (ctx) => {
    const w = await live(ctx);
    const mac = await w.installation("Mac");
    const plans = await mac.section("Plans");
    // A colleague's section the person is a member of (the root joined it).
    const bob = await w.installation("Bob");
    const shared = await bob.section("Shared");
    await invite(bob, mac, shared);
    const mac2 = await w.installation("Mac 2");
    await settled(mac2, (await pairDevice(mac, mac2, "full")).operation);
    const laptop = await w.installation("Laptop");
    await settled(laptop, (await pairDevice(mac, laptop, "full")).operation);
    await laptop.write(plans, "before the loss");
    await laptop.write(shared, "before the loss, shared");
    await until("the laptop's edits on Bob", () =>
      bob.texts(shared).includes("before the loss, shared"),
    );
    const before = { plans: await epochs(mac, plans), shared: await epochs(bob, shared) };

    // The laptop is lost: removed from the second Mac (Full), as lost.
    const preview = await mac2.service.previewRemoval(laptop.me);
    if ("kind" in preview) throw new Error(preview.message);
    expect(preview.blocked).toBeNull();
    // The preview names who closes the colleague's section.
    expect(preview.lines.join(" ")).toContain(
      "changed by your first device or the section's owner",
    );
    expect(preview.lines.join(" ")).toContain('"Bob\'s"');
    const removed = await mac2.service.remove(laptop.me, 1n, "Laptop");
    expect(removed.message).toContain('Removed "Laptop"');
    // What is closed and what awaits a key change, in the result.
    expect(removed.message).toMatch(
      /The key of "Bob's" is changed by your first device or the section's owner/,
    );
    expect(removed.message).not.toMatch(/The key of [^.]*"Plans"/);

    // Own section: rotated at once. The colleague's: not yet.
    expect(await epochs(mac, plans)).toBe(before.plans + 1);
    expect(await epochs(bob, shared)).toBe(before.shared);
    // The colleague's client sees the exposing revocation and changes the key.
    const upkeep = await bob.service.upkeep(true);
    expect(upkeep.rotations.map((r) => r.status)).toContain("rotated");
    expect(await epochs(bob, shared)).toBe(before.shared + 1);

    // The lost device's later edits are refused, and reach nobody.
    await laptop.write(plans, "after the loss").catch(() => undefined);
    await until("the server's refusal on the laptop", () =>
      laptop.runtime.refusal(plans)?.code === "AUTHORIZATION_FAILED" ? true : undefined,
    );
    // The first Mac gets the new key from the second (same root) and writes on.
    await until("the new key on the first Mac", async () =>
      (await mac.runtime.canWriteSection(plans)).allowed ? true : undefined,
    );
    await mac.write(plans, "after the removal");
    await until("the Mac's next edit on the second Mac", () =>
      mac2.texts(plans).includes("after the removal"),
    );
    expect(mac.texts(plans)).not.toContain("after the loss");
    expect(mac2.texts(plans)).not.toContain("after the loss");
    // Nothing is left to do on the managing devices.
    for (const m of [mac, mac2]) {
      const left = (await m.service.unfinished()).filter((u) => u.kind === "key");
      expect(left).toEqual([]);
    }
  });
});

describe("§7.4 scenario 5: offline device caught by revocation", () => {
  it("its offline edit is beyond the frontier: kept on it, re-applied from another device; three replicas converge; it shows the removal proven", async (ctx) => {
    const w = await live(ctx);
    const mac = await w.installation("Mac");
    const plans = await mac.section("Plans");
    const bob = await w.installation("Bob");
    await invite(mac, bob, plans);
    const mac2 = await w.installation("Mac 2");
    await settled(mac2, (await pairDevice(mac, mac2, "full")).operation);
    const laptop = await w.installation("Laptop");
    await settled(laptop, (await pairDevice(mac, laptop, "full")).operation);

    // Within the frontier: written online, seen by the others.
    await laptop.write(plans, "online, within the frontier");
    await until("the laptop's online edit on the second Mac", () =>
      mac2.texts(plans).includes("online, within the frontier"),
    );
    // Offline: written, not sent.
    laptop.network.offline = true;
    await laptop.write(plans, "offline, beyond the frontier");
    // Removed from the second Mac while offline: the key changes, the frontier excludes it.
    const before = await epochs(mac, plans);
    const removed = await mac2.service.remove(laptop.me, 1n, "Laptop");
    expect(removed.kind).toBe("done");
    expect(await epochs(mac, plans)).toBe(before + 1);

    // Back online: refused; its edit kept here, unsent, nothing deleted.
    laptop.network.offline = false;
    laptop.runtime.networkBack(true);
    await until("the refusal on the laptop", () =>
      laptop.runtime.refusal(plans)?.code === "AUTHORIZATION_FAILED" ? true : undefined,
    );
    expect(laptop.texts(plans)).toContain("offline, beyond the frontier");
    const status = await laptop.collab.status(plans);
    expect(status.pendingOutbound).toBeGreaterThan(0);
    // Against a server with identity-01, the removal is proven to the device.
    const states = await laptop.service.accessStates();
    expect(states).toEqual([
      { name: "Plans", text: "This device was removed from your identity." },
    ]);

    // Re-applied from another device: the three replicas converge, the offline unit in none.
    await mac2.write(plans, "offline, beyond the frontier (re-applied)");
    for (const r of [mac, mac2, bob])
      await until(`${r.name} converged`, () =>
        r.texts(plans).includes("offline, beyond the frontier (re-applied)"),
      );
    const seen = [mac, mac2, bob].map((r) => [...r.texts(plans)].sort());
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(seen[0]).toContain("online, within the frontier");
    expect(seen[0]).not.toContain("offline, beyond the frontier");
  });
});

describe("§7.4 scenario 10: managing device lost, with the devices it added", () => {
  it("the preview shows the dependent devices and the revoker's own dependency; re-certified, then removed, the dependent device keeps working", async (ctx) => {
    const w = await live(ctx);
    const mac = await w.installation("Mac");
    const plans = await mac.section("Plans");
    const mac2 = await w.installation("Mac 2");
    await settled(mac2, (await pairDevice(mac, mac2, "full")).operation);
    // The second Mac adds two devices: their certificates pass through it.
    const laptop = await w.installation("Laptop");
    await settled(laptop, (await pairDevice(mac2, laptop, "edit")).operation);
    const mac3 = await w.installation("Mac 3");
    await settled(mac3, (await pairDevice(mac2, mac3, "full")).operation);

    // From the third Mac, its own access passes through the lost one: blocked.
    const own = await mac3.service.previewRemoval(mac2.me);
    if ("kind" in own) throw new Error(own.message);
    expect(own.blocked).toContain("This device's own access passes through");
    // From the first: both added devices would stop.
    const preview = await mac.service.previewRemoval(mac2.me);
    if ("kind" in preview) throw new Error(preview.message);
    expect(preview.blocked).toBeNull();
    expect([...preview.suspended].sort()).toEqual([laptop.me, mac3.me].sort());

    // Re-certified from the first device, then removed.
    const recertified = await mac.service.recertify(preview.suspended);
    expect(recertified).not.toContain("not re-certified");
    const again = await mac.service.previewRemoval(mac2.me);
    if ("kind" in again) throw new Error(again.message);
    expect(again.suspended).toEqual([]);
    const removed = await mac.service.remove(mac2.me, 1n, "Mac 2");
    expect(removed.kind).toBe("done");

    // The dependent devices keep working: the laptop gets the new key and writes.
    await until("the new key on the laptop", async () =>
      (await laptop.runtime.canWriteSection(plans)).allowed ? true : undefined,
    );
    await laptop.write(plans, "after the lost Mac's removal");
    await until("the laptop's edit on the first Mac", () =>
      mac.texts(plans).includes("after the lost Mac's removal"),
    );
    const list = await mac3.service.devices();
    if (list.kind !== "list") throw new Error(list.kind);
    expect(new Map(list.rows.map((r) => [r.principal, r.state]))).toEqual(
      new Map([
        [mac.me, "active"],
        [mac2.me, "removed"],
        [laptop.me, "active"],
        [mac3.me, "active"],
      ]),
    );
    expect(list.manages).toBe(true);
  });
});

describe("§7.4 scenario 13: leaked link and double approval", () => {
  it("a foreign fingerprint is rejected: the link closes, the device list's key changes, the stranger holds nothing", async (ctx) => {
    const w = await live(ctx);
    const mac = await w.installation("Mac");
    const plans = await mac.section("Plans");
    const session = await mac.service.startSession("Mac");
    if (session.kind !== "link" || session.result.kind !== "created")
      throw new Error(JSON.stringify(session));
    const I = await mac.service.identity();
    if (I === undefined) throw new Error("no device list");
    const before = await epochs(mac, I);

    // A stranger uses the link first; the person's laptop shows another fingerprint.
    const eve = await w.installation("Eve");
    const stolen = await eve.service.request(session.result.link, "Laptop");
    if (stolen.kind !== "requested") throw new Error(stolen.message);
    const laptop = await w.installation("Laptop");
    const reviews = await until("the request", async () => {
      const r = await mac.service.requests(session.session);
      return Array.isArray(r) && r.length > 0 ? r : undefined;
    });
    expect(reviews.map((r) => toHex(r.device))).toEqual([eve.me]);
    // The approver compares: not the fingerprint the person's laptop shows.
    expect(reviews[0]?.fingerprint).toBe(stolen.fingerprint);
    expect(reviews[0]?.fingerprint).not.toBe(fingerprintOf(laptop.me));
    const rejected = await mac.service.cancel(session.session, reviews[0]?.requestKey);
    expect(rejected).toMatchObject({ kind: "done" });
    expect(rejected.message).toContain("Request rejected. The link no longer works.");
    // The device list's key changed: the stranger's request key had read it.
    expect(await epochs(mac, I)).toBe(before + 1);
    // The stranger: rejected, holding no section and no device list.
    const outcome = await eve.service.progress(stolen.operation);
    expect(outcome.final).toBe(true);
    expect(outcome.approved).toBe(false);
    expect(await eve.runtime.registry()).toEqual([]);
    expect(await eve.runtime.hasResource(plans)).toBe(false);
    expect(await eve.service.identity()).toBeUndefined();
    // The link no longer works for anyone.
    const late = await laptop.service.request(session.result.link, "Laptop");
    expect(late.kind).toBe("stop");
  });

  it("two approvals of two requests of one session: one device is added, the other approval is told superseded", async (ctx) => {
    const w = await live(ctx);
    const mac = await w.installation("Mac");
    await mac.section("Plans");
    const session = await mac.service.startSession("Mac");
    if (session.kind !== "link" || session.result.kind !== "created")
      throw new Error(JSON.stringify(session));
    const laptop = await w.installation("Laptop");
    const desk = await w.installation("Desk");
    const a = await laptop.service.request(session.result.link, "Laptop");
    const b = await desk.service.request(session.result.link, "Desk");
    if (a.kind !== "requested" || b.kind !== "requested") throw new Error("not requested");
    const reviews = await until("both requests", async () => {
      const r = await mac.service.requests(session.session);
      return Array.isArray(r) && r.length === 2 ? r : undefined;
    });
    const laptopReview = reviews.find((r) => toHex(r.device) === laptop.me);
    const deskReview = reviews.find((r) => toHex(r.device) === desk.me);
    if (laptopReview === undefined || deskReview === undefined) throw new Error("no review");
    // Two dialogs of the session approve at once (a second managing device cannot
    // list another device's session: its requests are read from the session's journal).
    const [first, second] = await Promise.all([
      mac.service.approve(laptopReview, "full"),
      mac.service.approve(deskReview, "full"),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["done", "stop"]);
    const loser = first.kind === "stop" ? first : second;
    expect(loser.message).toContain("Another of your devices already answered this request");
    const list = await mac.service.devices();
    if (list.kind !== "list") throw new Error(list.kind);
    const added = list.rows.map((r) => r.principal).filter((p) => p === laptop.me || p === desk.me);
    expect(added).toHaveLength(1);
  });
});
