// POST-017: what the user sees when the server refuses a collaboration for
// good — the "Resource status" Sync row and the one notice. The flow against
// the reference server is in live.test.ts.

import { PROFILE_ID } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
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
  profile: PROFILE_ID,
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
      `Shared Tasks: "Team" stopped syncing. Not hosted by the sync server: the server no longer has this collaboration (RESOURCE_NOT_HOSTED). Your tasks stay on this device; see "Resource status".`,
    );
  });

  it("never shows the server's address in a notice, only in the status row (C-8)", () => {
    for (const code of [
      "RESOURCE_NOT_HOSTED",
      "AUTHORIZATION_FAILED",
      "RESOURCE_TOMBSTONED",
      "HOSTING_DENIED",
      "MALFORMED_MESSAGE",
    ]) {
      const refusal = { code, url: URL };
      expect(refusalNotice("Core with Tasks", refusal, SECTIONS_PROFILE_ID)).not.toContain(URL);
      expect(refusalText(refusal)).toContain(URL);
    }
    expect(
      refusalNotice(
        "Core with Tasks",
        { code: "AUTHORIZATION_FAILED", url: URL },
        SECTIONS_PROFILE_ID,
      ),
    ).toBe(
      'Shared Tasks: "Core with Tasks" stopped syncing. No access on the sync server: this device\'s identity may no longer read this section (AUTHORIZATION_FAILED). Your tasks stay on this device; see "Resource status".',
    );
  });

  it("says section for a shared section, collaboration for a 0.1 Resource (LFCP-03-042)", () => {
    const section = status({ profile: SECTIONS_PROFILE_ID, localName: null });
    expect(syncRow(section)).toBe(
      `Not hosted by ${URL}: the server no longer has this section (RESOURCE_NOT_HOSTED)`,
    );
    expect(statusView(section).title).toBe("Shared section");
    expect(statusView({ ...section, blocked: true }).banner).toMatch(
      /^This section's history has forked/,
    );
    expect(
      refusalNotice("Plan", { code: "AUTHORIZATION_FAILED", url: URL }, SECTIONS_PROFILE_ID),
    ).toContain("may no longer read this section (AUTHORIZATION_FAILED)");
    const legacy = status({ localName: null });
    expect(statusView(legacy).title).toBe("Collaboration");
    expect(statusView({ ...legacy, blocked: true }).banner).toMatch(
      /^This collaboration's history has forked/,
    );
  });

  it("words the quiet notice after an automatic rehost (ADR 0008)", () => {
    expect(rehostNotice("Team", URL)).toBe(
      `Shared Tasks: "Team" was hosted again on ${URL}, which had lost it. Changes are being sent again.`,
    );
  });
});

describe("access recovery after a server restore (LFCP-02-106)", () => {
  const authFailed = { code: "AUTHORIZATION_FAILED", url: URL };

  it("shows waiting while the client re-supplies the records, even over an old refusal", () => {
    expect(syncRow(status({ state: "recovering", refusal: null, phase: "OPENING" }))).toBe(
      "Waiting for the server to recover access",
    );
    expect(syncRow(status({ state: "recovering", refusal: authFailed }))).toBe(
      "Waiting for the server to recover access",
    );
  });

  it("recovered: the usual state; ended: the refusal's own text again", () => {
    expect(syncRow(status({ state: "available", refusal: null, phase: "LIVE" }))).toBe(
      "In sync (live)",
    );
    expect(syncRow(status({ state: "refused", refusal: authFailed }))).toBe(
      refusalText(authFailed),
    );
  });
});
