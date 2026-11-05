// LFCP-04-413 (review obsidian#107): the roster of a new device list, with
// the SDK's identity flows over the in-memory coordinator. A section that
// holds only its Genesis (hosted, nothing written since) is one of the
// person's sections and reaches the new device.

import { toHex } from "@openlfcp/core";
import { afterEach, expect, it } from "vitest";
import { DeviceWorld, pair } from "../../support/device-world";

let world: DeviceWorld;
afterEach(() => world.stop());

it("a hosted section with only its Genesis is in the roster, and the new device opens it", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  const op = await pair(a, b);
  const view = await b.service.progress(op);
  expect(view.sections).toContainEqual({ name: "Plans", status: "ready" });
  expect((await b.runtime.registry()).map((e) => toHex(e.resourceId))).toContain(toHex(X));
});
