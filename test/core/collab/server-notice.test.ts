import { describe, expect, it } from "vitest";
import { PROJECT_SERVER_HINT, serverHint } from "../../../src/core/collab/server-notice";
import { PROJECT_SERVER } from "../../../src/core/settings";

describe("the project server's notice", () => {
  it("is shown for the project server only", () => {
    expect(serverHint(PROJECT_SERVER)).toBe(PROJECT_SERVER_HINT);
    expect(serverHint(" WSS://SYNC.OpenLFCP.org/v1/ws ")).toBe(PROJECT_SERVER_HINT);
    expect(serverHint("wss://sync.openlfcp.org:443/v1/ws")).toBe(PROJECT_SERVER_HINT);
    for (const other of [
      "",
      "not a url",
      "wss://sync.example.com/v1/ws",
      "wss://sync.openlfcp.org.evil.example/v1/ws",
      "wss://evil.sync.openlfcp.org/v1/ws",
      "wss://user@other.example/?sync.openlfcp.org",
      "https://sync.openlfcp.org/v1/ws",
    ])
      expect(serverHint(other), other).toBeNull();
  });

  it("says who runs it and what it sees, with its privacy note and terms", () => {
    expect(PROJECT_SERVER_HINT.text).toBe(
      "Hosted by the OpenLFCP project (beta). The server sees metadata, not your tasks.",
    );
    expect(PROJECT_SERVER_HINT.links).toEqual([
      {
        label: "Privacy note",
        url: "https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-privacy.md",
      },
      {
        label: "Terms",
        url: "https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-terms.md",
      },
    ]);
  });
});
