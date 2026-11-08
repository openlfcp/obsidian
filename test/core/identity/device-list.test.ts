// LFCP-04-413: the person's devices from a validated chain (IDENTITY-PROFILE-01
// §5.4, §8, W §17.5), on Resource X of LFCP-IDENTITY-TEST-VECTORS-01.

import { fromHex, type PrincipalId } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import { deviceLine, deviceRows, presetOf } from "../../../src/core/identity/device-list";
import { fingerprintOf } from "../../../src/core/identity/people";
import { P, stateOfX, X } from "./x-chain";

const name = new Map(Object.entries(X.principals).map(([k, v]) => [v, k]));
const BOB = fromHex(P("BOB")) as PrincipalId;
const who = (rows: readonly { readonly principal: string }[]) =>
  rows.map((r) => name.get(r.principal));

describe("device list", () => {
  it("lists the first device, then this device, then the others, with their access", () => {
    const rows = deviceRows(stateOfX(5), P("DEV_B"), { [P("DEV_A")]: "Laptop" });
    expect(who(rows)).toEqual(["OWNER", "DEV_B", "DEV_A"]);
    expect(rows.map(deviceLine)).toEqual([
      `${fingerprintOf(P("OWNER"))} (first device)`,
      `${fingerprintOf(P("DEV_B"))} (Edit) · this device`,
      "Laptop (Full)",
    ]);
    expect(rows.map((r) => r.manages)).toEqual([true, false, true]);
  });

  it("a revoked device is removed (I9), and stays listed so that it is never re-added", () => {
    const rows = deviceRows(stateOfX(), P("OWNER"));
    expect(rows.find((r) => name.get(r.principal) === "DEV_A")?.state).toBe("removed");
    expect(rows[0]).toMatchObject({ first: true, thisDevice: true, state: "active" });
  });

  it("the cascade suspends what a removed device certified, and names it (I13)", () => {
    const before = deviceRows(stateOfX(11), P("BOB"), {}, BOB);
    expect(before.find((r) => name.get(r.principal) === "DEV_E")?.state).toBe("active");
    const after = deviceRows(stateOfX(), P("BOB"), {}, BOB);
    const e = after.find((r) => name.get(r.principal) === "DEV_E");
    expect(e).toMatchObject({ state: "suspended", suspendedBy: [P("DEV_C")] });
    expect(after.find((r) => name.get(r.principal) === "DEV_C")?.state).toBe("removed");
    // Active first, then suspended, then removed.
    expect(who(after)).toEqual(["BOB", "BRIDGE", "DEV_E", "DEV_C"]);
  });

  it("a service device is listed though it is only bound in the device list, never registered", () => {
    const bridge = deviceRows(stateOfX(), P("BOB"), {}, BOB).find(
      (r) => name.get(r.principal) === "BRIDGE",
    );
    expect(bridge).toMatchObject({ kind: "service", preset: "service", manages: false });
    expect(bridge && deviceLine(bridge)).toBe(`${fingerprintOf(P("BRIDGE"))} (Service)`);
  });

  it("another person's devices are not this person's", () => {
    expect(who(deviceRows(stateOfX(), P("OWNER")))).not.toContain("DEV_C");
  });

  it("names the §5.4 presets by kind and mask, in any order; anything else is custom", () => {
    expect(presetOf(0, [1n])).toBe("read");
    expect(presetOf(0, [3n, 2n, 1n])).toBe("edit");
    expect(presetOf(1, [2n, 1n])).toBe("service");
    expect(presetOf(0, [1n, 2n])).toBe("custom");
    expect(presetOf(0, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 10n, 12n, 13n])).toBe("full");
  });
});
