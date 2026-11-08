// LFCP-04-414 (review obsidian#108 R3, decision I18): the device flows
// against the reference server with its OWN per-IP limits (POST-003: 20 new
// WebSockets per IP per minute, a burst of 20), not the lifted ones of the
// other live tests. Every installation of the test connects from
// 127.0.0.1, as devices behind one home or office network do.
//
// The case that went over the limit before I18 (33 WebSockets in 25 s, the
// last 5 refused, the removal unfinished): a person adds two devices one
// after the other, 10 s each to compare fingerprints, then removes one.
// The dialogs are paced as the plugin paces them (pacing.ts): the managing
// device asks for requests, and the new device for its result, with the
// backoff of POLL_BACKOFF_MS, from the start when the person acts (the link
// is copied); every connection of an installation's device flows takes a
// token of DEVICE_FLOW_PACING (the device services here are the product's).
// Each WebSocket the installations open (sessions and device flows alike)
// is counted per step, with those refused before opening, and the busiest
// 60 s; the test fails on any refusal.

import { afterEach, expect, it, vi } from "vitest";
import { pollDelay } from "../../../src/core/identity/pacing";
import {
  type LiveDevices,
  type LiveInstallation,
  LiveDevices as World,
} from "../../support/live-devices";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 });

/** How long the person takes to compare the fingerprints and approve. */
const HUMAN_MS = 10_000;

const skip = liveSkipReason();
let server: LiveServer | undefined;
let world: LiveDevices | undefined;

afterEach(async () => {
  await world?.stop();
  await server?.stop();
  world = undefined;
  server = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks `ask` as a dialog does: now, then after the backoff's delays, until it gives a value. */
async function poll<T>(ask: () => Promise<T | undefined>, ms = 300_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (let n = 0; ; n++) {
    const v = await ask();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out asking");
    await wait(pollDelay(n));
  }
}

it("two pairings in a row and a removal stay within the server's default per-IP limits", async (ctx) => {
  if (skip !== null) ctx.skip(`no reference server: ${skip}`);
  server = await startLiveServer({ defaultLimits: true });
  world = new World(server.url);
  const started = Date.now();
  const all: LiveInstallation[] = [];
  const steps: { step: string; seconds: number; opened: number; refused: number }[] = [];
  let seen = { opened: 0, refused: 0 };
  const mark = (step: string) => {
    const now = {
      opened: all.reduce((n, i) => n + i.network.opened, 0),
      refused: all.reduce((n, i) => n + i.network.failed, 0),
    };
    steps.push({
      step,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      opened: now.opened - seen.opened,
      refused: now.refused - seen.refused,
    });
    seen = now;
  };

  const mac = await world.installation("Mac");
  all.push(mac);
  const plans = await mac.section("Plans");
  await mac.write(plans, "from the first Mac");
  mark("Mac: start, a section created and hosted");

  const devices: LiveInstallation[] = [];
  for (const n of [2, 3]) {
    const name = `Device ${n}`;
    // "Add my other device…": the warning (the first time), the device list, the link.
    const device = await world.installation(name);
    all.push(device);
    await mac.service.firstPairingWarning();
    const session = await mac.service.startSession("Mac");
    if (session.kind !== "link" || session.result.kind !== "created")
      throw new Error(`no link: ${JSON.stringify(session)}`);
    mark(`Mac: Add my other device (${name})`);
    // The person copies the link (a user action: the managing dialog asks from 4 s again).
    const review = poll(async () => {
      const r = await mac.service.requests(session.session);
      return Array.isArray(r) && r.length > 0 ? r[0] : undefined;
    });
    // "Pair this device with a link…" on the new device; its dialog asks for the result.
    const requested = await device.service.request(session.result.link, name);
    if (requested.kind !== "requested") throw new Error(requested.message);
    mark(`${name}: Pair this device (request)`);
    let calls = 0;
    const result = poll(async () => {
      calls++;
      const v = await device.service.progress(requested.operation);
      return v.final ? v : undefined;
    });
    const r = await review;
    mark(`Mac: the request shown (${name})`);
    // The person compares the two fingerprints and chooses the access.
    await wait(HUMAN_MS);
    mark(`the person compares fingerprints (${HUMAN_MS / 1000} s)`);
    const approved = await mac.service.approve(r, "full");
    mark(`Mac: approve (${name})`);
    expect(approved.kind, JSON.stringify(approved)).toBe("done");
    const done = await result;
    mark(`${name}: result final, sections open (${calls} progress calls)`);
    expect(done.sections).toEqual([{ name: "Plans", status: "ready" }]);
    devices.push(device);
  }

  // "Your devices…" → "Remove device…" of the first one added (preview, then remove).
  const lost = devices[0] as LiveInstallation;
  const list = await mac.service.devices();
  if (list.kind !== "list") throw new Error(list.kind);
  const preview = await mac.service.previewRemoval(lost.me);
  if ("kind" in preview) throw new Error(preview.message);
  mark("Mac: Your devices, Remove device preview");
  const removed = await mac.service.remove(lost.me, 1n, "Device 2");
  mark("Mac: remove");
  // Its upkeep after the removal, as the plugin runs it when a section comes live.
  await mac.service.upkeep();
  mark("Mac: upkeep");

  const total = steps.reduce((n, s) => n + s.opened, 0);
  const refused = steps.reduce((n, s) => n + s.refused, 0);
  const times = all.flatMap((i) => i.network.openedAt).sort((a, b) => a - b);
  const busiest = Math.max(
    ...times.map((t, i) => times.slice(i).filter((u) => u - t < 60_000).length),
  );
  const paced = all.map(
    (i) =>
      `${i.name}: ${i.service.pacer?.taken ?? 0} paced, waited ${Math.round((i.service.pacer?.waitedMs ?? 0) / 100) / 10} s`,
  );
  console.log(
    `I18 default limits: ${total} WebSockets opened in ${steps.at(-1)?.seconds} s, at most ${busiest} within 60 s, ${refused} refused before opening\n  ${paced.join("; ")}\n${steps
      .map((s) => `  ${s.seconds}s\t+${s.opened} opened\t+${s.refused} refused\t${s.step}`)
      .join("\n")}`,
  );
  expect(removed.kind, removed.message).toBe("done");
  expect(refused).toBe(0);
});
