// LFCP-04-413 (review obsidian#107 P1-2, P2-3): the device upkeep with the
// SDK's identity flows over the in-memory coordinator. The rotation policy
// of §8.4 (decision I6: the owner rotates after another device's
// DEVICE_REVOKE), and registrations left for later by an approval (§5.3
// step 10, §7.1).

import { syncChain } from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";
import { toHex } from "@openlfcp/core";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceService } from "../../../src/core/identity/service";
import { DeviceWorld, type Installation, pair } from "../../support/device-world";

// Several installations and a coordinator per test, on the real SDK flows: slower than a unit.
vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const epochs = (R: ResourceId) => world.server.chain(R).state.epochs.size;
const me = (i: Installation) =>
  toHex(i.runtime.collaborationContext()?.principal.id ?? new Uint8Array());

/** What the runtime's session does when a section comes live: its chain stored as the server has it. */
async function synced(i: Installation, R: ResourceId): Promise<void> {
  const ctx = i.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  const channel = await world.server
    .network()
    .connect(ctx.principal.signer, "wss://identity.example");
  await syncChain(ctx.storage, channel, R);
}

it("a Full device retires itself; the first device's upkeep changes the keys it could read (P1-2)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  const before = epochs(X);
  // B retires itself: a self-retirement commits the revocations only (§8.2).
  const retired = await b.service.remove(me(b), 0n, "Phone");
  expect(retired.kind).not.toBe("stop");
  expect(epochs(X)).toBe(before);
  // The section's session brings the revocation to A; the upkeep that follows rotates.
  await synced(a, X);
  const r = await a.service.upkeep();
  expect(r.reconciled).toBe(true);
  expect(r.rotations.find((x) => toHex(x.resource) === toHex(X))?.status).toBe("rotated");
  expect(epochs(X)).toBe(before + 1);
  // Nothing more is owed: a second upkeep changes nothing.
  expect((await a.service.unfinished()).filter((u) => u.kind === "key")).toEqual([]);
  await a.service.upkeep();
  expect(epochs(X)).toBe(before + 1);
});

it("a section outside reconciliation is rotated by the device that may change its key (P1-2)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  await b.service.remove(me(b), 0n, "Phone");
  await synced(a, X);
  // The same installation as seen without its device list: the owner of X only.
  const ctx = a.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  const marks = ctx.storage.localMarks;
  const owner = new DeviceService({
    runtime: () => a.runtime,
    context: () => ({
      ...ctx,
      // The same storage, its recorded Identity Resource hidden.
      storage: new Proxy(ctx.storage, {
        get: (target, key) => {
          if (key === "localMarks")
            return {
              get: (k: string) =>
                k === "identity:resource" ? Promise.resolve(undefined) : marks.get(k),
              list: (prefix: string) => marks.list(prefix),
            };
          const v = Reflect.get(target, key, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }),
    }),
    collab: () => a.collab,
    defaultServer: () => "wss://identity.example",
    platform: "desktop",
    sections: true,
    sleep: async () => undefined,
    flows: {
      ...(await import("../../../src/core/identity/flows")).SDK_IDENTITY_FLOWS,
      connectionNetwork: () => world.server.network(),
      reconcileDevices: () => Promise.reject(new Error("no device list here")),
    },
  });
  const before = epochs(X);
  expect((await owner.unfinished()).find((u) => u.kind === "key")?.sections).toEqual(["Plans"]);
  const r = await owner.upkeep();
  expect(r.reconciled).toBe(false);
  expect(r.rotations.map((x) => x.status)).toEqual(["rotated"]);
  expect(epochs(X)).toBe(before + 1);
});

it("a device not added to a section while its server was down is added by the upkeep (P2-3)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  world.server.down.add(toHex(X));
  const op = await pair(a, b, "edit");
  expect((await b.service.progress(op)).sections).toEqual([
    { name: "Plans", status: "unreachable, retrying" },
  ]);
  world.server.down.delete(toHex(X));
  // The managing side shows what is owed, and finishes it.
  const owed = (await a.service.unfinished()).filter((u) => u.kind === "registration");
  expect(owed).toEqual([
    { kind: "registration", operation: "", label: expect.any(String), sections: ["Plans"] },
  ]);
  const r = await a.service.upkeep();
  expect(r.reconciled).toBe(true);
  expect((await a.service.unfinished()).filter((u) => u.kind === "registration")).toEqual([]);
  const view = await b.service.progress(op);
  expect(view.sections).toEqual([{ name: "Plans", status: "ready" }]);
  expect(view.final).toBe(true);
});
