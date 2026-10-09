// LFCP-02-060: the access list of a section card (unit evidence on mock
// state): identities, not people; invitations and pending changes apart from
// access; offline and stale views qualified (UX07); unknown never shown as an
// empty membership; invite and remove offered by the actual abilities (SI14,
// SI15, SI18).

import { describe, expect, it } from "vitest";
import {
  type AccessInput,
  accessView,
  type MyAccess,
  REMOVE_CONFIRMATION,
  revokeMessage,
} from "../../../src/core/status/access";

const owner: MyAccess = {
  allowed: true,
  current: true,
  verifiedAt: 1000,
  abilities: [
    "data/read",
    "data/write",
    "capability/grant",
    "capability/revoke",
    "snapshot/publish",
  ],
  owner: true,
  pendingControl: [],
};
const input = (o: Partial<AccessInput> = {}): AccessInput => ({
  participants: [
    {
      id: "aaaa1111",
      principal: "aaaa111100",
      you: true,
      owner: true,
      abilities: ["data/read", "data/write"],
    },
    {
      id: "bbbb2222",
      principal: "bbbb222200",
      you: false,
      owner: false,
      abilities: ["data/read", "data/write"],
    },
    { id: "cccc3333", principal: "cccc333300", you: false, owner: false, abilities: ["data/read"] },
    {
      id: "dddd4444",
      principal: "dddd444400",
      you: false,
      owner: false,
      abilities: ["data/read"],
      invitation: { used: "0", limit: "1" },
    },
  ],
  mine: owner,
  aliases: { bbbb2222: "Anna (laptop)" },
  connected: true,
  time: (ms) => `at t${ms}`,
  ...o,
});

describe("the access list (060)", () => {
  it("identities with roles; the alias with its identity detail; invitations apart", () => {
    const v = accessView(input());
    expect(v.heading).toBe("Identities with access");
    expect(v.freshness).toBe("Access verified with the server at t1000.");
    expect(v.rows).toEqual([
      {
        id: "aaaa1111",
        principal: "aaaa111100",
        label: "You",
        detail: "aaaa1111",
        role: "owner",
        you: true,
        removable: false,
      },
      {
        id: "bbbb2222",
        principal: "bbbb222200",
        label: "Anna (laptop)",
        detail: "bbbb2222",
        role: "can edit",
        you: false,
        removable: true,
      },
      {
        id: "cccc3333",
        principal: "cccc333300",
        label: "Member cccc3333",
        detail: "cccc3333",
        role: "can read",
        you: false,
        removable: true,
      },
    ]);
    expect(v.invitations).toEqual([
      "Invitation dddd4444: can read, used 0 of 1. Not access until someone joins with it.",
    ]);
    expect(v.canInvite).toBe(true);
    expect(v.removeNote).toBeNull();
  });

  it("UX07: offline or behind the server: as last verified, may have changed; no inviting on a stale view", () => {
    expect(accessView(input({ connected: false })).freshness).toBe(
      "Access as last verified at t1000; it may have changed.",
    );
    const stale = accessView(input({ mine: { ...owner, current: false } }));
    expect(stale.freshness).toBe("Access as last verified at t1000; it may have changed.");
    expect(stale.canInvite).toBe(false);
    expect(stale.inviteNote).toBe(
      "Inviting waits until this device has checked access with the server.",
    );
  });

  it("unknown access: said as unknown, never an empty membership", () => {
    const v = accessView(input({ mine: null }));
    expect(v).toMatchObject({ unknown: true, rows: [], invitations: [], canInvite: false });
    expect(v.freshness).toBe("Access is unknown until this device checks with the server.");
  });

  it("SI14: a removal sent and not committed is pending, not done", () => {
    const v = accessView(input({ mine: { ...owner, pendingControl: ["CAPABILITY_REVOKE"] } }));
    expect(v.pending).toEqual(["Removing access: waiting for the server. It is not done yet."]);
    expect(v.rows.map((r) => r.id)).toContain("bbbb2222");
  });

  it("SI18 and abilities: a reader is not offered invite or remove", () => {
    const reader: MyAccess = {
      ...owner,
      allowed: false,
      reason: "read-only",
      owner: false,
      abilities: ["data/read"],
    };
    const v = accessView(input({ mine: reader }));
    expect(v.canInvite).toBe(false);
    expect(v.inviteNote).toBe("You can't invite others to this section.");
    expect(v.rows.every((r) => !r.removable)).toBe(true);
  });

  it("removing waits for a connected, current view with no access change pending (UX §7)", () => {
    expect(accessView(input({ connected: false })).removeNote).toBe(
      "Removing access needs a connection to the section's server.",
    );
    expect(accessView(input({ mine: { ...owner, current: false } })).removeNote).toBe(
      "Removing access waits until this device has checked access with the server.",
    );
    expect(
      accessView(input({ mine: { ...owner, pendingControl: ["CAPABILITY_GRANT"] } })).removeNote,
    ).toBe(
      "Removing access waits until this device's earlier access change is recorded by the server.",
    );
  });
});

describe("removing access (060)", () => {
  const label = (hex: string) => `Member ${hex.slice(0, 8)}`;

  it("asks first; copies already received are said to stay", () => {
    expect(REMOVE_CONFIRMATION).toBe(
      "Remove future access to this shared section? Copies already received cannot be erased.",
    );
  });

  it("queued is pending, not done; a rotation is said once recorded", () => {
    expect(revokeMessage({ kind: "queued", rotated: true, remainingPaths: [] }, label)).toBe(
      "Removing access: waiting for the server. It is not done yet. Once recorded, new changes use a new key this identity does not get.",
    );
  });

  it("access kept through a grant this vault cannot revoke is said, with its issuer", () => {
    const m = revokeMessage(
      {
        kind: "queued",
        rotated: false,
        remainingPaths: [{ issuer: "eeee5555ffff", abilities: ["data/read"] }],
      },
      label,
    );
    expect(m).toContain("keeps access through a grant you can't remove (from Member eeee5555)");
    expect(m).not.toContain("new key");
  });

  it("refusals changed nothing, each with its reason", () => {
    for (const reason of ["offline", "stale", "control-pending", "not-authorized"])
      expect(revokeMessage({ kind: "refused", reason }, label)).toMatch(/Nothing was changed\.?/);
    expect(revokeMessage({ kind: "refused", reason: "offline" }, label)).toContain("connection");
  });
});
