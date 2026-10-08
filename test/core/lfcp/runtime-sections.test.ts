// Shared-sections Resources in the plugin's runtime (MVP 0.2): created
// with the sections profile, opened with their replica and commit binding,
// committed through the session with durable receipts, restored after a
// restart; and the section engine on top, with the real SDK port and its
// records in the install database. Offline (the session never connects).

import { receiptOf } from "@openlfcp/client";
import { toBase64url } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime, UnsupportedProfileError } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import { formatBoundary, formatNodeMarker } from "../../../src/core/sections/grammar";
import {
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { Device, FakeLocal } from "../../support/lfcp-env";

const URL = "wss://offline.example.invalid/v1/ws";
const SECTION = "0192e4a0-0000-7000-8000-000000000001";
const id = (n: number) => `0192e4a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});
const start = async (device: Device, local: FakeLocal) => {
  const r = await LfcpRuntime.start(device.env(local));
  running.push(r);
  return r;
};
const me = (r: LfcpRuntime) => {
  const s = r.status;
  if (s.kind !== "ready") throw new Error(s.kind);
  return s.principalId;
};

describe("shared-sections Resources in the runtime", () => {
  it("creates, opens and commits with a receipt; a restart restores the section", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await r.openSection(R);
    const receipt = await r.commitSection(
      R,
      [{ intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me(r) }],
      { operationId: "create" },
    );
    expect(receipt.durable).toBe(true);
    expect(r.sectionProfile(R)?.replica.snapshot().title.value).toBe("Launch");
    expect((await r.storage?.outbound.list(R))?.length).toBe(receipt.unitIds.length);
    // The 0.1 paths leave it alone.
    await expect(r.openResource(R)).rejects.toBeInstanceOf(UnsupportedProfileError);

    await r.stop();
    const again = await start(device, local);
    await again.openSection(R);
    expect(again.sectionProfile(R)?.replica.snapshot().title.value).toBe("Launch");
    expect(await receiptOf(again.storage as LfcpStorage, R, "create")).toEqual(receipt);
  });

  it("runs the section engine on the runtime, its records in the install database", async () => {
    const device = new Device();
    const local = new FakeLocal();
    const r = await start(device, local);
    const R = await r.createSectionResource({
      name: "Launch",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await r.openSection(R);
    await r.commitSection(
      R,
      [{ intent: "section.create", sectionId: SECTION, title: "Launch", createdBy: me(r) }],
      { operationId: "create" },
    );
    const port = new SdkSectionPort({
      profile: (res) => r.sectionProfile(res),
      commit: (res, intents, o) => r.commitSection(res, intents, o),
      storage: r.storage as LfcpStorage,
      canWrite: () => ({ allowed: true }),
    });
    let n = 10;
    const engine = new SectionEngine({
      port,
      journal: new KeyValueSectionJournalStore(r.localState),
      bases: new KeyValueSectionBaseStore(r.localState),
      newNodeId: () => id(n++),
      newOperationId: () => `op-${n++}`,
      createdBy: me(r),
      newProjectionId: () => "projection",
      tasks: () => undefined,
      newTask: (line, taskId) => ({ id: taskId, title: line }),
    });
    const S = { resourceId: R, sectionId: SECTION };
    const note = (body: string[]) =>
      ["## Launch", formatBoundary("start", S), ...body, formatBoundary("end", S), ""].join("\n");
    const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };
    const run = async (md: string) => {
      const pass = await engine.pass("Launch.md", md, ctx);
      const out = applyChanges(md, pass.changes);
      await engine.written(pass, out);
      return out;
    };
    expect(await run(note([]))).toBe(note([]));
    const out = await run(note(["Draft contract"]));
    expect(out).toBe(note([formatNodeMarker("paragraph", id(10)), "Draft contract"]));
    const snap = port.snapshot(toBase64url(R), SECTION);
    expect(snap?.nodes[id(10)]?.text).toBe("Draft contract");
    // The base is in the install database: a new engine on it sees nothing to do.
    expect(await new KeyValueSectionBaseStore(r.localState).projectionsOf("Launch.md")).toEqual([
      "projection",
    ]);
    expect(await run(out)).toBe(out);
  });
});
