// @vitest-environment happy-dom
// A synced vault whose Shared Tasks data on this device can't be opened
// (obsidian#104: an iPhone on an iCloud vault, "Loading" forever), then
// brought back to the person's sections with the two steps the plugin
// says, against the reference server. The real plugin (E2EVault, sections
// on) shares a section from a note on a Mac. A second device gets the
// vault's files and data.json (what iCloud or Obsidian Sync carries), runs
// once, then loses its secret store: it starts locked ("marker-missing").
// Checked: locked, it can't be paired (the device commands say why and the
// two steps, nothing is reset by itself); after "Create a new identity"
// asked for, it is a new, empty identity that pairs with a link from the
// Mac like any device, gets the section, and its note follows the Mac's
// edits. Without the pairing it would be someone else (no section).

import { type ResourceId, toHex } from "@openlfcp/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { lockedText } from "../../src/core/lfcp/install";
import { parseSections } from "../../src/core/sections/parser";
import { SECTION_NOTE, SoakPeer } from "../soak/peer";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { until } from "../support/e2e-vault";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

const binary = serverBinary();
let server: E2EServer | undefined;
const peers: SoakPeer[] = [];

afterAll(async () => {
  for (const p of peers) await p.vault.close().catch(() => undefined);
  await server?.stop();
});

describe("obsidian#104: a synced vault locked on this device", () => {
  it("can't be paired while locked; a new identity, then the link, makes it one of the person's devices", async (ctx) => {
    if ("skip" in binary) return ctx.skip(`no reference server: ${binary.skip}`);
    server = await startServer(binary.bin);
    const mac = await SoakPeer.open("Mac", "a", server.url, 1);
    peers.push(mac);
    await mac.share(3, ["a"]);
    const ref = parseSections(mac.vault.read(SECTION_NOTE)).sections[0]?.ref.resourceId;
    if (ref === undefined) throw new Error("no section in the note");
    const R = ref as ResourceId;
    const macCtx = mac.runtime.collaborationContext();
    if (macCtx === null) throw new Error("Mac not ready");

    // The phone: the synced vault's files and data.json, its own device-local stores.
    const files = new Map(mac.vault.app.vault.files);
    const data = structuredClone(
      (mac.vault.plugin as unknown as { stored?: unknown }).stored ?? mac.vault.plugin.settings,
    );
    const phone = await SoakPeer.open("Phone", "c", server.url, 3, { files, data });
    peers.push(phone);
    await phone.vault.settle();
    const before = phone.runtime.collaborationContext();
    if (before === null) throw new Error("phone not ready on its first start");
    // Its secret store then loses this vault's slots (the install marker with them).
    await phone.vault.shutdown("clean");
    phone.vault.app.secretStorage = new phone.vault.mock.SecretStorage();
    await phone.vault.boot(false);
    const plugin = phone.vault.plugin;
    expect(phone.runtime.status).toMatchObject({ kind: "locked", reason: "marker-missing" });

    // Locked: no device flow runs, and the commands say why and the two steps.
    const notices = phone.vault.mock.notices;
    notices.length = 0;
    plugin.pairThisDevice();
    expect(notices).toEqual([`Shared Tasks: ${lockedText("marker-missing")}`]);
    expect(notices[0]).toContain('then run "Pair this device with a link…"');
    // Nothing was reset by itself: still locked, the note as synced.
    expect(phone.runtime.status.kind).toBe("locked");
    expect(phone.vault.read(SECTION_NOTE)).toBe(files.get(SECTION_NOTE));

    // Step 1, asked for: a new, empty identity (no section, no device list).
    await plugin.createNewIdentity();
    const fresh = phone.runtime.collaborationContext();
    if (fresh === null) throw new Error("phone not ready after a new identity");
    expect(toHex(fresh.principal.id)).not.toBe(toHex(before.principal.id));
    expect(toHex(fresh.principal.id)).not.toBe(toHex(macCtx.principal.id));
    expect(await phone.runtime.registry()).toEqual([]);
    expect(await phone.runtime.hasResource(R)).toBe(false);
    const service = plugin.deviceService();
    if (service === null) throw new Error("no device service on the phone");
    expect(await service.identity()).toBeUndefined();
    expect(await service.pairRefusal()).toBeNull();

    // Step 2: "Add my other device…" on the Mac, "Pair this device with a link…" here.
    const a = mac.vault.plugin.deviceService();
    if (a === null) throw new Error("no device service on the Mac");
    const session = await a.startSession("Mac");
    if (session.kind !== "link" || session.result.kind !== "created")
      throw new Error(`no link: ${session.kind}`);
    const requested = await service.request(session.result.link, "Phone");
    if (requested.kind !== "requested") throw new Error(requested.message);
    const review = await until("the phone's request on the Mac", async () => {
      const r = await a.requests(session.session);
      return Array.isArray(r) ? r[0] : undefined;
    });
    expect(review.fingerprint).toBe(requested.fingerprint);
    expect((await a.approve(review, "full")).kind).toBe("done");
    const done = await until(
      "the phone paired",
      async () => {
        const v = await service.progress(requested.operation);
        return v.final ? v : undefined;
      },
      120_000,
    );
    expect(done.sections.map((s) => s.status)).toEqual(["ready"]);
    expect(await phone.runtime.hasResource(R)).toBe(true);

    // The synced note's section follows the Mac's edits again.
    await mac.vault.editLine(SECTION_NOTE, "a1 plan item", "a1 plan item, changed on the Mac");
    await until(
      "the Mac's edit on the phone",
      () =>
        phone.vault.read(SECTION_NOTE).includes("a1 plan item, changed on the Mac")
          ? true
          : undefined,
      120_000,
    );
    const sections = parseSections(phone.vault.read(SECTION_NOTE)).sections;
    expect(sections).toHaveLength(1);
    expect(sections[0]?.ref.resourceId).toEqual(R);
  });
});
