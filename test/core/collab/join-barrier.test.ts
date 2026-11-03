// LFCP-04-406 (V_notice): joining, with a link, a Resource whose chain is
// past an identity barrier (here its Genesis was signed by a person's
// device, field 5). The published SDK 0.2.2 cannot validate that chain, so
// no claim can be made; the join stops as soon as the barrier arrives,
// instead of at its timeout, and says the plugin needs an update, the link
// unused.

import { controlRecordId, generateResourceId } from "@openlfcp/core";
import { InvitationSecret } from "@openlfcp/crypto";
import { assembleInviteUri, signObject } from "@openlfcp/wire";
import { afterEach, describe, expect, it } from "vitest";
import { Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";
import { ScriptedServer, SCRIPTED_URL as URL } from "../../support/scripted-server";

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

describe("a join past an identity barrier (WIRE §100.1, herald)", () => {
  it("a join of a Resource made from a person's device (Genesis field 5) stops at once: update, link unused", async () => {
    const device = new Device();
    const runtime = await LfcpRuntime.start(device.env(new FakeLocal()));
    running.push(runtime);
    const ctx = runtime.collaborationContext();
    if (ctx === null) throw new Error("not ready");
    const R = generateResourceId();
    const bstr = (b: Uint8Array) => [0x58, b.length, ...b];
    // A Genesis whose body carries field 5 (a device certificate chain): closed map, MALFORMED to 0.2.2.
    const payload = Uint8Array.from([
      0xa6,
      0x00,
      ...bstr(R),
      0x01,
      0x00,
      0x02,
      0xf6,
      0x03,
      0x00,
      0x04,
      ...bstr(ctx.principal.signer.descriptor.principalId),
      0x05,
      0xa6,
      ...[0x00, 0x40, 0x01, 0x40, 0x02, 0x40, 0x03, 0x40, 0x04, 0x40, 0x05, 0x40],
    ]);
    const genesis = signObject(payload, ctx.principal.signer).bytes;
    const server = new ScriptedServer(() => [genesis], 0n);
    const joiner = await LfcpRuntime.start(
      device.env(new FakeLocal(), { webSocket: server.factory }),
    );
    running.push(joiner);
    const link = assembleInviteUri({
      resourceId: R,
      endpoints: [URL],
      grantId: controlRecordId(new Uint8Array(32).fill(3)),
      secret: InvitationSecret.generate(),
    });
    const collab = new Collaboration(joiner, { sleep, sections: true, joinTimeoutMs: 30_000 });
    const started = Date.now();
    const outcome = await collab.join(link, { name: "" });
    expect(outcome).toEqual({ kind: "needs-newer-version", resourceId: R });
    // Ended by the barrier, not by the join's 30 s timeout; no claim was proposed.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(server.received).toContain("CONTROL_GET");
    expect(server.received).not.toContain("CONTROL_PUT");
    expect(await joiner.hasResource(R)).toBe(false);
  }, 20_000);
});
