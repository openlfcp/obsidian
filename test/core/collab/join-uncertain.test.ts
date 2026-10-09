// LFCP-02-051: a claim sent without an answer. The join says it may have
// gone through and keeps that in mind; a later refusal of the same link as
// used is then explained as this device's own earlier claim, not as
// someone else's. An answer before the claim is a plain retry. Nothing is
// stored either way. The SDK's acceptInvitation is replaced: the network
// cannot be made to drop exactly the claim's answer.

import type { ResourceId } from "@openlfcp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

const answers: { stages: string[]; result: Record<string, unknown> }[] = [];
vi.mock("@openlfcp/client", async (original) => ({
  ...(await original<typeof import("@openlfcp/client")>()),
  acceptInvitation: vi.fn(
    async (o: { onProgress?: (p: { stage: string }) => void; link: string }) => {
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer prepared");
      for (const stage of next.stages) o.onProgress?.({ stage });
      return next.result;
    },
  ),
}));

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

const ALL = ["connecting", "validating-invitation", "retrieving-key", "claiming-capability"];

/** A real one-time link, made offline by another vault. */
async function setup() {
  const owner = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  const joiner = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(owner, joiner);
  const ownerFlows = new Collaboration(owner, { connectTimeoutMs: 50, ackTimeoutMs: 50, sleep });
  const created = await ownerFlows.create({
    name: "Team",
    server: "wss://offline.example.invalid/v1/ws",
  });
  const { link } = await ownerFlows.invite(created.resourceId, "read-write");
  const flows = new Collaboration(joiner, { connectTimeoutMs: 50, sleep, sections: true });
  return { R: created.resourceId as ResourceId, link: link.reveal(), joiner, flows };
}

describe("an uncertain claim", () => {
  it("is reported as possibly accepted; a later 'used' is explained as this device's own", async () => {
    const { R, link, joiner, flows } = await setup();
    answers.push({
      stages: ALL,
      result: { kind: "unavailable", resourceId: R, reason: "connection lost" },
    });
    const first = await flows.join(link, { name: "Team" });
    expect(first.kind).toBe("unavailable");
    expect(first.kind === "unavailable" && first.message).toContain("may have gone through");
    expect(await joiner.hasResource(R)).toBe(false);

    answers.push({
      stages: ALL,
      result: { kind: "refused", resourceId: R, code: "AUTHORIZATION_FAILED", attempts: [] },
    });
    const second = await flows.join(link, { name: "Team" });
    expect(second).toMatchObject({ kind: "refused", code: "AUTHORIZATION_FAILED" });
    expect(second.kind === "refused" && second.message).toContain("this device's earlier attempt");

    // Said once: a further refusal is the plain one.
    answers.push({
      stages: ALL,
      result: { kind: "refused", resourceId: R, code: "AUTHORIZATION_FAILED", attempts: [] },
    });
    const third = await flows.join(link, { name: "Team" });
    expect(third.kind === "refused" && third.message).not.toContain("earlier attempt");
  });

  it("an answer lost before the claim is a plain retry, and a refusal stays plain", async () => {
    const { R, link, flows } = await setup();
    answers.push({
      stages: ALL.slice(0, 3),
      result: { kind: "unavailable", resourceId: R, reason: "timed out" },
    });
    const first = await flows.join(link, { name: "Team" });
    expect(first.kind === "unavailable" && first.message).toContain("try again when online");
    answers.push({
      stages: ALL,
      result: { kind: "refused", resourceId: R, code: "AUTHORIZATION_FAILED", attempts: [] },
    });
    const second = await flows.join(link, { name: "Team" });
    expect(second.kind === "refused" && second.message).not.toContain("earlier attempt");
  });
});
