// @vitest-environment happy-dom
// IDENTITY draft §7.4 scenario 12 with a real copy of a vault (LFCP-04-414,
// review obsidian#108 R5). The real plugin (E2EVault, sections on) shares a
// section from a note on the reference server. Its vault is then copied to
// another machine: every vault file (the note with its section binding)
// and the plugin's data.json go along; what the machine keeps outside the
// vault (localStorage with the install ID, secretStorage with the keys,
// IndexedDB) does not. The copy's plugin starts on those files. Checked:
// nothing machine-local is in what was copied; the copy is a new
// installation without any key of the original, its note left as it was;
// paired through the link it gets the section, and the copied note's
// binding then follows the original's edits.

import { type ResourceId, toHex } from "@openlfcp/core";
import { afterAll, describe, expect, it, vi } from "vitest";
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

describe("§7.4 scenario 12: a vault copied to another machine", () => {
  it("is a new installation without the original's keys; paired, its copied note follows the section", async (ctx) => {
    if ("skip" in binary) return ctx.skip(`no reference server: ${binary.skip}`);
    server = await startServer(binary.bin);
    const mac = await SoakPeer.open("Mac", "a", server.url, 1);
    peers.push(mac);
    const { resource } = await mac.share(3, ["a"]);
    const ref = parseSections(mac.vault.read(SECTION_NOTE)).sections[0]?.ref.resourceId;
    if (ref === undefined) throw new Error("no section in the note");
    const R = ref as ResourceId;
    const original = mac.vault.read(SECTION_NOTE);
    expect(original).toContain("a1 plan item");

    // What a copy of the vault folder holds: its files and the plugin's data.json.
    const files = new Map(mac.vault.app.vault.files);
    const data = structuredClone(
      (mac.vault.plugin as unknown as { stored?: unknown }).stored ?? mac.vault.plugin.settings,
    );
    // What the machine keeps outside the vault: the keys (secretStorage), and
    // localStorage (the install ID). None of it is in what is copied.
    const keys = [...mac.vault.app.secretStorage.values.values()].filter((v) => v.length >= 16);
    const local = [...mac.vault.app.local.values()]
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .filter((v) => v.length >= 8);
    expect(keys.length).toBeGreaterThan(0);
    expect(local.length).toBeGreaterThan(0);
    const copied = [...files.values(), JSON.stringify(data)];
    for (const text of copied) {
      for (const k of keys) expect(text.includes(k), "a key in the copied vault").toBe(false);
      for (const l of local)
        expect(text.includes(l), "localStorage in the copied vault").toBe(false);
    }
    const macCtx = mac.runtime.collaborationContext();
    if (macCtx === null) throw new Error("Mac not ready");
    const macMe = toHex(macCtx.principal.id);

    // The other machine: the copied files and data.json, its own machine-local stores.
    const copy = await SoakPeer.open("Mac copy", "c", server.url, 3, { files, data });
    peers.push(copy);
    await copy.vault.settle();
    const copyCtx = copy.runtime.collaborationContext();
    if (copyCtx === null) throw new Error("copy not ready");
    // A new installation: another Principal, none of the original's keys, nothing stored.
    expect(toHex(copyCtx.principal.id)).not.toBe(macMe);
    const copyKeys = new Set(copy.vault.app.secretStorage.values.values());
    for (const k of keys) expect(copyKeys.has(k), "an original key on the copy").toBe(false);
    expect(await copy.runtime.registry()).toEqual([]);
    expect(await copy.runtime.hasResource(R)).toBe(false);
    const service = copy.vault.plugin.deviceService();
    if (service === null) throw new Error("no device service on the copy");
    expect(await service.identity()).toBeUndefined();
    // Its note is kept as copied (binding included): nothing of it is rewritten or lost.
    expect(copy.vault.read(SECTION_NOTE)).toBe(original);
    // Nothing of the person is there: "Pair this device" is offered.
    expect(await service.pairRefusal()).toBeNull();

    // Paired through the link like any device (§4.2).
    const a = mac.vault.plugin.deviceService();
    if (a === null) throw new Error("no device service on the Mac");
    const session = await a.startSession("Mac");
    if (session.kind !== "link" || session.result.kind !== "created")
      throw new Error(`no link: ${session.kind}`);
    const requested = await service.request(session.result.link, "Mac copy");
    if (requested.kind !== "requested") throw new Error(requested.message);
    const review = await until("the copy's request on the Mac", async () => {
      const r = await a.requests(session.session);
      return Array.isArray(r) ? r[0] : undefined;
    });
    expect(review.fingerprint).toBe(requested.fingerprint);
    expect((await a.approve(review, "full")).kind).toBe("done");
    const done = await until(
      "the copy paired",
      async () => {
        const v = await service.progress(requested.operation);
        return v.final ? v : undefined;
      },
      120_000,
    );
    expect(done.sections.map((s) => s.status)).toEqual(["ready"]);
    expect(await copy.runtime.hasResource(R)).toBe(true);
    expect(toHex(copyCtx.principal.id)).not.toBe(macMe);

    // The copied note's binding now follows the section: an edit on the Mac reaches it.
    await mac.vault.editLine(SECTION_NOTE, "a1 plan item", "a1 plan item, changed on the Mac");
    await until(
      "the Mac's edit in the copied note",
      () =>
        copy.vault.read(SECTION_NOTE).includes("a1 plan item, changed on the Mac")
          ? true
          : undefined,
      120_000,
    );
    // Still one copy of the section in the note, bound to the same section.
    const sections = parseSections(copy.vault.read(SECTION_NOTE)).sections;
    expect(sections).toHaveLength(1);
    expect(sections[0]?.ref.resourceId).toEqual(R);
    expect(resource.length).toBeGreaterThan(0);
  });
});
