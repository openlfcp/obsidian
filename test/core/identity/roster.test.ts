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

it("the device list is not a section: with no section, the new device lists none (P3)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const opened: string[] = [];
  const open = b.collab.openFromRoster.bind(b.collab);
  b.collab.openFromRoster = async (R, name) => {
    opened.push(toHex(R));
    return open(R, name);
  };
  const op = await pair(a, b);
  const view = await b.service.progress(op);
  expect(view.sections).toEqual([]);
  expect(view.deviceList).toBe("ready");
  expect(opened).toEqual([]);
  expect(await b.runtime.registry()).toEqual([]);
});

it("a section that fails to open here is not success: the request stays resumable and the next try opens it (P2-5)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  const op = await pair(a, b);
  // The section's row is stored, then opening it fails once (a full disk, a closing database).
  const open = b.runtime.openSection.bind(b.runtime);
  let fail = true;
  b.runtime.openSection = (R) => {
    if (fail) {
      fail = false;
      return Promise.reject(new Error("the database is closing"));
    }
    return open(R);
  };
  const first = await b.service.progress(op);
  expect(first.final).toBe(false);
  expect(first.headline).not.toContain("Your sections are on this device");
  expect(first.sections).toEqual([
    { name: "Plans", status: "could not be opened here (the database is closing), retrying" },
  ]);
  // Closed and opened again: the request is still there to resume, though the SDK closed it.
  expect((await b.service.openRequest())?.operation).toBe(op);
  expect(await b.service.pairRefusal()).toBeNull();
  const second = await b.service.progress(op);
  expect(second.final).toBe(true);
  expect(second.sections).toEqual([{ name: "Plans", status: "ready" }]);
  expect(b.runtime.sectionProfile(X)).toBeDefined();
  expect(await b.service.openRequest()).toBeNull();
});
