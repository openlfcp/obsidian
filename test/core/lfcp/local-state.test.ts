// LFCP-02-098: the plugin's local state sealed at rest. A Task title with
// a unique canary goes through the runtime into a profile checkpoint; after
// the runtime stops, no store of the install's database holds the canary,
// in any value or key, as text or bytes.

import { afterEach, describe, expect, it } from "vitest";
import { taskAt } from "../../../src/core/collab";
import { Collaboration } from "../../../src/core/collab/service";
import { databaseName } from "../../../src/core/lfcp/install";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { dump, holds } from "../../support/idb-canary";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

const SERVER = "wss://offline.example.invalid/v1/ws";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

describe("local state at rest", () => {
  it("seals profile checkpoints: a Task title's canary is in no store of the database", async () => {
    const CANARY = `CANARY_${crypto.randomUUID()}`;
    const local = new FakeLocal();
    const runtime = await LfcpRuntime.start(new Device().env(local));
    running.push(runtime);
    const collab = new Collaboration(runtime, { sleep, connectTimeoutMs: 30 });
    const { resourceId } = await collab.create({ name: "Team", server: SERVER });
    const at = taskAt(`- [ ] ${CANARY} contract`, 0);
    if (at.kind !== "local") throw new Error(at.kind);
    const { objectId } = await collab.share(resourceId, at.state);
    // The canary is in the model; the test would see it if it reached the disk.
    expect((await runtime.profileOf(resourceId)).replica.task(objectId)?.task?.title).toContain(
      CANARY,
    );
    const installId = local.load("openlfcp-install") as string;
    await runtime.stop();
    running.splice(0);
    const rows = await dump(databaseName(installId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((v) => holds(v, CANARY))).toEqual([]);
  });
});
