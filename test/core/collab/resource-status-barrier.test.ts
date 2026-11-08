// LFCP-04-406 (V_notice): Resource status of a Resource past its identity
// barrier says the plugin needs an update, and names where it is blocked
// (WIRE §100.1: "blocked at head H by an unsupported record").

import { PROFILE_ID } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { describe, expect, it } from "vitest";
import type { ResourceStatus } from "../../../src/core/collab/service";
import { statusView } from "../../../src/core/collab/view";
import { IDENTITY_BLOCKED, identityBlocked } from "../../../src/core/lfcp/identity-barrier";

const URL = "wss://sync.example.org/v1/ws";
const HEAD = "cd".repeat(32);

const status = (over: Partial<ResourceStatus>): ResourceStatus => ({
  localName: "Launch",
  resourceId: "R",
  profile: SECTIONS_PROFILE_ID,
  state: "unsupported",
  refusal: null,
  blocked: false,
  phase: "CONTROL_SYNC",
  hosting: "hosted",
  controlHead: HEAD,
  controlSeq: "4",
  dataEpoch: "0",
  coordinator: URL,
  endpoints: [URL],
  participants: [],
  pendingOutbound: 2,
  conflicts: [],
  ...over,
});

const block = {
  head: HEAD,
  recordId: "ab".repeat(32),
  seq: "5",
  entry: "device-grant" as const,
  at: 0,
};

describe("Resource status past an identity barrier", () => {
  it("a section: the update banner, and the head and record it is blocked at", () => {
    const v = statusView(status({ identityBlock: block }));
    expect(v.banner).toBe(`${IDENTITY_BLOCKED}. Its data stays readable on this device.`);
    expect(v.rows.find((r) => r.label === "Blocked at")?.value).toBe(
      `head ${HEAD.slice(0, 16)}…, by record #5 (${"ab".repeat(8)}…): a device was added (DEVICE_GRANT)`,
    );
  });

  it("a 0.1 collaboration says its own noun; without a block nothing is added", () => {
    expect(
      statusView(status({ profile: PROFILE_ID, state: "error", identityBlock: block })).banner,
    ).toBe(`${identityBlocked("collaboration")}. Its data stays readable on this device.`);
    // R5 (obsidian#105): the Sync row says the same, not offline or retrying.
    for (const state of ["offline", "error", "available"] as const) {
      const sync = statusView(
        status({ profile: PROFILE_ID, state, phase: "CONTROL_SYNC", identityBlock: block }),
      ).rows.find((r) => r.label === "Sync")?.value;
      expect(sync).toBe("Not syncing: this needs a newer version of Shared Tasks");
    }
    const plain = statusView(status({ profile: PROFILE_ID, state: "error" }));
    expect(plain.banner).toBeNull();
    expect(plain.rows.some((r) => r.label === "Blocked at")).toBe(false);
  });
});
