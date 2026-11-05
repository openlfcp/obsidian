// LFCP-04-414, found by the §7.4 scenario 1 against the reference server:
// approving a device adds a DEVICE_GRANT to each open section. The device
// flow saves it into the storage the section's session reads, while the
// server pushes the same record to that session; the session's save then
// lost the race ("the stored Control Head moved during sync") and the
// section stayed in CONTROL_SYNC: the new device's edits never arrived.
// The runtime now opens such a session again from the stored chain.
//
// Against a real server the race is likely, not certain: this test is the
// end-to-end smoke. The regression guard is test/core/lfcp/control-race.test.ts,
// which makes the race happen every time (review obsidian#108 R6).

import { afterEach, expect, it, vi } from "vitest";
import {
  type LiveDevices,
  pairDevice,
  settled,
  until,
  LiveDevices as World,
} from "../../support/live-devices";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const skip = liveSkipReason();
let server: LiveServer | undefined;
let world: LiveDevices | undefined;

afterEach(async () => {
  await world?.stop();
  await server?.stop();
});

it("a section open while a device is approved syncs on: it gets past the device's grant and its edits", async (ctx) => {
  if (skip !== null) ctx.skip(`no reference server: ${skip}`);
  server = await startLiveServer();
  world = new World(server.url);
  const mac = await world.installation("Mac");
  const plans = await mac.section("Plans");
  const errors: string[] = [];
  mac.runtime.on((e) => {
    if (e.type === "error") errors.push(e.code);
  });
  const second = await world.installation("Mac 2");
  const paired = await pairDevice(mac, second, "full");
  await settled(second, paired.operation);
  await second.write(plans, "from the second Mac");
  await until("the second Mac's edit on the first", () =>
    mac.texts(plans).includes("from the second Mac"),
  );
  expect(mac.runtime.phase(plans)).toBe("LIVE");
  // The race, when it happened, was recovered from: the section did not stop on it.
  expect(errors.filter((c) => c !== "CONTROL_HEAD_MISMATCH")).toEqual([]);
});
