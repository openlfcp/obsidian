// LFCP-04-413: the words of the device flows (pairing-view.ts), pure.

import type { PairingReview } from "@openlfcp/client";
import { generateResourceId, type PrincipalId, toHex } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_RUNBOOK_URL,
  defaultPreset,
  type Names,
  progressView,
  reviewView,
  revokeView,
  SESSION_NO_DEVICE_SUPPORT,
  sessionView,
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
