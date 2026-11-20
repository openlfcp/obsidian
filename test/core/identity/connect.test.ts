// E-022d1 (MVP 0.6 A§4.1–4.4, T§3 adversarial pairing): the attempt of
// "Connect Apple Reminders" on the SDK's own flows over the in-memory
// coordinator. Callbacks are unauthenticated hints: a forged one approves
// nothing and never touches another attempt; a foreign descriptor under
// the same J shows its own code, and [No] revokes J (I rotated) and
// archives C; after [Yes] there is no cancel. C is never synchronised in
// this world, so [Yes] stops before A1 here (the live test goes on).

import {
  fetchDeks,
  type IdentityFlowOptions,
  loadIdentityDocument,
  requestPairing,
  resourceRef,
  syncChain,
} from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import { decodeControlRecord } from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { ATTEMPT_KEY } from "../../../src/core/identity/connect";
import { ATTEMPT_DEADLINE_MS, type Attempt } from "../../../src/core/identity/connect-attempt";
import { identityDocument } from "../../../src/core/identity/document";
import { DeviceWorld, type Installation, pair, WORLD_URL } from "../../support/device-world";

vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

const me = (i: Installation) =>
  toHex(i.runtime.collaborationContext()?.principal.id ?? new Uint8Array());

/** A, the person's first device with a section, and its attempt waiting for the app. */
async function waiting() {
  world = new DeviceWorld();
  const a = await world.installation();
  await a.section("Plans");
  const connect = a.service.connector();
  const attempt = await connect.start("Vault", "MacBook Air");
  expect(attempt.state).toBe("waiting-app");
  const link = await connect.link();
  if (link === null) throw new Error("no link");
  const pairing = decodeURIComponent(link.split("#link=")[1] ?? "");
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  return { a, connect, attempt, pairing, I, C: attempt.c };
}

/** A bridge's base installation (kind 1, scope [C]) asking with the link. */
async function ask(pairing: string, C: string) {
  const bridge = await world.installation();
  const r = await requestPairing({
    ...world.flowOf(bridge),
    link: pairing,
    label: "MacBook Air",
    kind: 1,
    scope: [Uint8Array.from(Buffer.from(C, "hex")) as ResourceId],
  });
  if (r.kind !== "requested") throw new Error(JSON.stringify(r));
  return { bridge, fingerprint: r.fingerprint };
}

/** Whether I's chain on the server grants device `hex` (no approval happened if not). */
const granted = (I: ResourceId, hex: string) =>
  world.server
    .chain(I)
    .records.map((r) => decodeControlRecord(r.signed.bytes).body)
    .some(
      (b) => b.type === "DEVICE_GRANT" && toHex(b.chain.leaf.payload.device.principalId) === hex,
    );

/** C's roster entry as the server's device list has it. */
async function rosterEntry(a: Installation, I: ResourceId, C: string) {
  const f: IdentityFlowOptions = world.flowOf(a);
  const channel = await f.network.connect(f.installation.signer, WORLD_URL);
  try {
    const chain = await syncChain(f.storage, channel, I);
    const doc = identityDocument(I, chain.state.owner.principalId);
    const deks = await fetchDeks(f.storage, f.secrets, channel, chain, f.installation);
    await loadIdentityDocument({ channel, chain, deks, doc });
    return doc.roster().get(resourceRef(Uint8Array.from(Buffer.from(C, "hex")) as ResourceId));
  } finally {
    channel.close();
  }
}

const epochs = (I: ResourceId) => world.server.chain(I).state.epochs.size;

it("starts: C listed in the roster, J, the link; nothing archived", async () => {
  const { a, attempt, pairing, I, C } = await waiting();
  expect(pairing.startsWith("lfcp://")).toBe(true);
  expect(attempt.j).toMatch(/^[0-9a-f]{64}$/);
  expect(attempt.root).toBe(me(a));
  const entry = await rosterEntry(a, I, C);
  expect(entry?.name).toMatch(/^Reminders bridge · MacBook Air/);
  expect(entry?.archived).not.toBe(true);
});

it("a forged callback approves nothing and never touches another attempt", async () => {
  const { a, connect, attempt, pairing, I, C } = await waiting();
  const at = { attempt: attempt.id, vault: "Vault" };
  // request-ready with no request under J: still waiting.
  await connect.callback({ event: "request-ready", ...at });
  expect((await connect.attempt())?.state).toBe("waiting-app");
  // Another attempt, or another vault: ignored, whatever the event.
  for (const event of ["request-ready", "already-connected", "other-account"] as const) {
    await connect.callback({ event, attempt: "someone-else", vault: "Vault" });
    await connect.callback({ event, attempt: attempt.id, vault: "Other vault" });
  }
  expect((await connect.attempt())?.state).toBe("waiting-app");
  expect((await rosterEntry(a, I, C))?.archived).not.toBe(true);
  // app-ready asks to open the link again; nothing else.
  expect(await connect.callback({ event: "app-ready", ...at })).toEqual({ reopen: true });
  // The bridge's request: the code to compare; still nothing granted.
  const { bridge, fingerprint } = await ask(pairing, C);
  await connect.callback({ event: "request-ready", ...at });
  expect((await connect.attempt())?.state).toBe("confirm-code");
  expect(connect.code()).toBe(fingerprint);
  expect(granted(I, me(bridge))).toBe(false);
});

it("a foreign descriptor under the same J shows its own code; [No] revokes J, rotates I, archives C", async () => {
  const { a, connect, attempt, pairing, I, C } = await waiting();
  // Someone else holds the link and asks first: the code shown is theirs, not the Mac's.
  const foreign = await ask(pairing, C);
  await connect.callback({ event: "request-ready", attempt: attempt.id, vault: "Vault" });
  expect(connect.code()).toBe(foreign.fingerprint);
  const before = epochs(I);
  const after = await connect.confirm(false);
  expect(after?.state).toBe("rejected");
  expect(after?.aborting).toBeUndefined();
  expect(granted(I, me(foreign.bridge))).toBe(false);
  // J was a reader of I: the rotation policy changed I's key (§5.3 step 9).
  expect(epochs(I)).toBe(before + 1);
  expect((await rosterEntry(a, I, C))?.archived).toBe(true);
  // J is gone: the link opens nothing any more.
  expect(await connect.link()).toBeNull();
});

it("two requests under one J: nothing is offered, the attempt is cancelled", async () => {
  const { a, connect, attempt, pairing, I, C } = await waiting();
  const one = await ask(pairing, C);
  const two = await ask(pairing, C);
  await connect.callback({ event: "request-ready", attempt: attempt.id, vault: "Vault" });
  expect((await connect.attempt())?.state).toBe("cancelled");
  expect(granted(I, me(one.bridge)) || granted(I, me(two.bridge))).toBe(false);
  expect((await rosterEntry(a, I, C))?.archived).toBe(true);
});

it("after [Yes] there is no cancel (A§4.4)", async () => {
  const { connect, attempt, pairing, C } = await waiting();
  await ask(pairing, C);
  await connect.callback({ event: "request-ready", attempt: attempt.id, vault: "Vault" });
  expect((await connect.confirm(true))?.state).toBe("committing");
  expect(await connect.cancel()).toBe(false);
  await connect.callback({ event: "already-connected", attempt: attempt.id, vault: "Vault" });
  expect((await connect.tick())?.state).toBe("committing");
});

it("the deadline, [Cancel] and already-connected end it before the consume, C archived", async () => {
  // The local deadline (30 min).
  let w = await waiting();
  const stored = (await w.a.runtime.localState.get(ATTEMPT_KEY)) as Attempt;
  await w.a.runtime.localState.put(ATTEMPT_KEY, {
    ...stored,
    createdAt: stored.createdAt - ATTEMPT_DEADLINE_MS - 1,
  });
  expect((await w.connect.tick())?.state).toBe("expired");
  expect((await rosterEntry(w.a, w.I, w.C))?.archived).toBe(true);
  await world.stop();
  // [Cancel] while the app is awaited.
  w = await waiting();
  expect(await w.connect.cancel()).toBe(true);
  expect((await w.connect.attempt())?.state).toBe("cancelled");
  await world.stop();
  // The bridge says this Mac is already connected: a hint, the safe way out.
  w = await waiting();
  await w.connect.callback({ event: "already-connected", attempt: w.attempt.id, vault: "Vault" });
  expect((await w.connect.attempt())?.state).toBe("already-connected");
  expect((await rosterEntry(w.a, w.I, w.C))?.archived).toBe(true);
});

it("an Edit device may not connect (A§4.1: 12 and 13)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await a.section("Plans");
  await b.service.progress(await pair(a, b, "edit"));
  const attempt = await b.service.connector().start("Vault");
  expect(attempt.state).toBe("insufficient-authority");
  expect(attempt.c).toBe("");
});

it('"Add my other device…" never hands out the attempt\'s J', async () => {
  const { a, attempt } = await waiting();
  const s = await a.service.startSession("Desk");
  if (s.kind !== "link") throw new Error(JSON.stringify(s));
  expect(s.session).not.toBe(attempt.session);
});
