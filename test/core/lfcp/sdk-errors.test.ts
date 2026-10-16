// The SDK's INTERNAL error as a safe class, and the end of an ordinary
// connection loss told apart from an error (the owner's check of
// 0.4.0-beta.9: "error code=INTERNAL" twice as Wi-Fi went off).

import { describe, expect, it } from "vitest";
import { safeEvent } from "../../../src/core/diagnostics";
import {
  LOSS_WINDOW_MS,
  listenerErrorClass,
  lossNoise,
  sdkErrorClass,
} from "../../../src/core/lfcp/sdk-errors";

describe("SDK errors", () => {
  it("classes the SDK's known failures; a message never passes through", () => {
    expect(sdkErrorClass("the connection is not READY")).toBe("send-not-ready");
    expect(sdkErrorClass("the connection closed before RESOURCE_HOSTED: x")).toBe(
      "connection-closed",
    );
    expect(sdkErrorClass("unexpected storage precondition failure: no outbound item ab")).toBe(
      "outbound-race",
    );
    expect(sdkErrorClass("the batch status was not stored: conflict")).toBe("batch-status-store");
    expect(sdkErrorClass("Plan.md secret=abc")).toBe("other");
    expect(sdkErrorClass(undefined)).toBe("other");
  });

  it("classes a listener's error by its code or kind; its message never passes through (LFCP-03-050)", () => {
    expect(listenerErrorClass(new TypeError("Plan.md: Draft"))).toBe("type-error");
    expect(listenerErrorClass(Object.assign(new Error("x"), { code: "INVALID_INTENT" }))).toBe(
      "INVALID_INTENT",
    );
    expect(listenerErrorClass(Object.assign(new Error("x"), { name: "Plan.md secret" }))).toBe(
      "error",
    );
    expect(listenerErrorClass("Plan.md")).toBe("non-error");
    // The plugin's diagnostics event (plugin.ts) keeps both fields.
    expect(
      safeEvent(1, "listener-error", {
        reason: "sections",
        diagnostic: listenerErrorClass(new RangeError("Launch")),
      }),
    ).toEqual({
      at: 1,
      kind: "listener-error",
      detail: { reason: "sections", diagnostic: "range-error" },
    });
  });

  it("an INTERNAL of a session not READY, just after its connection went down, is that loss", () => {
    const at = 10_000;
    const base = { code: "INTERNAL", ready: false, now: at + 8, disconnectedAt: at };
    expect(lossNoise(base)).toBe(true);
    expect(lossNoise({ ...base, now: at + LOSS_WINDOW_MS })).toBe(true);
    // Anything else stays an error: READY, long after, never down, another code.
    expect(lossNoise({ ...base, ready: true })).toBe(false);
    expect(lossNoise({ ...base, now: at + LOSS_WINDOW_MS + 1 })).toBe(false);
    expect(lossNoise({ ...base, disconnectedAt: null })).toBe(false);
    expect(lossNoise({ ...base, code: "ENGINE_TRAP" })).toBe(false);
  });
});
