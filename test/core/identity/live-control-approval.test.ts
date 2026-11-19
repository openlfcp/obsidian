// E-022c against the reference server (SERVICE-CONTROL-PROFILE-01 §7.1,
// §7.4): the plugin creates a control Resource C and writes its initial
// change; a bridge's base installation asks to pair with scope [C]; the
// plugin approves it with C (phases A1–A4): the approval record
// approvals[P] is written in C and acknowledged by the server before the
// bridge is registered in C. Then C is LIVE and the registration gate of
// the device upkeep lets a kind-1 device of a section through.

import {
  connectionNetwork,
  createServiceControl,
  type IdentityFlowOptions,
  leafPayload,
  principalRefOf,
  requestPairing,
  signChain,
  syncChain,
} from "@openlfcp/client";
import { type PrincipalId, type ResourceId, toHex } from "@openlfcp/core";
import { decodeControlRecord, signControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { identityDocument } from "../../../src/core/identity/document";
import type { ApprovalView } from "../../../src/core/identity/pairing-view";
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

/** The SDK's identity flow options of a live installation (as DeviceService builds them). */
function flowOf(i: LiveInstallation): IdentityFlowOptions {
  const c = i.runtime.collaborationContext();
  if (c === null) throw new Error(`${i.name} is not ready`);
  return {
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
  };
}

/** Whether `R`'s chain on the server registers device `hex`. */
async function registered(who: LiveInstallation, R: ResourceId, hex: string): Promise<boolean> {
  const chain = await serverChain(who, R);
  return chain.records
    .map((r) => decodeControlRecord(r.signed.bytes).body)
    .some(
      (b) => b.type === "DEVICE_GRANT" && toHex(b.chain.leaf.payload.device.principalId) === hex,
    );
}

it("approves a bridge's base installation with its approval record in C, then the gate lets through", async (ctx) => {
  if (skip !== null) ctx.skip(`no reference server: ${skip}`);
  server = await startLiveServer();
  world = new World(server.url);
  const mac = await world.installation("Mac");
  const notes = await mac.section("Notes");
  // The device list comes with the first link ("Add my other device…").
  const session = await mac.service.startSession("Mac");
  if (session.kind !== "link" || session.result.kind !== "created")
    throw new Error(JSON.stringify(session));

  // The plugin creates C (root's own Genesis, listed in the roster) and writes its initial
  // change through the runtime's commit binding of C (§2.2).
  const f = flowOf(mac);
  const created = await createServiceControl({ ...f, url: server.url, mac: "MacBook Air" });
  if (created.kind !== "created") throw new Error(JSON.stringify(created));
  const C = created.resource;
  expect(await mac.runtime.openControl(C, server.url)).toBe(true);
  const port = mac.runtime.controlPort(C);
  if (port === undefined) throw new Error("C not open");
  await until("C LIVE on the Mac", () => mac.runtime.phase(C) === "LIVE" || undefined, 60_000);
  expect(
    (await port.commit([created.initialize], `${created.operation}:initialize`)).kind,
  ).not.toBe("rejected");

  // The bridge's base installation (kind 1) asks with scope exactly [C].
  const bridge = await world.installation("Bridge");
  const requested = await requestPairing({
    ...flowOf(bridge),
    link: session.result.link,
    label: "MacBook Air",
    kind: 1,
    scope: [C],
  });
  if (requested.kind !== "requested") throw new Error(JSON.stringify(requested));
  const review = (
    await until("the bridge's request", async () => {
      const r = await mac.service.requests(session.session);
      return Array.isArray(r) && r.length > 0 ? r : undefined;
    })
  )[0];
  if (review === undefined) throw new Error("no request");
  expect(review.requestedScope.map(toHex)).toEqual([toHex(C)]);
  expect(review.fingerprint).toBe(requested.fingerprint);

  // A1–A4 with C: done once the approval record is acknowledged; "finish" until then.
  let view: ApprovalView = await mac.service.approve(review, "service", [C], {
    resource: C,
    origin: created.initialize.attemptId,
  });
  view = await until(
    "the approval, its record in C acknowledged",
    async () => {
      if (view.kind === "finish")
        view = await mac.service.finishApproval(view.operation, review.label);
      if (view.kind === "stop" || view.kind === "reconfirm") throw new Error(JSON.stringify(view));
      return view.kind === "done" ? view : (await sleep(500), undefined);
    },
    120_000,
  );
  expect(view.kind).toBe("done");

  // A3: approvals[P] in C, written by the Mac (root), accepted by the server.
  const P = bridge.me;
  const ref = principalRefOf(Uint8Array.from(Buffer.from(P, "hex")) as PrincipalId);
  // A4 added the bridge to C's chain: C's session catches up (resync) before it reads again.
  const approval = await until(
    "C synchronised again on the Mac",
    () => port.state()?.approvals[ref],
    60_000,
  );
  expect(approval).toMatchObject({
    role: "base",
    origin: created.initialize.attemptId,
    revoked: false,
  });
  expect(await port.acknowledged("approvals", ref)).toBe(true);
  // A4: the bridge is registered in C (and only there: scope [C]).
  expect(await registered(mac, C, P)).toBe(true);
  expect(await registered(mac, notes, P)).toBe(false);

  // §7.4 live: a kind-1 device D of section Notes, granted in the device list, not named by C.
  // C is synchronised here, so the upkeep's gate lets D's registration through.
  const I = await mac.service.identity();
  if (I === undefined) throw new Error("no device list");
  const other = await world.installation("Phone bridge");
  const d = other.runtime.collaborationContext()?.principal.signer.descriptor ?? null;
  if (d === null) throw new Error("not ready");
  const channel = await f.network.connect(f.installation.signer, server.url);
  try {
    const i0 = await syncChain(f.storage, channel, I);
    const R = i0.state.owner.principalId;
    const grant = signControlRecord(
      { resourceId: I, controlSeq: i0.state.seq + 1n, prevControlId: i0.state.head },
      {
        type: "DEVICE_GRANT",
        root: R,
        chain: signChain(i0.state, f.installation.signer, leafPayload(R, d, 1, [1n, 2n], [notes])),
      },
      f.installation.signer,
    );
    expect((await channel.putControl(I, i0.state.head, grant.bytes)).kind).toBe("ack");
  } finally {
    channel.close();
  }
  const upkeep = await mac.service.upkeep(true);
  expect(upkeep.issues?.filter((i) => i.kind === "deferred")).toEqual([]);
  expect(await registered(mac, notes, other.me)).toBe(true);
});
