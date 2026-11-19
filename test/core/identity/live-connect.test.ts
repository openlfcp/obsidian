// E-022d1 against the reference server (MVP 0.6 A§4.1, A§4.4): the
// attempt of "Connect Apple Reminders" from start to the bridge's
// registration. The plugin creates C and J; the bridge asks with the
// link's pairing link and scope [C]; the person compares the code and
// says [Yes]; the ticks carry C's initial change, A1–A4 and the approval
// record in C (acknowledged) through, with no cancel on the way.

import { connectionNetwork, principalRefOf, requestPairing } from "@openlfcp/client";
import { type PrincipalId, type ResourceId, toHex } from "@openlfcp/core";
import { decodeControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { identityDocument } from "../../../src/core/identity/document";
import { sleep } from "../../support/lfcp-env";
import {
  type LiveDevices,
  type LiveInstallation,
  serverChain,
  until,
  LiveDevices as World,
} from "../../support/live-devices";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

const skip = liveSkipReason();
let server: LiveServer | undefined;
let world: LiveDevices | undefined;

afterEach(async () => {
  await world?.stop();
  await server?.stop();
  world = undefined;
  server = undefined;
});

const fromHexId = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

async function registered(who: LiveInstallation, R: ResourceId, hex: string): Promise<boolean> {
  return (await serverChain(who, R)).records
    .map((r) => decodeControlRecord(r.signed.bytes).body)
    .some(
      (b) => b.type === "DEVICE_GRANT" && toHex(b.chain.leaf.payload.device.principalId) === hex,
    );
}

it("connects a bridge: code compared, [Yes], A1–A4 with the record in C, registered in C", async (ctx) => {
  if (skip !== null) ctx.skip(`no reference server: ${skip}`);
  server = await startLiveServer();
  world = new World(server.url);
  const mac = await world.installation("Mac");
  await mac.section("Notes");
  const connect = mac.service.connector();

  const attempt = await connect.start("Vault", "MacBook Air");
  expect(attempt.state).toBe("waiting-app");
  const link = await connect.link();
  if (link === null) throw new Error("no link");
  expect(link.startsWith("lfcp-bridge://connect?")).toBe(true);
  const pairing = decodeURIComponent(link.split("#link=")[1] ?? "");
  const C = fromHexId(attempt.c) as ResourceId;

  // The bridge's base installation: kind 1, scope exactly [C], then its callback.
  const bridge = await world.installation("Bridge");
  const c = bridge.runtime.collaborationContext();
  if (c === null) throw new Error("bridge not ready");
  const requested = await requestPairing({
    installation: { signer: c.principal.signer, agreement: c.principal.agreement },
    storage: c.storage,
    secrets: c.secrets,
    network: connectionNetwork({
      now: c.now,
      ...(c.webSocket === undefined ? {} : { webSocket: c.webSocket }),
      timeout: () => sleep(15_000),
    }),
    now: c.now,
    document: identityDocument,
    link: pairing,
    label: "MacBook Air",
    kind: 1,
    scope: [C],
  });
  if (requested.kind !== "requested") throw new Error(JSON.stringify(requested));
  await connect.callback({ event: "request-ready", attempt: attempt.id, vault: "Vault" });
  expect((await connect.attempt())?.state).toBe("confirm-code");
  expect(connect.code()).toBe(requested.fingerprint);

  // [Yes]: no cancel from here on; the ticks carry the phases through.
  await connect.confirm(true);
  expect(await connect.cancel()).toBe(false);
  const done = await until(
    "the bridge approved and registered",
    async () => {
      const a = await connect.tick();
      return a?.state === "registering" ? a : (await sleep(500), undefined);
    },
    120_000,
  );
  expect(done.initialized).toBe(true);

  // A3: approvals[P] in C, origin the attempt, accepted by the server; A4: P registered in C.
  const port = mac.runtime.controlPort(C);
  if (port === undefined) throw new Error("C not open");
  const ref = principalRefOf(fromHexId(bridge.me) as PrincipalId);
  const approval = await until("C synchronised again", () => port.state()?.approvals[ref], 60_000);
  expect(approval).toMatchObject({ role: "base", origin: attempt.id, revoked: false });
  expect(await port.acknowledged("approvals", ref)).toBe(true);
  expect(await registered(mac, C, bridge.me)).toBe(true);
  // Until the bridge writes C as `service`, the attempt is not ready (E-031 writes it).
  expect((await connect.tick())?.state).toBe("registering");
});
