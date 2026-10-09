// A gate's live tests (LFCP_REQUIRE_LIVE=1) run against the server named in
// LFCP_SERVER_BIN, the build at server.lock, or fail: never silently against
// a default location's build, never skipped.

import { afterEach, describe, expect, it, vi } from "vitest";
import { serverBinary } from "./support/e2e-server";
import { liveSkipReason, requireExplicitServer } from "./support/live-server";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("live tests in a gate", () => {
  it("LFCP_REQUIRE_LIVE=1 without LFCP_SERVER_BIN fails, naming server.lock's commit", () => {
    vi.stubEnv("LFCP_REQUIRE_LIVE", "1");
    vi.stubEnv("LFCP_SERVER_BIN", undefined as unknown as string);
    expect(() => requireExplicitServer()).toThrow(
      /needs LFCP_SERVER_BIN: the lfcp-server built at server\.lock \([0-9a-f]{7}\)/,
    );
    expect(() => liveSkipReason()).toThrow(/needs LFCP_SERVER_BIN/);
    expect(() => serverBinary()).toThrow(/needs LFCP_SERVER_BIN/);
  });

  it("LFCP_REQUIRE_LIVE=1 with a missing LFCP_SERVER_BIN fails", () => {
    vi.stubEnv("LFCP_REQUIRE_LIVE", "1");
    vi.stubEnv("LFCP_SERVER_BIN", "/nonexistent/lfcp-server");
    expect(() => serverBinary()).toThrow(/LFCP_SERVER_BIN does not exist/);
  });

  it("with LFCP_SERVER_BIN, both helpers use it", () => {
    vi.stubEnv("LFCP_REQUIRE_LIVE", "1");
    vi.stubEnv("LFCP_SERVER_BIN", process.execPath);
    expect(serverBinary()).toEqual({ bin: process.execPath });
    expect(requireExplicitServer()).toBe(process.execPath);
  });
});
