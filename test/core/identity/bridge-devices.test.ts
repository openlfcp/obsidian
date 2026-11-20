// E-023 (U П5): the device list groups a bridge's installations by
// bridgeInstanceId (C.service.instance), from the approval records of its
// C written by root or personal only; its line and pending connection.

import { principalRefOf } from "@openlfcp/client";
import { type PrincipalId, type ResourceId, toHex } from "@openlfcp/core";
import { expect, it } from "vitest";
import { bridgeGroups, bridgeLine, pendingLine } from "../../../src/core/identity/bridge-devices";
import type { DeviceRow } from "../../../src/core/identity/device-list";
import { FakeControl } from "../../support/fake-control";

const id = (n: number) => new Uint8Array(32).fill(n) as PrincipalId;
const row = (n: number, kind: "personal" | "service" = "service"): DeviceRow => ({
  principal: toHex(id(n)),
  fingerprint: `fp${n}`,
  label: `device ${n}`,
  first: n === 1,
  thisDevice: n === 1,
  kind,
  preset: kind === "service" ? "service" : "full",
  state: "active",
  suspendedBy: [],
  manages: kind === "personal",
});
const me = id(1);
const root: { signer: PrincipalId; writerClass: "root" | "service" } = {
  signer: me,
  writerClass: "root",
};

function control(
  n: number,
  instance: string | undefined,
  approvals: [number, "base" | "section", boolean?][],
  by = root,
) {
  const c = new FakeControl(new Uint8Array(32).fill(100 + n) as ResourceId, me);
  if (instance !== undefined) c.data.service = { instance, app: "0.6.0" };
  c.data.status = { heartbeatAt: "2026-11-20T10:00:00Z" };
  for (const [p, role, revoked] of approvals)
    c.put(
      "approvals",
      principalRefOf(id(p)),
      { role, resource: "r", revoked: revoked === true } as never,
      by,
    );
  return { c: toHex(c.resource), name: "Reminders bridge · MacBook Air", port: c, pending: [] };
}

it("groups by bridgeInstanceId across control Resources; others stay as they are", () => {
  const rows = [row(1, "personal"), row(2), row(3), row(4), row(5), row(6), row(7)];
  const { groups, rest } = bridgeGroups(rows, [
    control(1, "bridge-a", [
      [2, "base"],
      [3, "section"],
      [4, "section", true],
    ]),
    // A reconnect of the same bridge: another C, the same instance.
    control(2, "bridge-a", [[5, "section"]]),
    // Another bridge, before its first write: keyed by C.
    control(3, undefined, [[6, "base"]]),
    // An approval not written by root/personal names nothing.
    control(4, "bridge-b", [[7, "section"]], { signer: id(7), writerClass: "service" }),
  ]);
  const a = groups.find((g) => g.instance === "bridge-a");
  expect(a?.base.map((r) => r.principal)).toEqual([toHex(id(2))]);
  expect(a?.sections.map((r) => r.principal)).toEqual([toHex(id(3)), toHex(id(5))]);
  expect(a?.controls).toHaveLength(2);
  expect(groups.find((g) => g.base[0]?.principal === toHex(id(6)))?.instance).toMatch(
    /^[0-9a-f]{64}$/,
  );
  // Revoked (4), service-written (7) and the person's own (1) stay outside any group.
  expect(rest.map((r) => r.principal)).toEqual([1, 4, 7].map((n) => toHex(id(n))));
  expect(bridgeLine(a ?? (undefined as never), Date.parse("2026-11-20T10:03:00Z"))).toBe(
    "Reminders bridge · MacBook Air — 2 sections · 0.6.0 · last heard 3 min ago",
  );
  expect(pendingLine("Home")).toBe("Pending connection for “Home”.");
});
