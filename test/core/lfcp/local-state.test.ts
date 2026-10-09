// LFCP-02-098: the plugin's local state sealed at rest. A Task title with
// a unique canary goes through the runtime into a profile checkpoint; after
// the runtime stops, no store of the install's database holds the canary,
// in any value or key, as text or bytes.

import { type LocalStateMeta, localStateKeyRef } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { taskAt } from "../../../src/core/collab";
import { Collaboration } from "../../../src/core/collab/service";
import { databaseName } from "../../../src/core/lfcp/install";
import type { MetaStore } from "../../../src/core/lfcp/local-seal";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { secretSlotId } from "../../../src/core/lfcp/secrets";
import { KeyValueSectionBaseStore } from "../../../src/core/sections/stores";
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

  it("seals the plugin's rows; an older plugin's plaintext rows are sealed at the next start", async () => {
    const CANARY = `CANARY_${crypto.randomUUID()}`;
    const device = new Device();
    const local = new FakeLocal();
    const first = await LfcpRuntime.start(device.env(local));
    running.push(first);
    // An older plugin: plaintext rows and no keyring of its own.
    const meta = (first.storage as unknown as { meta: MetaStore }).meta;
    await meta.put("plugin:base:old.md", { text: `old ${CANARY}` });
    await meta.put("plugin-local-state", null);
    const installId = local.load("openlfcp-install") as string;
    await first.stop();
    running.splice(0);

    const again = await LfcpRuntime.start(device.env(local));
    running.push(again);
    expect(await again.localState.get("base:old.md")).toEqual({ text: `old ${CANARY}` });
    // Through the plugin now: a 0.1 base and a section base, both with the canary.
    await again.localState.put("base:a.md", { [CANARY]: { line: `- [ ] ${CANARY}` } });
    await new KeyValueSectionBaseStore(again.localState).save("projection-1", {
      locator: {
        path: "b.md",
        section: { resourceId: new Uint8Array(32).fill(1), sectionId: "s" },
      },
      state: { title: CANARY, nodes: {}, order: {} },
      revision: "r",
    });
    expect(await again.localState.get("base:a.md")).toEqual({
      [CANARY]: { line: `- [ ] ${CANARY}` },
    });
    const base = await new KeyValueSectionBaseStore(again.localState).load("projection-1");
    expect(base?.state.title).toBe(CANARY);
    expect(base?.locator.section.resourceId).toEqual(new Uint8Array(32).fill(1));
    const diag = await again.localStateDiagnostics();
    expect(diag?.plugin.rows).toMatchObject({ plaintext: 0, unreadable: 0 });
    expect(diag?.plugin.lastEvent?.kind).toBe("migrated");
    await again.stop();
    running.splice(0);
    const rows = await dump(databaseName(installId));
    expect(rows.filter((v) => holds(v, CANARY))).toEqual([]);
  });

  it("a lost key: no crash, unreadable rows read as absent, said once, a new key from then on", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const first = await LfcpRuntime.start(device.env(local));
    running.push(first);
    await first.localState.put("base:a.md", { a: 1 });
    const installId = local.load("openlfcp-install") as string;
    const keyring = (await (first.storage as unknown as { meta: MetaStore }).meta.get(
      "plugin-local-state",
    )) as LocalStateMeta;
    await first.stop();
    running.splice(0);
    // The secret store lost the plugin's key (an empty slot is a deleted secret).
    device.slots.set(
      secretSlotId(installId, localStateKeyRef(keyring.installId, keyring.generation)),
      "",
    );

    const again = await LfcpRuntime.start(device.env(local));
    running.push(again);
    let said = 0;
    again.onLocalStateUnreadable(() => said++);
    expect(await again.localState.get("base:a.md")).toBeUndefined();
    expect(await again.localState.get("base:a.md")).toBeUndefined();
    expect(said).toBe(1);
    const diag = await again.localStateDiagnostics();
    expect(diag?.plugin).toMatchObject({
      generation: 2,
      keyPresent: true,
      rows: { unreadable: 1 },
    });
    expect(diag?.plugin.lastEvent?.kind).toBe("key-lost");
    // Rewritten rows are sealed under the new key.
    await again.localState.put("base:a.md", { a: 2 });
    expect(await again.localState.get("base:a.md")).toEqual({ a: 2 });
  });

  it("rotation seals every row under a new generation and keeps them readable", async () => {
    const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    running.push(runtime);
    await runtime.localState.put("base:a.md", { a: 1 });
    await runtime.rotateLocalStateKey();
    const diag = await runtime.localStateDiagnostics();
    expect(diag?.plugin).toMatchObject({ generation: 2, phase: "ready", rows: { sealed: 1 } });
    expect(diag?.checkpoints?.generation).toBe(2);
    expect(await runtime.localState.get("base:a.md")).toEqual({ a: 1 });
    expect(runtime.localStateSummary(diag)).toMatch(
      /^Local encryption: lse-v1, generation 2, key present\. Checkpoints: \d+ sealed, 0 plaintext, 0 unreadable\. Plugin data: 1 sealed, 0 plaintext, 0 unreadable\. Last event: rotated at /,
    );
  });
});
