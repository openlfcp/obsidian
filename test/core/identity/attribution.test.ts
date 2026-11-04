// LFCP-04-411: authors are people (IDENTITY-PROFILE-01 §10 "Attribution"):
// a change is shown as rootOf(actor) with the device as detail, a revoked
// device included, and a person writing from several devices is one
// person; on a real stored chain (Resource X of LFCP-IDENTITY-TEST-VECTORS-01).

import {
  actorSequence,
  controlRecordId,
  dataEpoch,
  dataUnitId,
  fromHex,
  principalId,
  type ResourceId,
} from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { Collaboration } from "../../../src/core/collab/service";
import { statusView } from "../../../src/core/collab/view";
import { authorLabel, fingerprintOf, shortId } from "../../../src/core/identity/people";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { storeX } from "../../support/identity-resource";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";
import { P } from "./x-chain";

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

/** Quarantined units of `actor` (labels of X), as the applier would record them. Never valid bytes. */
async function storeQuarantined(
  storage: LfcpStorage,
  R: ResourceId,
  units: readonly { readonly n: number; readonly actor: string; readonly detail: string }[],
) {
  const r = await storage.commit(
    units.map((u) => ({
      op: "put-data-unit" as const,
      unit: {
        unitId: dataUnitId(new Uint8Array(32).fill(u.n)),
        resourceId: R,
        dataEpoch: dataEpoch(0n),
        actor: principalId(fromHex(P(u.actor))),
        actorSeq: actorSequence(1n),
        prevDataUnitId: null,
        controlHead: controlRecordId(new Uint8Array(32).fill(9)),
        bytes: Uint8Array.of(u.n),
      },
      status: "quarantined" as const,
      detail: u.detail,
    })),
  );
  if (!r.ok) throw new Error(r.reason);
}

async function xWithBlocked() {
  const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(runtime);
  const R = await storeX(runtime);
  await storeQuarantined(runtime.storage as LfcpStorage, R, [
    { n: 1, actor: "DEV_B", detail: "NO_KEY" },
    { n: 2, actor: "DEV_A", detail: "NO_KEY" },
    { n: 3, actor: "OWNER", detail: "NO_KEY" },
    { n: 4, actor: "BRIDGE", detail: "NO_KEY" },
  ]);
  return { runtime, R, collab: new Collaboration(runtime, { sleep, connectTimeoutMs: 50 }) };
}

describe("authors by person", () => {
  it("edits that cannot be applied count for the person, from each device", async () => {
    const { collab, R } = await xWithBlocked();
    const blocked = (await collab.status(R)).blockedCollaborators ?? [];
    const owner = blocked.find((b) => b.id === shortId(P("OWNER")));
    // Three installations of one human (the root and two devices, one revoked): one person.
    expect(owner?.units).toBe(3);
    expect([...(owner?.from ?? [])].sort()).toEqual(
      [`from ${fingerprintOf(P("DEV_A"))}`, `from ${fingerprintOf(P("DEV_B"))}`].sort(),
    );
    const bob = blocked.find((b) => b.id === shortId(P("BOB")));
    expect(bob).toMatchObject({ units: 1, from: [`via ${fingerprintOf(P("BRIDGE"))}`] });
    expect(blocked).toHaveLength(2);
    const row = statusView(await collab.status(R)).rows.find(
      (r) => r.label === "Edits that cannot be applied here",
    );
    expect(row?.value).toContain(
      `${shortId(P("BOB"))} (via ${fingerprintOf(P("BRIDGE"))}): 1 change`,
    );
  });

  it("a notice names the person with its alias, the device as detail", async () => {
    const { runtime, R } = await xWithBlocked();
    const people = await runtime.people(R);
    const aliases = { [shortId(P("OWNER"))]: "Olga" };
    expect(authorLabel(people, P("DEV_B"), aliases)).toBe(
      `Olga (from ${fingerprintOf(P("DEV_B"))})`,
    );
    expect(authorLabel(people, P("OWNER"), aliases)).toBe("Olga");
    expect(authorLabel(people, P("BRIDGE"))).toBe(
      `${shortId(P("BOB"))} (via ${fingerprintOf(P("BRIDGE"))})`,
    );
    // Never bound in X: itself.
    expect(authorLabel(people, P("DEV_F"))).toBe(shortId(P("DEV_F")));
  });

  it("before the chain binds a device, its edits are its own (nothing is rewritten later)", async () => {
    const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    running.push(runtime);
    const R = await storeX(runtime, 3);
    expect(authorLabel(await runtime.people(R), P("DEV_B"))).toBe(shortId(P("DEV_B")));
  });
});
