// LFCP-04-413: the words of the device flows (pairing-view.ts), pure.

import type { PairingReview } from "@openlfcp/client";
import { generateResourceId, type PrincipalId, toHex } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import {
  approvalView,
  BRIDGE_RUNBOOK_URL,
  defaultPreset,
  deferredText,
  type Names,
  progressView,
  reviewView,
  revokeView,
  SESSION_NO_DEVICE_SUPPORT,
  sessionView,
  upkeepIssues,
  upkeepText,
} from "../../../src/core/identity/pairing-view";

const names: Names = { resource: () => "Plans", device: (hex) => hex.slice(0, 4) };

function review(o: Partial<PairingReview>): PairingReview {
  return {
    session: "s",
    requestKey: "p:x",
    device: new Uint8Array(32) as PrincipalId,
    descriptor: "",
    label: "Device",
    kind: 0,
    requestedScope: [],
    fingerprint: "aaaa-bbbb-cccc-dddd",
    presets: (["full", "edit", "read", "service"] as const).map((preset) => ({
      preset,
      offered: preset !== "service",
    })),
    requestChanges: [],
    tuple: "t",
    ...o,
  };
}

describe("the approve dialog's words (§5.3 step 4, §5.4)", () => {
  it("offers Edit first for a phone and Full for a computer", () => {
    expect(defaultPreset(review({ platform: "mobile" }))).toBe("edit");
    expect(defaultPreset(review({ platform: "desktop" }))).toBe("full");
  });

  it("falls back to a preset that is offered", () => {
    const presets = [
      { preset: "full" as const, offered: false, reason: "c7" },
      { preset: "edit" as const, offered: true },
      { preset: "read" as const, offered: true },
    ];
    expect(defaultPreset(review({ platform: "desktop", presets }))).toBe("edit");
  });

  it("says a phone stays read-only whatever access it gets (V3)", () => {
    const phone = reviewView(review({ platform: "mobile" }), names);
    expect(phone.details.join(" ")).toContain("read-only");
    const computer = reviewView(review({ platform: "desktop" }), names);
    expect(computer.details.join(" ")).not.toContain("read-only");
  });

  it("a service request names its sections and offers only the Service preset", () => {
    const view = reviewView(
      review({
        kind: 1,
        label: "Notes bridge",
        requestedScope: [generateResourceId()],
        presets: [{ preset: "service", offered: true }],
      }),
      names,
    );
    expect(view.details).toContain(
      'Notes bridge (service) asks to join "Plans"; access: read and write.',
    );
    expect(view.presets.map((p) => p.preset)).toEqual(["service"]);
    expect(view.scope).toHaveLength(1);
  });

  it("a service request points to the Reminders bridge runbook (P-050); a device of yours does not", () => {
    const service = reviewView(
      review({ kind: 1, label: "Mac bridge", requestedScope: [generateResourceId()] }),
      names,
    );
    expect(service.help).toEqual({
      text: expect.stringContaining("Reminders bridge (experimental, run from the Terminal)"),
      link: BRIDGE_RUNBOOK_URL,
    });
    expect(BRIDGE_RUNBOOK_URL).toMatch(
      /^https:\/\/github\.com\/openlfcp\/bridge\/.*running-the-bridge\.md$/,
    );
    expect(reviewView(review({ platform: "desktop" }), names).help).toBeNull();
  });
});

describe("the new device's result (§5.3 step 8, §6)", () => {
  it("a section this version cannot open says so, and keeps the pairing unfinished until an update (B5)", () => {
    const R = generateResourceId();
    const view = progressView(
      {
        kind: "approved",
        certificate: {} as never,
        candidates: [{ resource: R, status: "ready", name: "Board" }],
        foreignCertificates: 0,
      },
      names,
      "",
      [{ resource: toHex(R), newerVersion: true, reason: "x" }],
    );
    expect(view.sections).toEqual([
      { name: "Board", status: "needs a newer version of Shared Tasks" },
    ]);
    expect(view.final).toBe(false);
    expect(view.paused).toBe(true);
    expect(view.headline).not.toContain("on this device");
  });
});

describe("sdk-ts 0.5.0 outcomes (IDENTITY-PROFILE-01 §6, §8.4)", () => {
  it("a pairing session on a server without device support stops honestly, with no link", () => {
    expect(sessionView({ kind: "unsupported", reason: "no identity-01" })).toEqual({
      kind: "stop",
      message: SESSION_NO_DEVICE_SUPPORT,
    });
    // A resumed session (it names one) reads the same: nothing was sent.
    expect(sessionView({ kind: "unsupported", session: "s", reason: "no identity-01" })).toEqual({
      kind: "stop",
      message: SESSION_NO_DEVICE_SUPPORT,
    });
    expect(SESSION_NO_DEVICE_SUPPORT).toContain("nothing was changed");
  });

  it("a section where the removal was not needed counts as done and is not named", () => {
    const I = generateResourceId();
    const bound = generateResourceId();
    const other = generateResourceId();
    const label = (hex: string) =>
      hex === toHex(bound) ? "Bound" : hex === toHex(other) ? "Elsewhere" : "List";
    const view = revokeView(
      {
        kind: "revoked",
        operation: "op",
        results: [
          { resource: I, revoke: "revoked" },
          { resource: bound, revoke: "revoked" },
          { resource: other, revoke: "not-relevant" },
        ],
        document: { state: "committed-own" },
      },
      "Laptop",
      { resource: label, device: (hex) => hex.slice(0, 4) },
    );
    expect(view).toEqual({ kind: "done", message: 'Removed "Laptop".' });
  });
});

describe("an approval waiting for its record in C (SERVICE-CONTROL-PROFILE-01 §7.1)", () => {
  it("offers Finish, never Done, and says why without internal words", () => {
    const v = approvalView(
      {
        kind: "approval-record-pending",
        operation: "op",
        reason: "the control Resource C is not open here",
      },
      "LFCP Bridge",
      names,
    );
    expect(v).toEqual({
      kind: "finish",
      operation: "op",
      message: expect.stringContaining('"LFCP Bridge" is approved, but adding it is not finished'),
    });
    expect(v.message).not.toMatch(/control Resource|approval record|\bC\b/);
  });
});

describe("a registration the §7.4 gate deferred (SERVICE-CONTROL-PROFILE-01, svc-1 R5)", () => {
  const C = "c".repeat(64);
  const X = "a".repeat(64);
  const D = "d".repeat(64);
  const named: Names = {
    resource: (hex) => (hex === C ? "Reminders bridge · MacBook Air" : "Plans"),
    device: () => "MacBook Air",
  };
  const notSynced = `the control Resource ${C} is not synchronised`;
  const noApproval = `the control Resource ${C} names it and holds no approval for it yet`;
  const unacked = `the control Resource ${C} names it and its approval for it is not accepted by the server yet`;

  it("says each reason in plain words, naming C by its roster name", () => {
    expect(deferredText(notSynced, "MacBook Air", '"Plans"', named)).toBe(
      '"MacBook Air" is not added to "Plans" yet: it waits until "Reminders bridge · MacBook Air" is up to date on this device.',
    );
    for (const reason of [noApproval, unacked])
      expect(deferredText(reason, "MacBook Air", '"Plans"', named)).toBe(
        '"MacBook Air" is not added to "Plans" yet: it waits until its connection is confirmed in "Reminders bridge · MacBook Air".',
      );
    // Without names, no identifier is shown.
    expect(deferredText(notSynced, "MacBook Air", '"Plans"')).toBe(
      '"MacBook Air" is not added to "Plans" yet: it waits until your Reminders bridge is up to date on this device.',
    );
    // A reason this version does not know is kept, not dropped (I14).
    expect(deferredText("something new", "MacBook Air", '"Plans"', named)).toBe(
      '"MacBook Air" is not added to "Plans" yet: something new.',
    );
  });

  it("is an upkeep issue and a line of the upkeep's text; never 'up to date'", () => {
    const resource = generateResourceId();
    const issues = upkeepIssues(
      [
        {
          resource,
          status: "partial",
          steps: [],
          deferred: [{ device: Uint8Array.from(Buffer.from(D, "hex")), reason: notSynced }],
        },
      ],
      { state: "complete" } as never,
      X,
    );
    expect(issues).toEqual([
      { resource: toHex(resource), kind: "deferred", device: D, detail: notSynced },
    ]);
    const text = upkeepText({ reconciled: true, rotations: [], issues }, named);
    expect(text).toBe(
      '"MacBook Air" is not added to "Plans" yet: it waits until "Reminders bridge · MacBook Air" is up to date on this device.',
    );
    expect(text).not.toContain("up to date in every section");
  });

  it("names every section a device waits in once per reason", () => {
    const other = {
      ...named,
      resource: (hex: string) => (hex === C ? "Bridge" : hex === X ? "Plans" : "Home"),
    };
    const text = upkeepText(
      {
        reconciled: true,
        rotations: [],
        issues: [
          { resource: X, kind: "deferred", device: D, detail: notSynced },
          { resource: "b".repeat(64), kind: "deferred", device: D, detail: notSynced },
        ],
      },
      other,
    );
    expect(text).toBe(
      '"MacBook Air" is not added to "Plans", "Home" yet: it waits until "Bridge" is up to date on this device.',
    );
  });
});
