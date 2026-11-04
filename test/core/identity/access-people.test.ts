// LFCP-04-411: the access list and Resource status by person
// (IDENTITY-PROFILE-01 §10 "Access list"): one row per root with its
// devices inside, "You" for the reader's root and all its devices,
// "Remove access…" on the person; on a real stored chain (Resource X of
// LFCP-IDENTITY-TEST-VECTORS-01).

import { afterEach, describe, expect, it } from "vitest";
import { Collaboration } from "../../../src/core/collab/service";
import { statusView } from "../../../src/core/collab/view";
import { fingerprintOf, shortId } from "../../../src/core/identity/people";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { type AccessInput, accessView, type MyAccess } from "../../../src/core/status/access";
import { storeX } from "../../support/identity-resource";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";
import { P } from "./x-chain";

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function statusOfX() {
  const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(runtime);
  const R = await storeX(runtime);
  const collab = new Collaboration(runtime, { sleep, connectTimeoutMs: 50 });
  return collab.status(R);
}

const mine: MyAccess = {
  allowed: true,
  current: true,
  verifiedAt: 1000,
  abilities: ["data/read", "data/write", "capability/grant", "capability/revoke"],
  owner: false,
  pendingControl: [],
};

describe("participants by person (Resource X at I13)", () => {
  it("lists each root once, with its registered devices and their state", async () => {
    const status = await statusOfX();
    const people = status.participants.filter((p) => p.invitation === undefined);
    // No device is a participant of its own: grants and ownership name roots (W §80.1).
    for (const d of ["DEV_A", "DEV_B", "DEV_C", "DEV_E", "BRIDGE"])
      expect(people.some((p) => p.principal === P(d))).toBe(false);
    const owner = people.find((p) => p.principal === P("OWNER"));
    expect(owner?.owner).toBe(true);
    expect(owner?.devices?.map((d) => [d.principal, d.status]).sort()).toEqual(
      [
        [P("DEV_A"), "removed"],
        [P("DEV_B"), "active"],
      ].sort(),
    );
    const bob = people.find((p) => p.principal === P("BOB"));
    expect(new Map(bob?.devices?.map((d) => [d.principal, `${d.kind} ${d.status}`]))).toEqual(
      new Map([
        [P("DEV_C"), "personal removed"],
        [P("DEV_E"), "personal suspended"],
        [P("BRIDGE"), "service active"],
      ]),
    );
    expect(people.find((p) => p.principal === P("CAROL"))?.devices).toBeUndefined();
    // This installation is no one here.
    expect(status.participants.some((p) => p.you)).toBe(false);
  });

  it("Resource status lists a person's devices after it", async () => {
    const view = statusView(await statusOfX());
    const row = view.rows.find((r) => r.label === "Participants")?.value ?? "";
    const bob = row.split("; ").find((e) => e.startsWith(shortId(P("BOB"))));
    expect(bob).toContain(`${fingerprintOf(P("DEV_E"))} (suspended)`);
    expect(bob).toContain(`${fingerprintOf(P("BRIDGE"))} (service)`);
    expect(row).not.toContain(shortId(P("DEV_B")));
  });

  it("the card has one row per person, devices inside, and removes access from the person", async () => {
    const status = await statusOfX();
    const input: AccessInput = {
      participants: status.participants,
      mine,
      aliases: { [shortId(P("BOB"))]: "Bob" },
      connected: true,
      time: (ms) => `at ${ms}`,
    };
    const view = accessView(input);
    const bob = view.rows.find((r) => r.principal === P("BOB"));
    expect(bob?.label).toBe("Bob");
    expect(bob?.removable).toBe(true);
    expect(bob?.devices.map((d) => [d.label, d.detail])).toEqual([
      [fingerprintOf(P("BOB")), "first device"],
      ...[
        [P("BRIDGE"), "service device (a bridge or bot)"],
        [P("DEV_C"), "device, removed"],
        [P("DEV_E"), "device, suspended: a device that added it was removed"],
      ]
        .sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1))
        .map(([p, detail]) => [fingerprintOf(p as string), detail]),
    ]);
    expect(view.rows.find((r) => r.principal === P("CAROL"))?.devices).toEqual([]);
  });
});

describe("You: the reader's root and all its devices", () => {
  const participants: AccessInput["participants"] = [
    {
      id: "aaaa1111",
      principal: "aaaa1111".padEnd(64, "0"),
      you: true,
      owner: true,
      abilities: ["owner"],
      devices: [
        {
          principal: "bbbb2222".padEnd(64, "0"),
          fingerprint: "bbbb-bbbb-bbbb-bbbb",
          kind: "personal",
          status: "active",
          you: true,
        },
        {
          principal: "cccc3333".padEnd(64, "0"),
          fingerprint: "cccc-cccc-cccc-cccc",
          kind: "personal",
          status: "active",
          you: false,
        },
      ],
    },
  ];
  const base: AccessInput = {
    participants,
    mine: { ...mine, owner: true },
    aliases: {},
    connected: true,
    time: (ms) => `at ${ms}`,
  };

  it('is one "You" row, this device marked, never removable', () => {
    const view = accessView(base);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ label: "You", you: true, removable: false });
    expect(view.rows[0]?.devices.map((d) => [d.label, d.you])).toEqual([
      [fingerprintOf("aaaa1111".padEnd(64, "0")), false],
      ["This device", true],
      ["cccc-cccc-cccc-cccc", false],
    ]);
  });

  it("names the reader's own devices by their Identity Resource labels, no one else's", () => {
    const view = accessView({
      ...base,
      deviceLabels: { ["cccc3333".padEnd(64, "0")]: "Phone" },
    });
    expect(view.rows[0]?.devices.map((d) => d.label)).toContain("Phone");
  });
});
