// E-022d1: the states of "Connect Apple Reminders" in words (U П1), the
// link handed to LFCP Bridge, and its callbacks (A§4.1). Pure.

import { describe, expect, it } from "vitest";
import {
  ACTIVE,
  type Attempt,
  type AttemptState,
  BEFORE_CONSUME,
  bridgeLink,
  connectView,
  parseCallback,
} from "../../../src/core/identity/connect-attempt";

const ALL: AttemptState[] = [
  "waiting-app",
  "confirm-code",
  "committing",
  "registering",
  "ready",
  "rejected",
  "cancelled",
  "expired",
  "already-connected",
  "other-account",
  "insufficient-authority",
  "capacity",
  "failed",
];

describe("connectView (U П1)", () => {
  it("not connected: one button", () => {
    expect(connectView(undefined)).toEqual({
      lines: ["Sync shared tasks with Apple Reminders on your Mac."],
      actions: ["connect"],
    });
  });

  it("waiting for the app: download, open again, cancel, and the other-device path", () => {
    const v = connectView({ state: "waiting-app" });
    expect(v.lines[0]).toBe("Waiting for LFCP Bridge…");
    expect(v.actions).toEqual(["download", "open-again", "cancel", "other-ways", "copy-link"]);
  });

  it("the code, big, with No and Yes only", () => {
    const v = connectView({ state: "confirm-code" }, { code: "k7qm-2xd4-rw5a-hn3e" });
    expect(v.code).toBe("k7qm-2xd4-rw5a-hn3e");
    expect(v.lines[0]).toBe("Does your Mac show the same code?");
    expect(v.actions).toEqual(["no", "yes"]);
  });

  it("after [Yes] there is no Cancel (A§4.4), offline says it keeps trying", () => {
    for (const state of ["committing", "registering"] as const) {
      const v = connectView({ state });
      expect(v.actions).toEqual([]);
      expect(v.lines[0]).toBe("Finishing connection…");
      expect(v.lines).toContain("(Changed your mind? Disconnect after it finishes.)");
    }
    expect(connectView({ state: "committing" }, { offline: true }).lines).toContain(
      "Still trying to reach the server — this can take a while.",
    );
  });

  it("every way of ending before the consume says nothing was changed", () => {
    for (const state of ["rejected", "cancelled", "expired"] as const)
      expect(connectView({ state })).toEqual({
        lines: ["Connection cancelled. Nothing was changed."],
        actions: ["connect"],
      });
  });

  it("the other finals, with U П1's texts", () => {
    expect(connectView({ state: "already-connected" })).toEqual({
      lines: ["This Mac is already connected."],
      actions: ["show-it"],
    });
    expect(connectView({ state: "other-account" }).lines[0]).toContain(
      "Disconnect from Obsidian…, then try again.",
    );
    expect(connectView({ state: "insufficient-authority" }).lines).toEqual([
      "Connect from a computer where you manage devices for your account.",
    ]);
    expect(connectView({ state: "capacity" })).toEqual({
      lines: ["Your account has too many connected devices. Remove an old one first."],
      actions: ["open-devices"],
    });
    expect(connectView({ state: "failed", message: "refused" }).actions).toEqual(["connect"]);
  });

  it("has a view for every state, and Cancel only before the consume", () => {
    for (const state of ALL) {
      const v = connectView({ state });
      expect(v.lines.length).toBeGreaterThan(0);
      expect(v.actions.includes("cancel")).toBe(
        BEFORE_CONSUME.has(state) && state === "waiting-app",
      );
      if (!BEFORE_CONSUME.has(state)) expect(v.actions).not.toContain("cancel");
    }
    expect([...ACTIVE]).toEqual(["waiting-app", "confirm-code", "committing", "registering"]);
  });
});

describe("the link and its callbacks (A§4.1)", () => {
  const a: Attempt = {
    id: "a1",
    metaAt: "2026-11-20T10:00:00Z",
    vault: "My vault",
    root: "aa",
    c: "cc",
    url: "wss://x",
    j: "jj",
    createdAt: 0,
    state: "waiting-app",
  };

  it("carries the pairing link in the fragment only", () => {
    const link = bridgeLink(a, "lfcp://pair/abc#secret=s3cr3t");
    const [head, fragment] = link.split("#link=");
    expect(head).toBe("lfcp-bridge://connect?attempt=a1&vault=My+vault&c=cc&root=aa&j=jj");
    expect(head).not.toContain("s3cr3t");
    expect(decodeURIComponent(fragment ?? "")).toBe("lfcp://pair/abc#secret=s3cr3t");
  });

  it("reads the four events and nothing else", () => {
    for (const event of ["request-ready", "app-ready", "already-connected", "other-account"])
      expect(parseCallback({ event, attempt: "a1", vault: "v" })).toEqual({
        event,
        attempt: "a1",
        vault: "v",
      });
    expect(parseCallback({ event: "approve", attempt: "a1" })).toBeNull();
    expect(parseCallback({})).toBeNull();
  });
});
