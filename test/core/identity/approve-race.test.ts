// LFCP-04-414c (obsidian#108 CI, ubuntu): an approval stopped with "the
// Control Chain was not stored: CONTROL_HEAD_MISMATCH". The managing device
// registers the new device on each of its sections (registerDevice); the
// server ACKs the record and also hands it to the device's own open session
// of that section, which stores it. When the session's save lands between
// the flow's chain read and its save after the ACK, the flow's local
// compare-and-set fails although the stored chain already holds the record.
// Here a second writer stores the acknowledged record first, every time.

import type { IdentityNetwork } from "@openlfcp/client";
import { loadControlChain, saveControlChain } from "@openlfcp/client";
import { bytesEqual, type ResourceId } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { validateControlChain } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceWorld } from "../../support/device-world";

vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

/** `network`, where each ACKed record of `resource` is stored locally by someone else first. */
function racing(
  network: IdentityNetwork,
  storage: () => LfcpStorage,
  resource: () => ResourceId | undefined,
  raced: { count: number },
): IdentityNetwork {
  return {
    connect: async (signer, url) => {
      const channel = await network.connect(signer, url);
      return {
        ...channel,
        putControl: async (r, expectedHead, record) => {
          const answer = await channel.putControl(r, expectedHead, record);
          const R = resource();
          if (answer.kind !== "ack" || R === undefined || !bytesEqual(r, R)) return answer;
          // The section's session: the pushed record, stored before the flow stores it.
          const local = await loadControlChain(storage(), r);
          if (local?.kind !== "linear" || !bytesEqual(local.state.head, expectedHead))
            return answer;
          const next = validateControlChain([...local.records.map((x) => x.signed.bytes), record]);
          if (next.kind !== "linear") throw new Error("the raced record does not validate");
          const saved = await saveControlChain(storage(), next, local.state.head);
          if (!saved.ok) throw new Error(`the racing save failed: ${saved.reason}`);
          raced.count++;
          return answer;
        },
      };
    },
  };
}

it("an approval whose section chain an open session stored first still completes", async () => {
  world = new DeviceWorld();
  const raced = { count: 0 };
  // Known once A exists and has its section.
  const late: { section?: ResourceId; storage?: LfcpStorage } = {};
  const a = await world.installation({
    connectionNetwork: () =>
      racing(
        world.server.network(),
        () => {
          if (late.storage === undefined) throw new Error("no storage");
          return late.storage;
        },
        () => late.section,
        raced,
      ),
  });
  const ctx = a.runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  late.storage = ctx.storage;
  const b = await world.installation();
  late.section = await a.section("Plans");

  const session = await a.service.startSession("Desk");
  if (session.kind !== "link" || session.result.kind !== "created")
    throw new Error(JSON.stringify(session));
  const requested = await b.service.request(session.result.link, "Phone");
  if (requested.kind !== "requested") throw new Error(requested.message);
  const reviews = await a.service.requests(session.session);
  if (reviews === null || "kind" in reviews) throw new Error(JSON.stringify(reviews));
  const review = reviews[0];
  if (review === undefined) throw new Error("no request");

  const approved = await a.service.approve(review, "full");
  expect(raced.count).toBeGreaterThan(0);
  expect(approved.kind).toBe("done");
  // Nothing is left for "Finish".
  expect((await a.service.unfinished()).filter((u) => u.kind === "approval")).toEqual([]);
  // The new device finishes its pairing: the section is opened on it.
  const progress = await b.service.progress(requested.operation);
  expect(JSON.stringify(progress)).toContain("Plans");
});
