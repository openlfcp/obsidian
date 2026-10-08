// POST-017: what the user sees when the server refuses a collaboration for
// good — the "Resource status" Sync row and the one notice. The flow against
// the reference server is in live.test.ts.

import { describe, expect, it } from "vitest";
import type { ResourceStatus } from "../../../src/core/collab/service";
import {
  refusalNotice,
  refusalText,
  rehostNotice,
  statusView,
} from "../../../src/core/collab/view";

const URL = "wss://sync.example.org/v1/ws";

const status = (over: Partial<ResourceStatus>): ResourceStatus => ({
  localName: "Team",
  resourceId: "R",
  profile: "org.openlfcp.shared-objects.v1",
  state: "refused",
  refusal: { code: "RESOURCE_NOT_HOSTED", url: URL },
  blocked: false,
  phase: "CLOSED",
  hosting: "hosted",
  controlHead: null,
  controlSeq: null,
  dataEpoch: null,
  coordinator: URL,
  endpoints: [URL],
  participants: [],
  pendingOutbound: 0,
  conflicts: [],
  ...over,
});
const syncRow = (s: ResourceStatus) => statusView(s).rows.find((r) => r.label === "Sync")?.value;

describe("a collaboration the server refused (POST-017)", () => {
  it("names the server and the code in one sentence per code", () => {
    expect(refusalText({ code: "RESOURCE_NOT_HOSTED", url: URL })).toBe(
      `Not hosted by ${URL}: the server no longer has this collaboration (RESOURCE_NOT_HOSTED)`,
    );
    expect(refusalText({ code: "AUTHORIZATION_FAILED", url: URL })).toBe(
      `No access on ${URL}: this device's identity may no longer read this collaboration (AUTHORIZATION_FAILED)`,
    );
    expect(refusalText({ code: "RESOURCE_TOMBSTONED", url: URL })).toBe(
      `Deleted on ${URL} (RESOURCE_TOMBSTONED)`,
    );
    expect(refusalText({ code: "HOSTING_DENIED", url: URL })).toBe(
      `Not hosted by ${URL}, and this device may not host it again: ask the owner to host it again (HOSTING_DENIED)`,
    );
    expect(refusalText({ code: "MALFORMED_MESSAGE", url: URL })).toBe(
      `Refused by ${URL} (MALFORMED_MESSAGE)`,
    );
  });

  it("shows the refusal in the Sync row of Resource status", () => {
    expect(syncRow(status({}))).toBe(
      `Not hosted by ${URL}: the server no longer has this collaboration (RESOURCE_NOT_HOSTED)`,
    );
    // Created while the server was unreachable: not hosted yet, not gone.
    expect(syncRow(status({ hosting: "pending" }))).toBe(
      `Not hosted yet on ${URL}: host it from here to start syncing`,
    );
    // Without a refusal the row is unchanged.
    expect(syncRow(status({ state: "available", refusal: null, phase: "LIVE" }))).toBe(
      "In sync (live)",
    );
  });

  it("words the notice as Shared Tasks, with the collaboration's name", () => {
    expect(refusalNotice("Team", { code: "RESOURCE_NOT_HOSTED", url: URL })).toBe(
      `Shared Tasks: "Team" stopped syncing. Not hosted by ${URL}: the server no longer has this collaboration (RESOURCE_NOT_HOSTED). Your tasks stay on this device; see "Resource status".`,
    );
  });

  it("words the quiet notice after an automatic rehost (ADR 0008)", () => {
    expect(rehostNotice("Team", URL)).toBe(
      `Shared Tasks: "Team" was hosted again on ${URL}, which had lost it. Changes are being sent again.`,
    );
  });
});
