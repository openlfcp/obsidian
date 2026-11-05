// LFCP-04-413e (status-414 «Найдено, не исправлено» 1–3, decision I17):
// sections a device that is not the first one joins or creates, with the
// SDK's identity flows over the in-memory coordinator. The root, and every
// other device of the person, get them through packages, the roster and the
// upkeep (IDENTITY-PROFILE-01 §6, §7.2, §7.3).

import { createResourceAsDevice } from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceWorld, pair, WORLD_URL } from "../../support/device-world";

// Several installations and a coordinator per test, on the real SDK flows: slower than a unit.
vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

it("a section in the roster that this device lacks is opened by its upkeep", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "full"));
  // B makes a section for the person (§7.3): owned by the root, keyed to it, listed in the roster.
  const made = await createResourceAsDevice({
    ...world.flowOf(b),
    dataProfile: SECTIONS_PROFILE_ID,
    url: WORLD_URL,
    name: "Field notes",
  });
  if (made.kind !== "created") throw new Error(JSON.stringify(made));
  const X = made.resource;
  expect(await a.runtime.hasResource(X)).toBe(false);
  const r = await a.service.upkeep();
  expect(r.opened).toEqual(["Field notes"]);
  expect(r.summary).toContain('Opened on this device: "Field notes".');
  expect((await a.runtime.registry()).map((e) => toHex(e.resourceId))).toContain(toHex(X));
  expect(a.runtime.sectionProfile(X)).toBeDefined();
  // Already here: nothing more to open.
  expect((await a.service.upkeep()).opened).toEqual([]);
});
