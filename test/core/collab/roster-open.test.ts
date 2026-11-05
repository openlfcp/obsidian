// LFCP-04-413: a section of the person's roster opened on a device just
// paired (IDENTITY-PROFILE-01 §5.3 step 11, §6): the SDK stored its chain,
// so it is stored and opened as a joined one is, without a claim.

import { loadControlChain, saveControlChain } from "@openlfcp/client";
import { generateResourceId, toHex } from "@openlfcp/core";
import { afterEach, describe, expect, it } from "vitest";
import { Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

const URL = "wss://sync.example";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

const start = async () => {
  const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(runtime);
  const ctx = runtime.collaborationContext();
  if (ctx === null) throw new Error("not ready");
  return { runtime, ctx };
};

describe("opening a roster section (openFromRoster)", () => {
  it("stores the section with its roster name and opens it, once", async () => {
    const first = await start();
    const R = await first.runtime.createSectionResource({
      name: "Plans",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    const chain = await loadControlChain(first.ctx.storage, R);
    if (chain?.kind !== "linear") throw new Error("no chain");
    const second = await start();
    // What completePairing leaves: the chain (and its route), no Resource row.
    expect((await saveControlChain(second.ctx.storage, chain, null)).ok).toBe(true);
    const collab = new Collaboration(second.runtime, {
      sleep,
      connectTimeoutMs: 50,
      sections: true,
    });
    expect(await collab.openFromRoster(R, "Plans")).toBe(true);
    const entry = (await second.runtime.registry()).find((e) => toHex(e.resourceId) === toHex(R));
    expect(entry).toMatchObject({ localName: "Plans", routes: [URL] });
    expect(second.runtime.sectionProfile(R)).toBeDefined();
    expect(await collab.openFromRoster(R, "Plans")).toBe(false);
  });

  it("refuses a Resource whose chain is not stored", async () => {
    const { runtime } = await start();
    const collab = new Collaboration(runtime, { sleep, connectTimeoutMs: 50, sections: true });
    await expect(collab.openFromRoster(generateResourceId(), null)).rejects.toMatchObject({
      code: "INVALID_CONTROL_CHAIN",
    });
  });
});
