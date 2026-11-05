// IDENTITY draft §7.4 scenarios 1, 2, 12 and 14 against the reference
// server (LFCP-04-414): installations of the plugin pair with a link, open
// every section of the person's roster, and write as one person.

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPreset } from "../../../src/core/identity/pairing-view";
import { authorLabel, shortId } from "../../../src/core/identity/people";
import * as mock from "../../mocks/obsidian";
import {
  type LiveDevices,
  pairDevice,
  settled,
  until,
  LiveDevices as World,
} from "../../support/live-devices";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const skip = liveSkipReason();
let server: LiveServer | undefined;
let world: LiveDevices | undefined;

afterEach(async () => {
  (mock.Platform as { isMobile: boolean }).isMobile = false;
  await world?.stop();
  await server?.stop();
  world = undefined;
  server = undefined;
});

/** The server and the installations of one test; a real skip, with its reason, without a server. */
async function live(ctx: { skip(note?: string): never }): Promise<LiveDevices> {
  if (skip !== null) ctx.skip(`no reference server: ${skip}`);
  server = await startLiveServer();
  world = new World(server.url);
  return world;
}

const ALIAS = (root: string) => ({ [shortId(root)]: "Olga" });

describe("§7.4 scenario 1: Mac → second Mac (Full)", () => {
  it("pairs with Full; every section opens; both write as one person; one human with two devices", async (ctx) => {
    const w = await live(ctx);
    const mac = await w.installation("Mac");
    const plans = await mac.section("Plans");
    const notes = await mac.section("Notes");
    await mac.write(plans, "from the first Mac");

    const second = await w.installation("Mac 2");
    const paired = await pairDevice(mac, second, "full");
    expect(paired.reviewed).toBe(paired.fingerprint);
    const view = await settled(second, paired.operation);
    expect([...view.sections].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "Notes", status: "ready" },
      { name: "Plans", status: "ready" },
    ]);
    // Every section is open here, with what the first Mac wrote.
    expect(second.runtime.sectionProfile(notes)).toBeDefined();
    await until("the first Mac's edit on the second", () =>
      second.texts(plans).includes("from the first Mac"),
    );
    await second.write(plans, "from the second Mac");
    await until("the second Mac's edit on the first", () =>
      mac.texts(plans).includes("from the second Mac"),
    );

    // One author with one alias, on both installations.
    for (const at of [mac, second]) {
      const people = await at.runtime.people(plans);
      expect(authorLabel(people, mac.me, ALIAS(mac.me))).toBe("Olga");
      expect(authorLabel(people, second.me, ALIAS(mac.me))).toMatch(/^Olga \(from /);
    }

    // The access list: one human, with its second device.
    const status = await mac.collab.status(plans);
    const humans = status.participants.filter((p) => p.invitation === undefined);
    expect(humans.map((h) => h.principal)).toEqual([mac.me]);
    expect(humans[0]?.devices?.map((d) => [d.principal, d.status])).toEqual([
      [second.me, "active"],
    ]);
    // Both devices in the device list, on either side.
    for (const at of [mac, second]) {
      const list = await at.service.devices();
      if (list.kind !== "list") throw new Error(list.kind);
      expect(list.current).toBe(true);
      expect(list.rows.map((r) => r.principal).sort()).toEqual([mac.me, second.me].sort());
      expect(list.manages).toBe(true);
    }
  });
});

describe("§7.4 scenario 2: Mac → iPhone (V3)", () => {
  it("offers Edit for the phone; the fingerprints match; the phone reads and stays read-only", async (ctx) => {
    const w = await live(ctx);
    const mac = await w.installation("Mac");
    const plans = await mac.section("Plans");
    await mac.write(plans, "from the Mac");

    // Obsidian on a phone, as the plugin sees it (Platform.isMobile).
    (mock.Platform as { isMobile: boolean }).isMobile = true;
    const phone = await w.installation("iPhone");
    (mock.Platform as { isMobile: boolean }).isMobile = false;

    const session = await mac.service.startSession("Mac");
    if (session.kind !== "link" || session.result.kind !== "created")
      throw new Error(JSON.stringify(session));
    const requested = await phone.service.request(session.result.link, "iPhone");
    if (requested.kind !== "requested") throw new Error(requested.message);
    const reviews = await until("the phone's request", async () => {
      const r = await mac.service.requests(session.session);
      return Array.isArray(r) && r.length > 0 ? r : undefined;
    });
    const review = reviews[0];
    if (review === undefined) throw new Error("no request");
    // The approver compares what both screens show; the phone's preset is Edit.
    expect(review.fingerprint).toBe(requested.fingerprint);
    expect(review.platform).toBe("mobile");
    expect(defaultPreset(review)).toBe("edit");
    const approved = await mac.service.approve(review, defaultPreset(review));
    expect(approved.kind).toBe("done");

    const view = await settled(phone, requested.operation);
    expect(view.sections).toEqual([{ name: "Plans", status: "ready" }]);
    await until("the Mac's edit on the phone", () => phone.texts(plans).includes("from the Mac"));
    // V3: shared sections stay read-only on a phone, whatever the access.
    const access = await phone.runtime.canWriteSection(plans);
    expect(access).toMatchObject({ allowed: false, reason: "read-only" });
    await expect(phone.write(plans, "from the phone")).rejects.toThrow();
    // Edit does not manage devices.
    const list = await phone.service.devices();
    if (list.kind !== "list") throw new Error(list.kind);
    expect(list.manages).toBe(false);
    expect(list.rows.find((r) => r.principal === phone.me)?.thisDevice).toBe(true);
  });
});

describe("§7.4 scenario 12: vault copied to a new machine", () => {
  it("the copy is a new installation with no key; pairing it goes through the link like any device", async (ctx) => {
    const w = await live(ctx);
    const mac = await w.installation("Mac");
    const plans = await mac.section("Plans");
    await mac.write(plans, "before the copy");

    // The vault's files on another machine: no install there (the install ID,
    // its database and its secrets are machine-local, LFCP-059), so a new one.
    const copy = await w.installation("Mac copy");
    expect(copy.me).not.toBe(mac.me);
    expect(await copy.service.identity()).toBeUndefined();
    expect(await copy.runtime.registry()).toEqual([]);
    expect(await copy.runtime.hasResource(plans)).toBe(false);
    // Nothing of the person is there: "Pair this device" is offered, through §4.2.
    expect(await copy.service.pairRefusal()).toBeNull();
    const paired = await pairDevice(mac, copy, "full");
    expect(paired.reviewed).toBe(paired.fingerprint);
    await settled(copy, paired.operation);
    await until("the section on the copy", () => copy.texts(plans).includes("before the copy"));
    const list = await mac.service.devices();
    if (list.kind !== "list") throw new Error(list.kind);
    expect(list.rows.map((r) => r.principal).sort()).toEqual([mac.me, copy.me].sort());
  });
});

describe("§7.4 scenario 14: access change", () => {
  it("a Read device is removed and its replacement paired as Full; history keeps its authors", async (ctx) => {
    const w = await live(ctx);
    const mac = await w.installation("Mac");
    const plans = await mac.section("Plans");
    await mac.write(plans, "by the Mac");
    const reader = await w.installation("Laptop");
    await settled(reader, (await pairDevice(mac, reader, "read")).operation);
    await until("the section on the Read device", () => reader.texts(plans).includes("by the Mac"));
    expect((await reader.runtime.canWriteSection(plans)).allowed).toBe(false);

    // N8: access never changes in place: the device is removed...
    const removal = await mac.service.previewRemoval(reader.me);
    if ("kind" in removal) throw new Error(removal.message);
    expect(removal.blocked).toBeNull();
    const removed = await mac.service.remove(reader.me, 0n, "Laptop");
    expect(removed.kind).toBe("done");
    // ...and a removed installation is not paired again under the same identity.
    expect(await reader.service.pairRefusal()).toContain(
      "This device was removed from your devices",
    );

    // Its replacement (a new installation on that laptop) is paired as Full and writes.
    const full = await w.installation("Laptop again");
    await settled(full, (await pairDevice(mac, full, "full")).operation);
    await full.write(plans, "by the Full device");
    await until("the Full device's edit on the Mac", () =>
      mac.texts(plans).includes("by the Full device"),
    );
    const people = await mac.runtime.people(plans);
    expect(authorLabel(people, mac.me, ALIAS(mac.me))).toBe("Olga");
    expect(authorLabel(people, full.me, ALIAS(mac.me))).toMatch(/^Olga \(from /);
    // The removed device stays the person's in history.
    expect(authorLabel(people, reader.me, ALIAS(mac.me))).toMatch(/^Olga \(from /);
    const status = await mac.collab.status(plans);
    const olga = status.participants.find((p) => p.principal === mac.me);
    expect(new Map(olga?.devices?.map((d) => [d.principal, d.status]))).toEqual(
      new Map([
        [reader.me, "removed"],
        [full.me, "active"],
      ]),
    );
  });
});
