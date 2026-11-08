// LFCP-04-406 review follow-up (obsidian#105, R4): a barrier that arrives
// once the claim has started (or a journaled claim is being settled) must
// not end the join's wait: the claim's answer decides, as before.

import * as client from "@openlfcp/client";
import { controlRecordId, generateResourceId } from "@openlfcp/core";
import { InvitationSecret } from "@openlfcp/crypto";
import { assembleInviteUri } from "@openlfcp/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

vi.mock("@openlfcp/client", async (original) => ({
  ...(await original<typeof import("@openlfcp/client")>()),
  acceptInvitation: vi.fn(),
}));

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  vi.mocked(client.acceptInvitation).mockReset();
});

describe("a barrier during the claim (R4)", () => {
  it.each([
    ["the claim", undefined],
    ["a journaled claim being settled", 1],
  ] as const)("seen during %s: the SDK's timeout stays pending", async (_, attempt) => {
    const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    running.push(runtime);
    const R = generateResourceId();
    const link = assembleInviteUri({
      resourceId: R,
      endpoints: ["wss://example.invalid/v1/ws"],
      grantId: controlRecordId(new Uint8Array(32).fill(3)),
      secret: InvitationSecret.generate(),
    });
    let notify: () => void = () => undefined;
    let happened = false;
    const seen = new Promise<void>((r) => {
      notify = r;
    });
    vi.spyOn(runtime, "barrierSeen").mockReturnValue({
      seen,
      happened: () => happened,
      cancel: () => undefined,
    });
    let timeout = "";
    vi.mocked(client.acceptInvitation).mockImplementation(async (options) => {
      options.onProgress?.(
        attempt === undefined
          ? { stage: "claiming-capability" }
          : { stage: "claiming-capability", attempt },
      );
      happened = true;
      notify();
      timeout = await Promise.race([
        (options.timeout ?? new Promise<void>(() => undefined)).then(() => "fired"),
        sleep(30).then(() => "pending"),
      ]);
      return { kind: "unavailable", resourceId: R, reason: "the answer was lost" };
    });
    const outcome = await new Collaboration(runtime, {
      sleep: () => new Promise(() => undefined),
    }).join(link, { name: "" });
    expect(timeout).toBe("pending");
    // The claim was sent: its outcome stands, not "needs a newer version".
    expect(outcome).toMatchObject({ kind: "unavailable", claimSent: true });
  });
});
