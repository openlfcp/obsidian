// LFCP-04-413: the words of the device flows (pairing-view.ts), pure.

import type { PairingReview } from "@openlfcp/client";
import { generateResourceId, type PrincipalId } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import { defaultPreset, type Names, reviewView } from "../../../src/core/identity/pairing-view";

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
});
