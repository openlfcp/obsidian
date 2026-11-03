// LFCP-04-406 (V_notice) through the runtime and the published SDK 0.2.2:
// a scripted server (the SDK's own server handshake) answers a section's
// open with a chain whose next record is a DEVICE_GRANT. The SDK refuses
// it as any pre-identity client does; the runtime recognises the barrier,
// records "blocked at head H by an unsupported record", the section says
// "update the plugin", and the block survives a restart while offline.

import { type ResourceId, toHex } from "@openlfcp/core";
import { objectId, signObject } from "@openlfcp/wire";
import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal } from "../../support/lfcp-env";
import { ScriptedServer, SCRIPTED_URL as URL } from "../../support/scripted-server";

/**
 * A barrier record at seq 1 the 0.2.2 SDK cannot write: a DEVICE_GRANT (type
 * 9, body {0: h''}), or an OWNER_TRANSFER_COMMIT with field 2 (type 6, body
 * {0: h'', 1: h'', 2: h''}). Deterministic CBOR by hand.
 */
function barrierRecord(
  kind: "grant" | "commit",
  R: ResourceId,
  prev: Uint8Array,
  signer: Parameters<typeof signObject>[1],
) {
  const bstr = (b: Uint8Array) => [0x58, b.length, ...b];
  const payload = Uint8Array.from([
    0xa6, // map(6)
    0x00,
    ...bstr(R),
    0x01,
    0x01, // control_seq 1
    0x02,
    ...bstr(prev),
    0x03,
    kind === "grant" ? 0x09 : 0x06,
    0x04,
    ...bstr(signer.descriptor.principalId),
    0x05,
    ...(kind === "grant" ? [0xa1, 0x00, 0x40] : [0xa3, 0x00, 0x40, 0x01, 0x40, 0x02, 0x40]),
  ]);
  return signObject(payload, signer).bytes;
}

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("a section past its identity barrier (WIRE §100.1, herald)", () => {
  it.each([
    ["a DEVICE_GRANT (the SDK's parser refuses type 9)", "grant", "device-grant"],
    ["a transfer commit with field 2 (MALFORMED_MESSAGE)", "commit", "transfer-device"],
  ] as const)(
    "%s: blocked at its last validated head, kept after a restart",
    async (_, kind, entry) => {
      const device = new Device();
      const local = new FakeLocal();
      let barrier: Uint8Array | null = null;
      const server = new ScriptedServer(() => (barrier === null ? [] : [barrier]));
      const runtime = await LfcpRuntime.start(device.env(local, { webSocket: server.factory }));
      running.push(runtime);
      const R = await runtime.createSectionResource({
        name: "Launch",
        endpoints: [URL],
        coordinatorUrl: URL,
      });
      const head = await runtime.storage?.control.head(R);
      if (head === undefined) throw new Error("no head");
      const ctx = runtime.collaborationContext();
      if (ctx === null) throw new Error("not ready");
      barrier = barrierRecord(kind, R, head.head, ctx.principal.signer);
      expect(runtime.identityBlock(R)).toBeNull();

      await runtime.openSection(R);
      await until(() => runtime.identityBlock(R) !== null);
      expect(server.received).toContain("CONTROL_GET");
      expect(runtime.identityBlock(R)).toMatchObject({
        head: toHex(head.head),
        recordId: toHex(objectId(barrier)),
        seq: "1",
        entry,
      });
      // The stored chain is still the validated prefix: nothing past the barrier was kept.
      expect(
        (await runtime.registry()).find((e) => toHex(e.resourceId) === toHex(R))
          ?.lastKnownControlHead,
      ).toBe(toHex(head.head));
      // Recorded once, with the first head; the record is never applied.
      expect((await runtime.storage?.control.head(R))?.head).toEqual(head.head);

      await runtime.stop();
      running.splice(0);
      // Offline after the restart: nothing is sent, the block is read from local state.
      const again = await LfcpRuntime.start(device.env(local));
      running.push(again);
      expect(again.identityBlock(R)).toMatchObject({
        head: toHex(head.head),
        entry,
      });
    },
  );
});
