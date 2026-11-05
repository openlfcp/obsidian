// LFCP-04-413e (status-414 «Найдено, не исправлено» 1–3, decision I17):
// sections a device that is not the first one joins or creates, with the
// SDK's identity flows over the in-memory coordinator. The root, and every
// other device of the person, get them through packages, the roster and the
// upkeep (IDENTITY-PROFILE-01 §6, §7.2, §7.3).

import {
  createResourceAsDevice,
  heldDeks,
  type IdentityFlowOptions,
  syncChain,
} from "@openlfcp/client";
import { dataEpoch, generateResourceId, type ResourceId, toHex } from "@openlfcp/core";
import { InvitationSecret } from "@openlfcp/crypto";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import {
  assembleInviteUri,
  invitationPrincipal,
  sealKeyPackage,
  signControlRecord,
} from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
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
