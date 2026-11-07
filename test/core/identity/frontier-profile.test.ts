// Review obsidian#109b (LFCP-04-413f): the rotation frontier judges each unit
// as its recipients do (W §19, §26.3 rules 6 and 7; IDENTITY-PROFILE-01
// §8.3), with the unit's own Resource and signer. Ported from the
// reviewer's probes (review109b-probes/frontier.test.ts,
// identity-frontier.test.ts), over the in-memory coordinator with the SDK's
// identity flows and the plugin's device service.

import { heldDeks, syncChain } from "@openlfcp/client";
import { actorSequence, type DataUnitId, toHex } from "@openlfcp/core";
import { frameChange } from "@openlfcp/shared-objects";
import { identityCodec } from "@openlfcp/shared-objects/identity";
import {
  SECTIONS_PROFILE_ID,
  SectionReplica,
  SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import {
  checkDataUnit,
  decodeControlRecord,
  hasSequence,
  InMemorySeenUnits,
  parseDataUnit,
  receiveDataUnit,
  sealDataUnit,
} from "@openlfcp/wire";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceWorld, pair, WORLD_URL } from "../../support/device-world";

// Several installations and a coordinator per test, on the real SDK flows: slower than a unit.
vi.setConfig({ testTimeout: 30_000 });

let world: DeviceWorld;
afterEach(() => world.stop());

it("a unit whose change is another actor's stays out of the frontier, and the honest next unit is kept (P1)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  const X = await a.section("Plans");
  await b.service.progress(await pair(a, b, "full"));
  const ac = a.runtime.collaborationContext();
  const bc = b.runtime.collaborationContext();
  if (ac === null || bc === null) throw new Error("not ready");
  const before = world.server.chain(X);
  const dek = (await heldDeks(ac.secrets, before)).get(String(before.state.epoch.epoch));
  if (dek === undefined) throw new Error("no key");
  // A valid section change, in the Automerge actor sequence of `principal`.
  const change = (principal: typeof ac.principal.id) => {
    const replica = SectionReplica.empty({ resource: X, principal });
    const made = replica.commit([
      {
        intent: "section.create",
        sectionId: "0192e4a0-0000-7000-8000-000000000001",
        title: "Valid data",
        createdBy: principal,
      },
    ]);
    if (made === null) throw new Error("no change");
    return frameChange(made.change);
  };
  const wrong = change(bc.principal.id);
  const right = change(ac.principal.id);
  // The receiver's own check: A's unit may carry only A's actor (CHANGE_ACTOR_MISMATCH).
  const bound = new SharedSectionsDataProfile(
    SectionReplica.empty({ resource: X, principal: ac.principal.id }),
  ).codecFor({ resourceId: X, actor: ac.principal.id });
  expect(() => bound.decode(wrong)).toThrow(
    expect.objectContaining({ diagnostic: "CHANGE_ACTOR_MISMATCH" }),
  );
  const seal = (seq: bigint, body: Uint8Array) =>
    sealDataUnit(
      {
        resourceId: X,
        dataEpoch: before.state.epoch.epoch,
        actorSeq: actorSequence(seq),
        prevDataUnitId: null,
        controlHead: before.state.head,
      },
      body,
      dek,
      ac.principal.signer,
    );
  // A/1: signed by A, B's change; A/2: A's change, naming no unit (A/1 is no accepted unit).
  const bad = seal(1n, wrong);
  const good = seal(2n, right);
  const receive = (chain: typeof before, bytes: Uint8Array) =>
    receiveDataUnit(chain, bytes, {
      seen: new InMemorySeenUnits(),
      dek: () => dek,
      profile: bound,
    });
  expect((await receive(before, bad.bytes)).kind).toBe("local-failure");
  expect((await receive(before, good.bytes)).kind).toBe("accepted");
  world.server.inject(X, bad.bytes);
  world.server.inject(X, good.bytes);
  // B retires itself; A's upkeep closes X's epoch.
  await b.service.remove(toHex(bc.principal.id), 0n, "Phone");
  const channel = await world.server.network().connect(ac.principal.signer, WORLD_URL);
  await syncChain(ac.storage, channel, X);
  const r = await a.service.upkeep(true);
  expect(r.rotations.find((x) => toHex(x.resource) === toHex(X))?.status).toBe("rotated");
  const after = world.server.chain(X);
  const last = after.records.at(-1)?.body;
  if (last?.type !== "KEY_EPOCH") throw new Error("no KEY_EPOCH");
  expect(hasSequence(last.finalFrontier, ac.principal.id, 1n)).toBe(false);
  expect(hasSequence(last.finalFrontier, ac.principal.id, 2n)).toBe(true);
  // So the honest unit is still accepted after the rotation, not quarantined beyond the cutoff.
  expect((await receive(after, good.bytes)).kind).toBe("accepted");
});

it("the device list's rotation leaves out a unit the Identity Profile refuses (P2)", async () => {
  world = new DeviceWorld();
  const a = await world.installation();
  const b = await world.installation();
  await b.service.progress(await pair(a, b, "full"));
  const I = await a.service.identity();
  const ac = a.runtime.collaborationContext();
  const bc = b.runtime.collaborationContext();
  if (I === undefined || ac === null || bc === null) throw new Error("not ready");
  const before = world.server.chain(I);
  const dek = (await heldDeks(ac.secrets, before)).get(String(before.state.epoch.epoch));
  if (dek === undefined) throw new Error("no key");
  const hosted = world.server.hosted.get(toHex(I));
  const units = [...(hosted?.units.values() ?? [])]
    .map((u) => parseDataUnit(u))
    .filter((u) => toHex(u.payload.actor) === toHex(bc.principal.id))
    .sort((x, y) => (x.payload.actorSeq < y.payload.actorSeq ? -1 : 1));
  const prev = units.at(-1);
  const seq = (prev?.payload.actorSeq ?? 0n) + 1n;
  // B's next unit in the device list: the right key, but no identity change at all.
  const plaintext = new TextEncoder().encode("not an identity change");
  expect(() => identityCodec.decode(plaintext)).toThrow();
  const junk = sealDataUnit(
    {
      resourceId: I,
      dataEpoch: before.state.epoch.epoch,
      actorSeq: actorSequence(seq),
      prevDataUnitId: (prev?.signed.id ?? null) as DataUnitId | null,
      controlHead: before.state.head,
    },
    plaintext,
    dek,
    bc.principal.signer,
  );
  expect((await checkDataUnit(before, junk.bytes, new InMemorySeenUnits())).kind).toBe("valid");
  // It reaches the server after the roster was read, while A commits B's removal.
  let injected = false;
  world.server.fault = (e) => {
    if (
      !injected &&
      e.op === "control" &&
      toHex(e.resource) === toHex(I) &&
      decodeControlRecord(e.bytes).body.type === "DEVICE_REVOKE"
    ) {
      injected = true;
      world.server.inject(I, junk.bytes);
    }
    return undefined;
  };
  await a.service.remove(toHex(bc.principal.id), 0n, "Phone");
  expect(injected).toBe(true);
  const closing = world.server
    .chain(I)
    .records.filter((r) => r.body.type === "KEY_EPOCH")
    .at(-1)?.body;
  if (closing?.type !== "KEY_EPOCH") throw new Error("no KEY_EPOCH");
  expect(hasSequence(closing.finalFrontier, bc.principal.id, seq)).toBe(false);
});

// The sections profile is used: its ID must stay the one the plugin opens.
it("uses the shared sections profile", () => {
  expect(SECTIONS_PROFILE_ID).toMatch(/sections/);
});
