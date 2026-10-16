// @vitest-environment happy-dom
// LFCP-03-046 (from 041): "Invite collaborator…" waits a few seconds for a
// section's status and access check. The plugin unloading meanwhile ends
// the wait at once, as a refusal the executor shows nowhere: no role dialog
// and no notice after unload. On the real plugin (mock Obsidian, real
// runtime, offline).

import { fromBase64url, type ResourceId } from "@openlfcp/core";
import { afterEach, describe, expect, it } from "vitest";
import { INVITE_STOPPED } from "../../src/core/sections/invite-check";
// The DOM helpers Obsidian adds, local-only sockets, and the mock's gaps for the sections host.
import "../soak/peer";
import { E2EVault } from "../support/e2e-vault";

const SERVER = "ws://127.0.0.1:9/v1/ws";
/** A Resource no section of this vault belongs to: the check waits for its status. */
const R = fromBase64url("yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE") as ResourceId;
type Mock = typeof import("../mocks/obsidian");

const intervals: number[] = [];
function sectionsOn(m: Mock): void {
  const P = m.Plugin.prototype as unknown as Record<string, unknown>;
  P.loadData = async function (this: { stored: unknown }) {
    return this.stored ?? { sectionsDisabled: false, defaultServer: SERVER, settingsVersion: 2 };
  };
  P.register = () => undefined;
  P.registerInterval = (id: number) => {
    intervals.push(id);
    return id;
  };
  P.registerMarkdownPostProcessor = () => undefined;
  const W = m.Workspace.prototype as unknown as Record<string, unknown>;
  W.on = () => ({});
  W.onLayoutReady = (fn: () => void) => fn();
}

let vault: E2EVault | null = null;
afterEach(async () => {
  await vault?.close().catch(() => undefined);
  vault = null;
  for (const id of intervals.splice(0)) window.clearInterval(id);
  E2EVault.onModules = null;
});

describe("the invite check and the plugin's unload (LFCP-03-046)", () => {
  it("unload while the check waits: it ends at once with INVITE_STOPPED", async () => {
    E2EVault.onModules = sectionsOn;
    vault = await E2EVault.open("invite-unload", { tickMs: 50 });
    vault.network.offline = true;
    const sections = vault.plugin.sections;
    if (sections === null) throw new Error("sections off");
    const started = Date.now();
    const check = sections.inviteRefusal(R);
    vault.plugin.onunload();
    expect(await check).toBe(INVITE_STOPPED);
    // Well within the check's own wait (5 s): unload ended it.
    expect(Date.now() - started).toBeLessThan(2000);
    // Asked after unload: the same, at once.
    expect(await sections.inviteRefusal(R)).toBe(INVITE_STOPPED);
  });
});
