// LFCP-04-414 (review obsidian#108 R3): the device flows against the
// reference server with its OWN per-IP limits (POST-003: 20 new WebSockets
// per IP per minute, a burst of 20), not the lifted ones of the other live
// tests. Every installation of a test connects from 127.0.0.1, as devices
// behind one home or office network do. One Mac pairs a second Mac and then
// removes it, paced as the dialogs pace it: the managing device asks for
// requests every 4 s until one is there, the new device asks for its result
// every 4 s. Each WebSocket opened (sections' sessions and the device flows
// alike) is counted per step, with the ones the server refused before they
// opened; the counts are printed for the report.

import { afterEach, expect, it, vi } from "vitest";
import {
  type LiveDevices,
  type LiveInstallation,
  until,
  LiveDevices as World,
} from "../../support/live-devices";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 });

/** The dialogs' polling interval (src/obsidian/ui/devices.ts POLL_MS). */
const POLL_MS = 4000;
/** How long the person takes to compare the fingerprints and approve. */
const HUMAN_MS = 20_000;

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

it("pairs a second Mac and removes it within the server's default per-IP limits", async (ctx) => {
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

  // "Add my other device…": the warning, the device list, the link.
  const second = await world.installation("Mac 2");
  all.push(second);
  await mac.service.firstPairingWarning();
  const session = await mac.service.startSession("Mac");
  if (session.kind !== "link" || session.result.kind !== "created")
    throw new Error(`no link: ${JSON.stringify(session)}`);
  mark("Mac: Add my other device (warning, device list, link)");

  // "Pair this device with a link…" on the second Mac; from now on its dialog asks
  // for the result every 4 s, until it is final.
  const requested = await second.service.request(session.result.link, "Mac 2");
  if (requested.kind !== "requested") throw new Error(requested.message);
  mark("Mac 2: Pair this device (request)");
  let polls = 0;
  const result = (async () => {
    for (;;) {
      polls++;
      const v = await second.service.progress(requested.operation);
      if (v.final) return v;
      await wait(POLL_MS);
    }
  })();

  // The managing dialog asks every 4 s until the request is there.
  const review = await until(
    "the request on the Mac",
    async () => {
      const r = await mac.service.requests(session.session);
      if (Array.isArray(r) && r.length > 0) return r[0];
      await wait(POLL_MS);
      return undefined;
    },
    120_000,
  );
  mark("Mac: the request shown");
  // The person compares the two fingerprints and chooses the access.
  await wait(HUMAN_MS);
  mark(`the person compares fingerprints (${HUMAN_MS / 1000} s; Mac 2 keeps asking)`);
  const approved = await mac.service.approve(review, "full");
  mark("Mac: approve");
  expect(approved.kind, JSON.stringify(approved)).toBe("done");
  const done = await result;
  mark(`Mac 2: result final, sections open (${polls} progress calls in all)`);
  expect(done.sections).toEqual([{ name: "Plans", status: "ready" }]);

  // "Your devices…" → "Remove device…" (preview, then remove).
  const list = await mac.service.devices();
  if (list.kind !== "list") throw new Error(list.kind);
  const preview = await mac.service.previewRemoval(second.me);
  if ("kind" in preview) throw new Error(preview.message);
  mark("Mac: Your devices, Remove device preview");
  const removed = await mac.service.remove(second.me, 0n, "Mac 2");
  mark("Mac: remove");
  // Its upkeep after the removal, as the plugin runs it when a section comes live.
  await mac.service.upkeep();
  mark("Mac: upkeep");

  const total = steps.reduce((n, s) => n + s.opened, 0);
  // The busiest minute: the most WebSockets opened within any 60 s.
  const times = all.flatMap((i) => i.network.openedAt).sort((a, b) => a - b);
  const busiest = Math.max(
    ...times.map((t, i) => times.slice(i).filter((u) => u - t < 60_000).length),
  );
  const refused = steps.reduce((n, s) => n + s.refused, 0);
  console.log(
    `R3 default limits: ${total} WebSockets opened in ${steps.at(-1)?.seconds} s, at most ${busiest} within 60 s, ${refused} refused before opening\n${steps
      .map((s) => `  ${s.seconds}s\t+${s.opened} opened\t+${s.refused} refused\t${s.step}`)
      .join("\n")}`,
  );
  expect(removed.kind, removed.message).toBe("done");
  expect(refused).toBe(0);
});
