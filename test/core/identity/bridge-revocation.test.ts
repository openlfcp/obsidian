// E-024 (MVP 0.6 A§5.3, A§6.3, T§3 "отзыв (R2-1)"): the plugin revokes a
// bridge's installation only by an approval record of this C written by
// root/personal that the SDK's checks admit, for a cause (`lifecycle` of
// this C, or the human's Disconnect). The SDK's identity flows run over the
// in-memory coordinator; C is stood in by FakeControl (the host's C, E-030,
// is not merged yet). A real section installation is paired first (E-023).

import { loadControlChain, principalRefOf, requestPairing } from "@openlfcp/client";
import { type PrincipalId, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { decodeControlRecord, parsePairingUri } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import {
  BridgeRevocations,
  baseConflict,
  DISCONNECT_WAIT_MS,
  REVOCATIONS_KEY,
} from "../../../src/core/identity/bridge-revocation";
import { SDK_IDENTITY_FLOWS } from "../../../src/core/identity/flows";
import { SectionPairings } from "../../../src/core/identity/section-pairing";
import { DeviceWorld, type Installation, pair } from "../../support/device-world";
import { FakeControl } from "../../support/fake-control";

vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
let skew = 0;
afterEach(() => {
  skew = 0;
  return world.stop();
});

const idOf = (i: Installation) => {
  const p = i.runtime.collaborationContext()?.principal.signer.descriptor.principalId;
  if (p === undefined) throw new Error("not ready");
  return p;
};
const randomId = () => crypto.getRandomValues(new Uint8Array(32)) as ResourceId;
const flowOf = (a: Installation) => ({ ...world.flowOf(a), now: () => Date.now() + skew });

function pairingsOf(a: Installation, control: FakeControl) {
  return new SectionPairings({
    flows: SDK_IDENTITY_FLOWS,
    flow: () => flowOf(a),
    localState: () => a.runtime.localState,
    control: async () => control,
    identity: async () => ({ live: 0, revoked: () => false }),
    exclusive: (work) => a.service.connector().otherDevice(() => work()),
    reserved: async () => [],
    client: { app: "Shared Tasks 0.8.0", protocol: 1 },
  });
}

function revocationsOf(a: Installation, controls: readonly FakeControl[]) {
  return new BridgeRevocations({
    flows: SDK_IDENTITY_FLOWS,
    flow: () => flowOf(a),
    localState: () => a.runtime.localState,
    controls: async () => controls,
    identity: async () => {
      const I = await a.service.identity();
      const chain =
        I === undefined ? undefined : await loadControlChain(world.flowOf(a).storage, I);
      if (chain?.kind !== "linear") return null;
      return { root: chain.state.owner.principalId, state: chain.state };
    },
    client: { app: "Shared Tasks 0.8.0", protocol: 1 },
  });
}

const service = (who: Installation) => ({ signer: idOf(who), writerClass: "service" as const });

/** The devices revoked in I with reason 0–2 (J's consume, reason 3, is not one). */
const revokedInI = (I: ResourceId): string[] =>
  world.server
    .chain(I)
    .records.map((r) => decodeControlRecord(r.signed.bytes).body)
    .flatMap((b) =>
      b.type === "DEVICE_REVOKE" && b.reason !== 3n ? [toHex(b.device as PrincipalId)] : [],
    );

/** A (root) with a device list, a personal device B, section X, and C. */
async function setup() {
  world = new DeviceWorld();
  const a = await world.installation();
  const X = await a.section("Home");
  const personal = await a.service.startSession("Mac");
  if (personal.kind !== "link" || personal.result.kind !== "created") throw new Error("no link");
  const b = await world.installation();
  await pair(a, b);
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  const C = randomId();
  const control = new FakeControl(C, idOf(a));
  return {
    a,
    b,
    X,
    I,
    C,
    control,
    J: parsePairingUri(personal.result.link.reveal()).pairingDevice,
  };
}
type World = Awaited<ReturnType<typeof setup>>;

/** The bridge's section installation D_X of `X`, approved through `control` (E-023). */
async function connect(w: World, control: FakeControl, X: ResourceId = w.X) {
  const pairings = pairingsOf(w.a, control);
  const r = await pairings.start(control.resource, X);
  if (r.kind !== "started") throw new Error(JSON.stringify(r));
  const link = String(control.data.requests[r.pairing.rid]?.args.link);
  const bridge = await world.installation();
  const asked = await requestPairing({
    ...world.flowOf(bridge),
    link,
    label: "MacBook Air",
    kind: 1,
    scope: [X],
  });
  if (asked.kind !== "requested") throw new Error(JSON.stringify(asked));
  await pairings.tick();
  const started = (await pairings.all())[toHex(control.resource)];
  const all = await w.a.service.requests(started?.session ?? "");
  const review = Array.isArray(all) ? all[0] : undefined;
  if (review === undefined) throw new Error("no request under J_X");
  control.put(
    "pairing",
    r.pairing.rid,
    {
      descriptor: review.descriptor,
      principal: review.requestKey,
      fp: review.fingerprint,
    } as never,
    service(bridge),
  );
  const after = (await pairings.tick())[toHex(control.resource)];
  if (after?.state !== "connected") throw new Error(JSON.stringify(after));
  const ref = principalRefOf(idOf(bridge));
  const approval = control.data.approvals[ref];
  if (approval === undefined) throw new Error("no approval");
  return { bridge, ref, generation: approval.generation as number };
}

/** An approval record written by root (as A) naming `P`, outside any real pairing. */
function forged(w: World, control: FakeControl, P: PrincipalId, generation = 1) {
  const ref = principalRefOf(P);
  control.put(
    "approvals",
    ref,
    {
      role: "section",
      resource: toBase64url(w.X),
      principal: ref,
      certDigest: toBase64url(new Uint8Array(32)),
      certId: "x",
      generation,
      origin: "x",
      at: "2026-11-20T00:00:00Z",
      revoked: false,
    } as never,
    { signer: idOf(w.a), writerClass: "root" },
  );
}

const lifecycle = (control: FakeControl, X: ResourceId, generation: number, op = "remove") => {
  control.data.lifecycle = {
    op,
    bindings: [{ binding: toBase64url(X), generation }],
    at: "2026-11-20T00:00:00Z",
  };
};

it("lifecycle remove {X, generation}: only the section's installation is revoked, no cascade", async () => {
  const w = await setup();
  const { bridge, ref, generation } = await connect(w, w.control);
  lifecycle(w.control, w.X, generation);
  await revocationsOf(w.a, [w.control]).tick();
  expect(revokedInI(w.I)).toEqual([toHex(idOf(bridge))]);
  expect(w.control.data.approvals[ref]?.revoked).toBe(true);
  // A second tick finds nothing more to revoke.
  await revocationsOf(w.a, [w.control]).tick();
  expect(revokedInI(w.I)).toEqual([toHex(idOf(bridge))]);
  expect(await w.a.runtime.localState.get(REVOCATIONS_KEY)).toEqual({});
});

it("T§3 R2-1: lifecycle naming a personal device, a pairing device, another root → nothing", async () => {
  const w = await setup();
  const stranger = await world.installation();
  forged(w, w.control, idOf(w.b));
  lifecycle(w.control, w.X, 1);
  await revocationsOf(w.a, [w.control]).tick();
  for (const P of [w.J, idOf(stranger), idOf(w.a)]) {
    const other = new FakeControl(randomId(), idOf(w.a));
    forged(w, other, P);
    lifecycle(other, w.X, 1);
    await revocationsOf(w.a, [other]).tick();
  }
  expect(revokedInI(w.I)).toEqual([]);
});

it("T§3 R2-1: a stale generation, another bridge's approval, a service-written approval → nothing", async () => {
  const w = await setup();
  const { generation, bridge } = await connect(w, w.control);
  lifecycle(w.control, w.X, generation + 1);
  // Another bridge's C names X too: the approval is in w.control, not in it.
  const other = new FakeControl(randomId(), idOf(w.a));
  lifecycle(other, w.X, generation);
  await revocationsOf(w.a, [w.control, other]).tick();
  expect(revokedInI(w.I)).toEqual([]);
  // The same approval, had it been written by the service class, is never one either.
  const ref = principalRefOf(idOf(bridge));
  w.control.put("approvals", ref, w.control.data.approvals[ref] as never, service(bridge));
  lifecycle(w.control, w.X, generation);
  await revocationsOf(w.a, [w.control]).tick();
  expect(revokedInI(w.I)).toEqual([]);
});

it("T§3 R2-1: an installation without an approval record (0.5) is never revoked by lifecycle", async () => {
  const w = await setup();
  const { ref, generation } = await connect(w, w.control);
  delete w.control.data.approvals[ref];
  lifecycle(w.control, w.X, generation, "uninstall");
  await revocationsOf(w.a, [w.control]).tick();
  expect(revokedInI(w.I)).toEqual([]);
});

it("two base approvals: the conflict is shown and lifecycle is not acted on", async () => {
  const w = await setup();
  const { generation } = await connect(w, w.control);
  for (const P of [idOf(w.b), w.J]) {
    forged(w, w.control, P);
    const r = principalRefOf(P);
    const a = w.control.data.approvals[r];
    if (a !== undefined) {
      a.role = "base";
      a.resource = toBase64url(w.C);
    }
  }
  expect(baseConflict(w.control)).toBe(true);
  lifecycle(w.control, w.X, generation);
  await revocationsOf(w.a, [w.control]).tick();
  expect(revokedInI(w.I)).toEqual([]);
});

it("Disconnect: remove for each section, then the revocations once applied", async () => {
  const w = await setup();
  const { bridge, ref } = await connect(w, w.control);
  const r = revocationsOf(w.a, [w.control]);
  const d = await r.start(w.control);
  expect(d.state).toBe("removing");
  const rid = d.requests[0]?.rid ?? "";
  expect(w.control.data.requests[rid]).toMatchObject({ op: "remove", binding: toBase64url(w.X) });
  await r.tick();
  expect(revokedInI(w.I)).toEqual([]);
  w.control.put("events", rid, { state: "applied" } as never, service(bridge));
  await r.tick();
  expect((await r.disconnect(toHex(w.C)))?.state).toBe("done");
  expect(revokedInI(w.I)).toEqual([toHex(idOf(bridge))]);
  expect(w.control.data.approvals[ref]?.revoked).toBe(true);
});

it("Disconnect: the Mac does not answer → silent; Disconnect anyway revokes without unbind", async () => {
  const w = await setup();
  const { bridge } = await connect(w, w.control);
  const r = revocationsOf(w.a, [w.control]);
  await r.start(w.control);
  skew = DISCONNECT_WAIT_MS;
  await r.tick();
  expect((await r.disconnect(toHex(w.C)))?.state).toBe("silent");
  expect(revokedInI(w.I)).toEqual([]);
  expect((await r.anyway(w.control))?.state).toBe("done");
  expect(revokedInI(w.I)).toEqual([toHex(idOf(bridge))]);
});

it("an approval.revoke not acknowledged yet is finished on a later tick, with the same at", async () => {
  const w = await setup();
  const { bridge, ref, generation } = await connect(w, w.control);
  lifecycle(w.control, w.X, generation);
  w.control.answer = "queued";
  await revocationsOf(w.a, [w.control]).tick();
  expect(revokedInI(w.I)).toEqual([toHex(idOf(bridge))]);
  expect(w.control.data.approvals[ref]?.revoked).toBe(false);
  w.control.answer = "acknowledged";
  skew = 60_000;
  // A restart: a new instance reads the journal.
  await revocationsOf(w.a, [w.control]).tick();
  expect(w.control.data.approvals[ref]?.revoked).toBe(true);
  expect(revokedInI(w.I)).toEqual([toHex(idOf(bridge))]);
});
