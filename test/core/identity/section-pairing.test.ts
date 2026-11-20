// E-023 (MVP 0.6 A§4.3, A§5.2, T§3 adversarial pairing): a section's
// installation of LFCP Bridge paired through C, on the SDK's own identity
// flows over the in-memory coordinator, with C stood in by FakeControl (the
// host's side is not merged yet). The bridge asks in I with the link it
// read from `requests/<rid>`; it is approved without the human only when
// its request, `pairing/<rid>` and the session all agree — otherwise J_X is
// cancelled and `cancels/<rid> = {reason: mismatch}` written, nothing granted.

import { loadControlChain, requestPairing } from "@openlfcp/client";
import { type PrincipalId, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { decodeControlRecord, revocationOf } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { ATTEMPT_DEADLINE_MS } from "../../../src/core/identity/connect-attempt";
import { SDK_IDENTITY_FLOWS } from "../../../src/core/identity/flows";
import {
  MAX_SECTIONS,
  pendingConnections,
  SECTIONS_KEY,
  type SectionPairing,
  SectionPairings,
  uuid7,
} from "../../../src/core/identity/section-pairing";
import { DeviceWorld, type Installation } from "../../support/device-world";
import { FakeControl } from "../../support/fake-control";

vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const idOf = (i: Installation) => {
  const p = i.runtime.collaborationContext()?.principal.signer.descriptor.principalId;
  if (p === undefined) throw new Error("not ready");
  return p;
};

const randomId = () => crypto.getRandomValues(new Uint8Array(32)) as ResourceId;

/** The section pairings of installation `a` on its own flows, C stood in by `control`. */
function pairingsOf(a: Installation, control: FakeControl, live?: number) {
  return new SectionPairings({
    flows: SDK_IDENTITY_FLOWS,
    flow: () => world.flowOf(a),
    localState: () => a.runtime.localState,
    control: async () => control,
    identity: async () => {
      const I = await a.service.identity();
      const chain =
        I === undefined ? undefined : await loadControlChain(world.flowOf(a).storage, I);
      if (chain?.kind !== "linear") return null;
      const root = chain.state.owner.principalId;
      return {
        live: live ?? chain.state.liveBound.get(toHex(root)) ?? 0,
        revoked: (J: PrincipalId) => revocationOf(chain.state, root, J) !== undefined,
      };
    },
    exclusive: (work) => a.service.connector().otherDevice(() => work()),
    reserved: async () => [],
    client: { app: "Shared Tasks 0.8.0", protocol: 1 },
  });
}

/** A (root, device list made), section X, C of a bridge (stood in), and its pairings. */
async function setup(o: { readonly live?: number } = {}) {
  world = new DeviceWorld();
  const a = await world.installation();
  const X = await a.section("Home");
  const Y = await a.section("Work");
  // The device list is made with the first link (§5.1); that session stays open (personal).
  const personal = await a.service.startSession("Mac");
  if (personal.kind !== "link") throw new Error(JSON.stringify(personal));
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  const C = randomId();
  const control = new FakeControl(C, idOf(a));
  return { a, X, Y, I, C, control, pairings: pairingsOf(a, control, o.live), personal };
}

type World = Awaited<ReturnType<typeof setup>>;

async function started(w: World) {
  const r = await w.pairings.start(w.C, w.X);
  if (r.kind !== "started") throw new Error(JSON.stringify(r));
  expect(r.pairing.requested).toBe(true);
  const request = w.control.data.requests[r.pairing.rid];
  if (request === undefined) throw new Error("no request in C");
  return { p: r.pairing, link: String(request.args.link) };
}

/** The bridge's new installation D_X asking in I with `scope` (by default [X]). */
async function ask(w: World, link: string, scope: readonly ResourceId[] = [w.X]) {
  const bridge = await world.installation();
  const r = await requestPairing({
    ...world.flowOf(bridge),
    link,
    label: "MacBook Air",
    kind: 1,
    scope,
  });
  if (r.kind !== "requested") throw new Error(JSON.stringify(r));
  return bridge;
}

/** The request under J_X as this device reads it (descriptor, key, code). */
async function review(w: World, p: SectionPairing, who?: Installation) {
  const all = await w.a.service.requests(p.session ?? "");
  if (!Array.isArray(all)) throw new Error(JSON.stringify(all));
  const r = who === undefined ? all[0] : all.find((x) => toHex(x.device) === toHex(idOf(who)));
  if (r === undefined) throw new Error("no request under J_X");
  return r;
}

/** The bridge's `pairing/<rid>` (by `service` unless said otherwise). */
function pairingRecord(
  w: World,
  p: SectionPairing,
  r: { descriptor: string; requestKey: string; fingerprint: string },
  by: { signer: PrincipalId; writerClass: "service" | "personal" | "other" },
) {
  w.control.put(
    "pairing",
    p.rid,
    { descriptor: r.descriptor, principal: r.requestKey, fp: r.fingerprint } as never,
    by,
  );
}

const granted = (R: ResourceId, hex: string) =>
  world.server
    .chain(R)
    .records.map((r) => decodeControlRecord(r.signed.bytes).body)
    .some(
      (b) => b.type === "DEVICE_GRANT" && toHex(b.chain.leaf.payload.device.principalId) === hex,
    );

const stateOf = async (w: World) => (await w.pairings.all())[toHex(w.C)];

/** The A§4.3 step 3 refusal: J_X cancelled, `cancels{mismatch}`, nothing granted. */
async function refused(w: World, p: SectionPairing, bridge: Installation, why: RegExp) {
  const after = (await w.pairings.tick())[toHex(w.C)];
  expect(after?.state).toBe("mismatch");
  expect(after?.message).toMatch(why);
  expect(w.control.data.cancels[p.rid]).toMatchObject({ reason: "mismatch" });
  expect(granted(w.I, toHex(idOf(bridge)))).toBe(false);
  expect(Object.keys(w.control.data.approvals)).toEqual([]);
}

const service = (who: Installation) => ({ signer: idOf(who), writerClass: "service" as const });

it("approves the bridge's section installation without the human when every check holds", async () => {
  const w = await setup();
  const { p, link } = await started(w);
  expect(w.control.data.requests[p.rid]).toMatchObject({
    op: "pair-section",
    binding: toBase64url(w.X),
    client: { app: "Shared Tasks 0.8.0", protocol: 1 },
  });
  // Nothing from the bridge yet: waiting, never a mismatch.
  expect((await w.pairings.tick())[toHex(w.C)]?.state).toBe("pairing");
  const bridge = await ask(w, link);
  expect((await w.pairings.tick())[toHex(w.C)]?.state).toBe("pairing");
  pairingRecord(w, p, await review(w, p), service(bridge));
  const after = (await w.pairings.tick())[toHex(w.C)];
  expect(after?.state).toBe("connected");
  // A3: the section approval record in C, origin rid; A4: registered in X only.
  const ref = Object.keys(w.control.data.approvals)[0] ?? "";
  expect(w.control.data.approvals[ref]).toMatchObject({
    role: "section",
    resource: toBase64url(w.X),
    origin: p.rid,
  });
  expect(granted(w.I, toHex(idOf(bridge)))).toBe(true);
  expect(granted(w.Y, toHex(idOf(bridge)))).toBe(false);
});

it("T§3: a descriptor in I other than pairing/<rid> is not approved", async () => {
  const w = await setup();
  const { p, link } = await started(w);
  const bridge = await ask(w, link);
  // The record names another device's descriptor (its own request under a personal link).
  // The record names another device's descriptor: its request under the personal link.
  const other = await world.installation();
  const personal = w.personal.kind === "link" ? w.personal : undefined;
  if (personal?.result.kind !== "created") throw new Error("no personal link");
  await other.service.request(personal.result.link, "Phone");
  const foreign = await w.a.service.requests(personal.session);
  const otherDescriptor = Array.isArray(foreign) ? (foreign[0]?.descriptor ?? "") : "";
  expect(otherDescriptor).not.toBe("");
  const r = await review(w, p, bridge);
  expect(otherDescriptor).not.toBe(r.descriptor);
  pairingRecord(w, p, { ...r, descriptor: otherDescriptor }, service(bridge));
  await refused(w, p, bridge, /descriptor in I is not pairing/);
});

it("T§3: pairing/<rid> not written by the service class is not approved", async () => {
  for (const writerClass of ["personal", "other"] as const) {
    const w = await setup();
    const { p, link } = await started(w);
    const bridge = await ask(w, link);
    pairingRecord(w, p, await review(w, p), { signer: idOf(bridge), writerClass });
    await refused(w, p, bridge, /not admitted from C's service class/);
    await world.stop();
  }
});

it("T§3: a request whose scope is not exactly [X] is not approved", async () => {
  const w = await setup();
  const { p, link } = await started(w);
  const bridge = await ask(w, link, [w.Y]);
  pairingRecord(w, p, await review(w, p), service(bridge));
  await refused(w, p, bridge, /scope is not exactly \[X\]/);
  expect(granted(w.Y, toHex(idOf(bridge)))).toBe(false);
});

it("T§3: a request in C naming a J this device did not make for it is never approved", async () => {
  const w = await setup();
  const { p, link } = await started(w);
  // requests/<rid> rewritten to name another J (the personal link): not this pairing's.
  const personalLink =
    w.personal.kind === "link" && w.personal.result.kind === "created"
      ? w.personal.result.link.reveal()
      : "";
  const original = w.control.data.requests[p.rid];
  if (original === undefined) throw new Error("no request");
  w.control.data.requests[p.rid] = { ...original, args: { link: personalLink } };
  const bridge = await ask(w, link);
  pairingRecord(w, p, await review(w, p), service(bridge));
  const after = (await w.pairings.tick())[toHex(w.C)];
  expect(after?.state).toBe("failed");
  expect(after?.message).toMatch(/links another pairing device/);
  expect(granted(w.I, toHex(idOf(bridge)))).toBe(false);
  expect(Object.keys(w.control.data.approvals)).toEqual([]);
});

it("T§3: a cancelled J_X is not approved", async () => {
  const w = await setup();
  const { p, link } = await started(w);
  expect(await w.pairings.cancel(w.C)).toBe(true);
  expect((await stateOf(w))?.state).toBe("cancelled");
  expect(w.control.data.cancels[p.rid]).toMatchObject({ reason: "user" });
  // The link is dead: the bridge cannot ask, and nothing is approved on a later tick.
  await expect(ask(w, link)).rejects.toThrow();
  await w.pairings.tick();
  expect(Object.keys(w.control.data.approvals)).toEqual([]);
});

it("one open section pairing per bridge, also one another device wrote", async () => {
  const w = await setup();
  const { p } = await started(w);
  const again = await w.pairings.start(w.C, w.Y);
  expect(again.kind).toBe("busy");
  // Another managing device's pending request in C: this one waits too.
  const v = await setup();
  const other = new FakeControl(v.C, idOf(v.a));
  const second = pairingsOf(v.a, other);
  const first = await second.start(v.C, v.X);
  if (first.kind !== "started") throw new Error(JSON.stringify(first));
  // Seen from a fresh journal (another device): the open request in C makes it busy.
  await v.a.runtime.localState.put(SECTIONS_KEY, {});
  expect((await second.start(v.C, v.Y)).kind).toBe("busy");
  // A section pairing's J_X is never handed out as "Add my other device…".
  expect(p.session).toBeDefined();
  const s = await w.a.service.startSession("Desk");
  expect(s.kind === "link" ? s.session : undefined).not.toBe(p.session);
});

it("the local deadline cancels J_X with cancels{expired}", async () => {
  const w = await setup();
  const { p } = await started(w);
  const all = await w.pairings.all();
  await w.a.runtime.localState.put(SECTIONS_KEY, {
    ...all,
    [p.c]: { ...p, createdAt: p.createdAt - ATTEMPT_DEADLINE_MS - 1 },
  });
  expect((await w.pairings.tick())[p.c]?.state).toBe("expired");
  expect(w.control.data.cancels[p.rid]).toMatchObject({ reason: "expired" });
});

it("a cancel cut short is finished after a restart", async () => {
  const w = await setup();
  const { p } = await started(w);
  // C is not reachable: J_X is revoked, cancels/<rid> not written; the journal keeps the cancel.
  w.control.answer = "offline";
  await w.pairings.cancel(w.C);
  expect((await stateOf(w))?.aborting).toBe("cancelled");
  expect(w.control.data.cancels[p.rid]).toBeUndefined();
  // A restart: a new instance on the same local state finishes it.
  w.control.answer = "acknowledged";
  const restarted = pairingsOf(w.a, w.control);
  expect((await restarted.tick())[p.c]?.state).toBe("cancelled");
  expect(w.control.data.cancels[p.rid]).toMatchObject({ reason: "user" });
});

it("capacity: 8 sections per bridge (paused count), and live(I) + 3 ≤ 32", async () => {
  const w = await setup();
  for (let i = 0; i < MAX_SECTIONS; i++)
    w.control.data.approvals[`p:${i}`] = {
      role: "section",
      resource: toBase64url(randomId()),
      revoked: false,
    };
  expect((await w.pairings.start(w.C, w.X)).kind).toBe("sections-full");
  // A removed one (revoked approval) frees its place.
  (w.control.data.approvals["p:0"] as { revoked: boolean }).revoked = true;
  expect((await w.pairings.start(w.C, w.X)).kind).toBe("started");
  await world.stop();
  const v = await setup({ live: 30 });
  expect((await v.pairings.start(v.C, v.X)).kind).toBe("too-many-devices");
  const ok = await setup({ live: 29 });
  expect((await ok.pairings.start(ok.C, ok.X)).kind).toBe("started");
});

it("pending connections: open pair-section requests of root/personal with J_X not revoked", () => {
  const C = randomId();
  const me = randomId() as unknown as PrincipalId;
  const port = new FakeControl(C, me);
  const J = "lfcp://pair/";
  const rid = uuid7(Date.now());
  port.put("requests", rid, { op: "pair-section", binding: "x", args: { link: J } } as never, {
    signer: me,
    writerClass: "root",
  });
  // An unparsable link is never listed.
  expect(pendingConnections(port, () => false)).toEqual([]);
});

it("uuid7: version 7, RFC 9562 variant, time first", () => {
  const a = uuid7(1_700_000_000_000, new Uint8Array(10));
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(uuid7(1_700_000_000_001, new Uint8Array(10)) > a).toBe(true);
});

it("Pending connection [Cancel] on another managing device: J_X revoked, cancels{user}", async () => {
  const w = await setup();
  const { p } = await started(w);
  // Seen from a device whose journal does not hold it (the one that made it is gone).
  await w.a.runtime.localState.put(SECTIONS_KEY, {});
  const id = async () => {
    const chain = await loadControlChain(world.flowOf(w.a).storage, w.I);
    if (chain?.kind !== "linear") throw new Error("no chain");
    return (J: PrincipalId) =>
      revocationOf(chain.state, chain.state.owner.principalId, J) !== undefined;
  };
  const pending = pendingConnections(w.control, await id());
  expect(pending.map((x) => x.rid)).toEqual([p.rid]);
  expect(pending[0]?.binding).toBe(toBase64url(w.X));
  expect(await w.pairings.cancelPending(w.C, pending[0] as never)).toBe(true);
  expect(w.control.data.cancels[p.rid]).toMatchObject({ reason: "user" });
  // The cancel is the request's end: listed no more (also once J_X is revoked).
  expect(pendingConnections(w.control, await id())).toEqual([]);
  delete w.control.data.cancels[p.rid];
  expect(pendingConnections(w.control, await id())).toEqual([]);
});

it("a mismatch whose cancels write is not acknowledged yet is finished on a later tick", async () => {
  const w = await setup();
  const { p, link } = await started(w);
  const bridge = await ask(w, link, [w.Y]);
  pairingRecord(w, p, await review(w, p), service(bridge));
  w.control.answer = "queued";
  expect((await w.pairings.tick())[p.c]?.state).toBe("pairing");
  expect(w.control.data.cancels[p.rid]).toBeUndefined();
  // A restart, C reachable again: the SDK's journal finishes the same cancel.
  w.control.answer = "acknowledged";
  expect((await pairingsOf(w.a, w.control).tick())[p.c]?.state).toBe("mismatch");
  expect(w.control.data.cancels[p.rid]).toMatchObject({ reason: "mismatch" });
  expect(granted(w.I, toHex(idOf(bridge)))).toBe(false);
});

// Round 2 (review of obsidian#123).

/** The journal as a crash between J_X's creation and its record left it (C has no request yet). */
async function crashedBeforeSession(w: World, p: SectionPairing) {
  const { session: _s, requested: _r, ...rest } = p;
  await w.a.runtime.localState.put(SECTIONS_KEY, { [p.c]: rest });
  delete w.control.data.requests[p.rid];
  w.control.creators.delete(`requests/${p.rid}`);
}

const openSessions = async (a: Installation) =>
  (await SDK_IDENTITY_FLOWS.openPairingSessions(world.flowOf(a))).map((s) => s.session);

it("R2-1: past the local deadline a ready answer is not approved: J_X cancelled, cancels{expired}", async () => {
  const w = await setup();
  const { p, link } = await started(w);
  const bridge = await ask(w, link);
  pairingRecord(w, p, await review(w, p), service(bridge));
  await w.a.runtime.localState.put(SECTIONS_KEY, {
    [p.c]: { ...p, createdAt: p.createdAt - ATTEMPT_DEADLINE_MS - 1 },
  });
  expect((await w.pairings.tick())[p.c]?.state).toBe("expired");
  expect(w.control.data.cancels[p.rid]).toMatchObject({ reason: "expired" });
  expect(granted(w.I, toHex(idOf(bridge)))).toBe(false);
  expect(Object.keys(w.control.data.approvals)).toEqual([]);
  expect(await openSessions(w.a)).not.toContain(p.session);
});

it("R2-2: after a crash before J_X was journaled, Add my other device… never hands out J_X", async () => {
  const w = await setup();
  if (w.personal.kind === "link") await w.a.service.cancel(w.personal.session);
  const { p } = await started(w);
  await crashedBeforeSession(w, p);
  const s = await w.a.service.startSession("Desk");
  if (s.kind !== "link") throw new Error(JSON.stringify(s));
  expect(s.session).not.toBe(p.session);
  // J_X is found again (never the personal session made meanwhile).
  expect((await w.pairings.tick())[p.c]?.session).toBe(p.session);
});

it("R2-2: [Cancel] after such a crash revokes J_X too", async () => {
  const w = await setup();
  const { p } = await started(w);
  await crashedBeforeSession(w, p);
  expect(await w.pairings.cancel(w.C)).toBe(true);
  expect((await stateOf(w))?.state).toBe("cancelled");
  expect(await openSessions(w.a)).not.toContain(p.session);
});

it("R2-2: a personal session made while J_X is not made yet is never taken for J_X", async () => {
  const w = await setup();
  if (w.personal.kind === "link") await w.a.service.cancel(w.personal.session);
  // Journaled with its snapshot, then a crash before the SDK made J_X.
  const now = Date.now();
  const rid = uuid7(now);
  const c = toHex(w.C);
  await w.a.runtime.localState.put(SECTIONS_KEY, {
    [c]: {
      rid,
      c,
      binding: toBase64url(w.X),
      createdAt: now,
      state: "pairing",
      sessionsBefore: await openSessions(w.a),
    },
  });
  const s = await w.a.service.startSession("Desk");
  if (s.kind !== "link") throw new Error(JSON.stringify(s));
  expect((await w.pairings.tick())[c]?.session).toBeUndefined();
  // [Cancel] of that pairing leaves the personal link alone.
  expect(await w.pairings.cancel(w.C)).toBe(true);
  expect(await openSessions(w.a)).toContain(s.session);
});

it("R2-3: Pending [Cancel] of another device's request is finished after a restart", async () => {
  const w = await setup();
  const { p } = await started(w);
  await w.a.runtime.localState.put(SECTIONS_KEY, {});
  const chain = await loadControlChain(world.flowOf(w.a).storage, w.I);
  if (chain?.kind !== "linear") throw new Error("no chain");
  const pending = pendingConnections(
    w.control,
    (J) => revocationOf(chain.state, chain.state.owner.principalId, J) !== undefined,
  );
  w.control.answer = "offline";
  expect(await w.pairings.cancelPending(w.C, pending[0] as never)).toBe(false);
  expect(w.control.data.cancels[p.rid]).toBeUndefined();
  w.control.answer = "acknowledged";
  await pairingsOf(w.a, w.control).tick();
  expect(w.control.data.cancels[p.rid]).toMatchObject({ reason: "user" });
});

// Round 3 (arbiter of obsidian#123): request.create accepted in C, `requested` not journaled
// (a crash or a lost ACK), the next start after the local deadline.

async function lostAckPastDeadline(w: World, p: SectionPairing) {
  const { requested: _, ...rest } = p;
  await w.a.runtime.localState.put(SECTIONS_KEY, {
    [p.c]: { ...rest, createdAt: p.createdAt - ATTEMPT_DEADLINE_MS - 1 },
  });
  expect(w.control.data.requests[p.rid]).toBeDefined();
}

it("R3-1: a request accepted in C whose ACK was lost is cancelled in C after the deadline", async () => {
  const w = await setup();
  const { p, link } = await started(w);
  const bridge = await ask(w, link);
  pairingRecord(w, p, await review(w, p), service(bridge));
  await lostAckPastDeadline(w, p);
  const restarted = pairingsOf(w.a, w.control);
  expect((await restarted.tick())[p.c]?.state).toBe("expired");
  expect(w.control.data.cancels[p.rid]).toMatchObject({ reason: "expired" });
  expect(await openSessions(w.a)).not.toContain(p.session);
  expect(granted(w.I, toHex(idOf(bridge)))).toBe(false);
});

it("R3-1: with C unreachable on the first tick, the cancel in C is finished once C is back", async () => {
  const w = await setup();
  const { p } = await started(w);
  await lostAckPastDeadline(w, p);
  w.control.answer = "offline";
  const first = (await pairingsOf(w.a, w.control).tick())[p.c];
  expect(first?.aborting).toBe("expired");
  expect(w.control.data.cancels[p.rid]).toBeUndefined();
  w.control.answer = "acknowledged";
  expect((await pairingsOf(w.a, w.control).tick())[p.c]?.state).toBe("expired");
  expect(w.control.data.cancels[p.rid]).toMatchObject({ reason: "expired" });
});
