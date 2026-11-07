// LFCP-04-413e (status-414 «Найдено, не исправлено» 1–3, decision I17):
// sections a device that is not the first one joins or creates, with the
// SDK's identity flows over the in-memory coordinator. The root, and every
// other device of the person, get them through packages, the roster and the
// upkeep (IDENTITY-PROFILE-01 §6, §7.2, §7.3).

import {
  createResourceAsDevice,
  heldDeks,
  type IdentityFlowOptions,
  type RosterEntryValue,
  storeDek,
  syncChain,
} from "@openlfcp/client";
import { dataEpoch, generateResourceId, type ResourceId, toHex } from "@openlfcp/core";
import { dekCommitment, generateResourceDEK, InvitationSecret } from "@openlfcp/crypto";
import { PROFILE_ID } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import {
  assembleInviteUri,
  invitationPrincipal,
  sealKeyPackage,
  signControlRecord,
  validateControlChain,
} from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { CollabError } from "../../../src/core/collab/service";
import type { RosterAdd, RosterWriter } from "../../../src/core/identity/roster";
import { DeviceWorld, type Installation, pair, WORLD_URL } from "../../support/device-world";

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

const me = (i: Installation) =>
  toHex(i.runtime.collaborationContext()?.principal.id ?? new Uint8Array());

/** The chain of `R` as the server has it, stored on `i` (what its section session brings). */
async function synced(i: Installation, R: ResourceId) {
  const f: IdentityFlowOptions = world.flowOf(i);
  const channel = await f.network.connect(f.installation.signer, WORLD_URL);
  return syncChain(f.storage, channel, R);
}

/** `owner` invites someone to its section `Y`: a one-time grant, its key package, the link (W §18). */
async function invite(owner: Installation, Y: ResourceId): Promise<string> {
  const f = world.flowOf(owner);
  const chain = await synced(owner, Y);
  const dek = (await heldDeks(f.secrets, chain)).get(String(chain.state.epoch.epoch));
  if (dek === undefined) throw new Error("no key");
  const secret = InvitationSecret.generate();
  const invitee = invitationPrincipal(secret);
  const grant = signControlRecord(
    { resourceId: Y, controlSeq: chain.state.seq + 1n, prevControlId: chain.state.head },
    {
      type: "CAPABILITY_GRANT",
      subject: invitee,
      abilities: [1n, 2n, 11n],
      delegable: [],
      claimLimit: 1n,
    },
    f.installation.signer,
  );
  const ch = await f.network.connect(f.installation.signer, WORLD_URL);
  expect((await ch.putControl(Y, chain.state.head, grant.bytes)).kind).toBe("ack");
  const kp = await sealKeyPackage({
    resourceId: Y,
    epoch: dataEpoch(0n),
    controlHead: grant.recordId,
    recipient: invitee,
    dek,
    signer: f.installation.signer,
  });
  expect((await ch.putKeyPackage(Y, kp.bytes)).kind).toBe("ack");
  return assembleInviteUri({
    resourceId: Y,
    endpoints: [WORLD_URL],
    grantId: grant.recordId,
    secret,
  });
}

it("an invitation accepted on a device that is not the first one is claimed for the root (§7.2)", async () => {
  world = new DeviceWorld();
  const o = await world.installation(); // a colleague, the section's owner
  const a = await world.installation(); // the person's first device (the root)
  const b = await world.installation(); // the person's Full device
  const Y = await o.section("Shared notes");
  await b.service.progress(await pair(a, b, "full"));
  const link = await invite(o, Y);
  const joined = await b.collab.join(link, { name: "Shared notes" });
  expect(joined.kind).toBe("joined");
  // The claim names the root; the device registered itself in the section.
  const state = world.server.chain(Y).state;
  const claims = world.server
    .chain(Y)
    .records.filter((r) => r.body.type === "CAPABILITY_CLAIM")
    .map((r) => (r.body.type === "CAPABILITY_CLAIM" ? toHex(r.body.claimant.principalId) : ""));
  expect(claims).toEqual([me(a)]);
  expect(state.devices.get(me(b))?.registered).toBe(true);
  // The colleague sees one person, with the device inside.
  await synced(o, Y);
  const people = (await o.collab.status(Y)).participants.filter(
    (p) => !p.you && p.invitation === undefined,
  );
  expect(people.map((p) => p.principal)).toEqual([me(a)]);
  expect(people[0]?.devices?.map((d) => d.principal)).toContain(me(b));
  // The root gets the section: its key sealed to the root, listed in the roster, opened by the upkeep.
  const r = await a.service.upkeep();
  expect(r.opened).toEqual(["Shared notes"]);
  expect(a.runtime.sectionProfile(Y)).toBeDefined();
});

it("a Read device does not use the invitation: it cannot list the section for the person (§7.2)", async () => {
  world = new DeviceWorld();
  const o = await world.installation();
  const a = await world.installation();
  const b = await world.installation();
  const Y = await o.section("Shared notes");
  await b.service.progress(await pair(a, b, "read"));
  const joined = await b.collab.join(await invite(o, Y), { name: "Shared notes" });
  expect(joined).toMatchObject({ kind: "refused", code: "NEEDS_WRITER" });
  expect(world.server.chain(Y).records.some((r) => r.body.type === "CAPABILITY_CLAIM")).toBe(false);
  expect(await b.runtime.hasResource(Y)).toBe(false);
});

it("a section created on a device that is not the first one is the root's, and the root reads it (§7.3)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "full"));
  const requested = generateResourceId();
  const create = () =>
    b.collab.createSectionResource({
      name: "Field notes",
      endpoints: [WORLD_URL],
      coordinatorUrl: WORLD_URL,
      resourceId: requested,
    });
  const X = await create();
  // Genesis: owned by the root, with the device's certificate chain (field 5), hosted now.
  const genesis = world.server.chain(X).records[0]?.body;
  expect(genesis?.type).toBe("GENESIS");
  if (genesis?.type !== "GENESIS") throw new Error("no Genesis");
  expect(toHex(genesis.owner.principalId)).toBe(me(a));
  expect(genesis.deviceChain?.leaf.payload.device.principalId).toBeDefined();
  expect(toHex(genesis.deviceChain?.leaf.payload.device.principalId ?? new Uint8Array())).toBe(
    me(b),
  );
  // Stored and opened on B as its own section; the same request finds the same section.
  expect(b.runtime.sectionProfile(X)).toBeDefined();
  expect(toHex(await create())).toBe(toHex(X));
  // The root reads it from the package sealed to it at creation, through the roster and the upkeep.
  expect(
    world.server.packagesOf(X).some((p) => toHex(p.recipient) === me(a) && p.dataEpoch === 0n),
  ).toBe(true);
  expect((await a.service.upkeep()).opened).toEqual(["Field notes"]);
  expect(a.runtime.sectionProfile(X)).toBeDefined();
});

it("an Edit device does not create a section for its root: it says so, nothing is made (§7.3)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "edit"));
  await expect(
    b.collab.createSectionResource({
      name: "Field notes",
      endpoints: [WORLD_URL],
      coordinatorUrl: WORLD_URL,
      resourceId: generateResourceId(),
    }),
  ).rejects.toMatchObject({ code: "NOT_OWNER_ACTING" });
  expect(await b.runtime.registry()).toEqual([]);
});

it("a section the first device creates after pairing is queued for the roster, and listed through the port (item 3)", async () => {
  world = new DeviceWorld();
  const calls: { resource: string; entry: RosterEntryValue }[] = [];
  let answer: RosterAdd = { kind: "unsupported" };
  const roster: RosterWriter = {
    add: async (resource, entry) => {
      calls.push({ resource: toHex(resource), entry });
      return answer;
    },
  };
  const a = await world.installation({}, null, roster);
  const b = await world.installation({}, null, roster);
  await b.service.progress(await pair(a, b, "full"));
  const X = await a.collab.createSectionResource({
    name: "Late",
    endpoints: [WORLD_URL],
    coordinatorUrl: WORLD_URL,
    resourceId: generateResourceId(),
  });
  expect(calls).toEqual([
    {
      resource: toHex(X),
      entry: {
        profile: SECTIONS_PROFILE_ID,
        endpoints: [WORLD_URL],
        coordinator: WORLD_URL,
        name: "Late",
      },
    },
  ]);
  // No SDK call yet: queued, said as unfinished, never "up to date".
  expect((await a.service.unfinished()).find((u) => u.kind === "roster")?.sections).toEqual([
    "Late",
  ]);
  const waiting = await a.service.upkeep(true);
  expect(waiting.summary).toContain('Not on your other devices yet: "Late".');
  expect(waiting.summary).not.toContain("up to date");
  // Once the call exists, the next upkeep lists it, and nothing waits.
  answer = { kind: "added" };
  const listed = await a.service.upkeep(true);
  expect(calls.map((c) => c.resource)).toEqual([toHex(X), toHex(X), toHex(X)]);
  expect((await a.service.unfinished()).filter((u) => u.kind === "roster")).toEqual([]);
  expect(listed.summary).toContain("up to date");
  // A device's own section is listed by the SDK's flow, never through this port.
  const before = calls.length;
  await b.collab.createSectionResource({
    name: "From B",
    endpoints: [WORLD_URL],
    coordinatorUrl: WORLD_URL,
    resourceId: generateResourceId(),
  });
  expect(calls).toHaveLength(before);
});

it("a section the first device creates after pairing reaches the person's other device, through addToRoster (item 3)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "full"));
  const X = await a.collab.createSectionResource({
    name: "Late",
    endpoints: [WORLD_URL],
    coordinatorUrl: WORLD_URL,
    resourceId: generateResourceId(),
  });
  await a.host(X);
  // Listed in the roster when it was made: nothing owed.
  expect((await a.service.unfinished()).filter((u) => u.kind === "roster")).toEqual([]);
  // A's upkeep adds B there and hands it the key (§7.1); B's upkeep opens it.
  await a.service.upkeep(true);
  expect(world.server.chain(X).state.devices.get(me(b))?.registered).toBe(true);
  expect((await b.service.upkeep()).opened).toEqual(["Late"]);
  expect(b.runtime.sectionProfile(X)).toBeDefined();
});

it("a roster section whose opening failed after its row was stored is opened again by the next upkeep (review #109 P2-5)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "full"));
  const made = await createResourceAsDevice({
    ...world.flowOf(b),
    dataProfile: SECTIONS_PROFILE_ID,
    url: WORLD_URL,
    name: "Field notes",
  });
  if (made.kind !== "created") throw new Error(JSON.stringify(made));
  const X = made.resource;
  const open = a.runtime.openSection.bind(a.runtime);
  let calls = 0;
  a.runtime.openSection = (R) => {
    calls++;
    return calls === 1 ? Promise.reject(new CollabError("UNAVAILABLE", "closing")) : open(R);
  };
  expect((await a.service.upkeep()).opened).toEqual([]);
  expect(await a.runtime.hasResource(X)).toBe(true);
  expect(a.runtime.sectionProfile(X)).toBeUndefined();
  expect((await a.service.upkeep()).opened).toEqual(["Field notes"]);
  expect(calls).toBe(2);
  expect(a.runtime.sectionProfile(X)).toBeDefined();
});

it("a section queued while a flush waits for the server stays queued (review #109 P2-4)", async () => {
  world = new DeviceWorld();
  let release: (r: RosterAdd) => void = () => undefined;
  let waiting = false;
  let hold = false;
  const listed: string[] = [];
  const roster: RosterWriter = {
    add: async (resource, entry) => {
      if (entry.name === "Y") return { kind: "unsupported" };
      if (hold) {
        hold = false;
        waiting = true;
        return new Promise<RosterAdd>((r) => {
          release = r;
        });
      }
      listed.push(toHex(resource));
      return listed.length === 1 ? { kind: "unsupported" } : { kind: "added" };
    },
  };
  const a = await world.installation({}, null, roster);
  const b = await world.installation({}, null, roster);
  await b.service.progress(await pair(a, b, "full"));
  const section = (name: string) =>
    a.collab.createSectionResource({
      name,
      endpoints: [WORLD_URL],
      coordinatorUrl: WORLD_URL,
      resourceId: generateResourceId(),
    });
  await section("X");
  // The upkeep's flush waits for the server on X; meanwhile Y is made and queued.
  hold = true;
  const upkeep = a.service.upkeep(true);
  for (let i = 0; i < 200 && !waiting; i++) await new Promise((r) => setTimeout(r, 10));
  expect(waiting).toBe(true);
  const y = section("Y");
  const queued = async () =>
    ((await a.runtime.localState.get("identity-roster-pending")) as string[] | undefined) ?? [];
  for (let i = 0; i < 200 && (await queued()).length < 2; i++)
    await new Promise((r) => setTimeout(r, 10));
  release({ kind: "added" });
  await Promise.all([upkeep, y]);
  expect((await a.service.unfinished()).find((u) => u.kind === "roster")?.sections).toEqual(["Y"]);
});

it("a section whose roster queue entry was lost is recovered from this device's sections (review #109 P2-3)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "full"));
  // The first write of the roster queue fails (a storage error) right after the section is made.
  const put = a.runtime.localState.update.bind(a.runtime.localState);
  let fail = true;
  a.runtime.localState.update = (key, change) => {
    if (fail && key === "identity-roster-pending") {
      fail = false;
      return Promise.reject(new Error("storage closing"));
    }
    return put(key, change);
  };
  const X = await a.collab.createSectionResource({
    name: "Late",
    endpoints: [WORLD_URL],
    coordinatorUrl: WORLD_URL,
    resourceId: generateResourceId(),
  });
  await a.host(X);
  expect(fail).toBe(false);
  // The next upkeep finds X missing from the roster, lists it, and adds B there; B opens it.
  await a.service.upkeep(true);
  expect(world.server.chain(X).state.devices.get(me(b))?.registered).toBe(true);
  expect((await b.service.upkeep()).opened).toEqual(["Late"]);
});

/** The device list's server refuses B's units in the device list (its roster entry), until lifted. */
function refuseRosterUnits(I: ResourceId) {
  world.server.fault = (e) =>
    e.op === "data-unit" && toHex(e.resource) === toHex(I) ? { nack: "QUOTA_EXCEEDED" } : undefined;
  return () => {
    world.server.fault = () => undefined;
  };
}

it("a device's section whose roster entry was refused is owed, and the upkeep lists it for the root (review #109 P2-1, §7.3)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "full"));
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  const lift = refuseRosterUnits(I);
  const X = await b.collab.createSectionResource({
    name: "Field notes",
    endpoints: [WORLD_URL],
    coordinatorUrl: WORLD_URL,
    resourceId: generateResourceId(),
  });
  // Made and keyed, not listed: owed, and the root does not get it yet.
  expect((await b.service.unfinished()).find((u) => u.kind === "roster")?.sections).toEqual([
    "Field notes",
  ]);
  expect((await a.service.upkeep()).opened).toEqual([]);
  lift();
  await b.service.upkeep();
  expect((await b.service.unfinished()).filter((u) => u.kind === "roster")).toEqual([]);
  expect((await a.service.upkeep()).opened).toEqual(["Field notes"]);
  expect(a.runtime.sectionProfile(X)).toBeDefined();
});

it("a device's join whose roster entry was refused is owed, and the upkeep lists it for the root (review #109 P2-1, §7.2)", async () => {
  world = new DeviceWorld();
  const o = await world.installation();
  const a = await world.installation();
  const b = await world.installation();
  const Y = await o.section("Shared notes");
  await b.service.progress(await pair(a, b, "full"));
  const I = await a.service.identity();
  if (I === undefined) throw new Error("no device list");
  const link = await invite(o, Y);
  const lift = refuseRosterUnits(I);
  expect((await b.collab.join(link, { name: "Shared notes" })).kind).toBe("joined");
  expect((await b.service.unfinished()).find((u) => u.kind === "roster")?.sections).toEqual([
    "Shared notes",
  ]);
  lift();
  await b.service.upkeep();
  expect((await a.service.upkeep()).opened).toEqual(["Shared notes"]);
});

const claimed = (R: ResourceId) =>
  world.server.chain(R).records.some((r) => r.body.type === "CAPABILITY_CLAIM");

it("a device's join refuses a link of another kind before the claim: the invitation is not used (review #109 P2-2)", async () => {
  world = new DeviceWorld();
  const o = await world.installation();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "full"));
  // A 0.1 shared Tasks collaboration, joined where only a section is asked for (the pane's join).
  const T = await o.runtime.createResource({
    name: "Old tasks",
    endpoints: [WORLD_URL],
    coordinatorUrl: WORLD_URL,
  });
  await o.host(T);
  const joined = await b.collab.join(await invite(o, T), { name: "Old tasks", accept: "sections" });
  expect(joined).toMatchObject({ kind: "other-profile", profile: PROFILE_ID });
  expect(claimed(T)).toBe(false);
  expect(await b.runtime.hasResource(T)).toBe(false);
});

it("a device's join refuses a section this version cannot open before the claim (review #109 P2-2)", async () => {
  world = new DeviceWorld();
  const o = await world.installation();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "full"));
  // A Resource of a Data Profile this plugin does not know, hosted by O.
  const f = world.flowOf(o);
  const U = generateResourceId();
  const dek = generateResourceDEK();
  const genesis = signControlRecord(
    { resourceId: U, controlSeq: 0n, prevControlId: null },
    {
      type: "GENESIS",
      dataProfile: "org.example.unknown.v1",
      owner: f.installation.signer.descriptor,
      dekCommitment: dekCommitment(U, dataEpoch(0n), dek),
      endpoints: [{ url: WORLD_URL, priority: 0n }],
      coordinatorUrl: WORLD_URL,
    },
    f.installation.signer,
  );
  const start = validateControlChain([genesis.bytes]);
  if (start.kind !== "linear") throw new Error("no Genesis");
  await storeDek(f.storage, f.secrets, start, dataEpoch(0n), dek);
  const ch = await f.network.connect(f.installation.signer, WORLD_URL);
  expect((await ch.host(genesis.bytes)).kind).toBe("ack");
  const joined = await b.collab.join(await invite(o, U), { name: "Unknown" });
  expect(joined).toMatchObject({ kind: "needs-newer-version" });
  expect(claimed(U)).toBe(false);
  expect(await b.runtime.hasResource(U)).toBe(false);
});
