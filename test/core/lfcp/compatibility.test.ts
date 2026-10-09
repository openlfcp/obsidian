// LFCP-02-055: two profiles, upgrade and downgrade (MVP-0.2-COMPATIBILITY-
// AND-MIGRATION §11–§12, §15 CM01, CM02, CM10, CM11). On the plugin's
// runtime and the real SDK, offline. The "0.3.x" side is this runtime with
// storage opened as 0.3.x opened it (no local state sealing): the same
// database layout the released plugin writes.

import { toBase64url, toHex } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";
import { IdbLfcpStorage } from "@openlfcp/storage-idb";
import { afterEach, describe, expect, it } from "vitest";
import { taskAt } from "../../../src/core/collab";
import { Collaboration } from "../../../src/core/collab/service";
import { databaseName } from "../../../src/core/lfcp/install";
import { LfcpRuntime, startFailure, UnsupportedProfileError } from "../../../src/core/lfcp/runtime";
import { SdkSectionPort } from "../../../src/core/lfcp/section-port";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import { formatBoundary, formatNodeMarker } from "../../../src/core/sections/grammar";
import {
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { dump, holds } from "../../support/idb-canary";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

const SERVER = "wss://offline.example.invalid/v1/ws";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

const start = async (env: Parameters<typeof LfcpRuntime.start>[0]) => {
  const r = await LfcpRuntime.start(env);
  running.push(r);
  return r;
};
const stop = async (r: LfcpRuntime) => {
  await r.stop();
  running.splice(running.indexOf(r), 1);
};
const local = (line: string) => {
  const at = taskAt(line, 0);
  if (at.kind !== "local") throw new Error(at.kind);
  return at.state;
};

describe("upgrade and downgrade (055)", () => {
  it("CM01: a 0.3.x install with a pending legacy edit upgrades: same identity, same queued bytes, sealed", async () => {
    const CANARY = `CANARY_${crypto.randomUUID()}`;
    const device = new Device();
    const vault = new FakeLocal();
    // 0.3.x: storage without local state sealing.
    const old = await start({
      ...device.env(vault),
      openStorage: (name, onReserved) => IdbLfcpStorage.open(name, { onReserved }),
    });
    const before = old.status;
    if (before.kind !== "ready") throw new Error(before.kind);
    const collab = new Collaboration(old, { sleep, connectTimeoutMs: 30 });
    const { resourceId: R } = await collab.create({ name: "Team", server: SERVER });
    const { objectId } = await collab.share(R, local(`- [ ] ${CANARY} contract`));
    const queued = ((await old.storage?.outbound.list(R)) ?? []).map((i) => toHex(i.bytes));
    expect(queued.length).toBeGreaterThan(0);
    const installId = vault.load("openlfcp-install") as string;
    await stop(old);

    // 0.4: the same device and vault.
    const upgraded = await start(device.env(vault));
    const after = upgraded.status;
    if (after.kind !== "ready") throw new Error(after.kind);
    expect(toHex(after.principalId)).toBe(toHex(before.principalId));
    expect(((await upgraded.storage?.outbound.list(R)) ?? []).map((i) => toHex(i.bytes))).toEqual(
      queued,
    );
    expect((await upgraded.profileOf(R)).replica.task(objectId)?.task?.title).toBe(
      `${CANARY} contract`,
    );
    // It goes on writing as the same Principal, with the next sequence.
    await upgraded.writeIntent(R, {
      intent: "task.set_status",
      id: objectId as never,
      status: "done",
    });
    expect((await upgraded.storage?.outbound.list(R))?.length).toBe(queued.length + 1);
    await stop(upgraded);
    // The 0.3.x plaintext checkpoint is sealed now.
    const rows = await dump(databaseName(installId));
    expect(rows.filter((v) => holds(v, CANARY)).length).toBe(0);
  });

  it("CM02: a section beside legacy Tasks: each Resource by its own profile, no cross-profile write", async () => {
    const r = await start(new Device().env(new FakeLocal()));
    const status = r.status;
    if (status.kind !== "ready") throw new Error(status.kind);
    const collab = new Collaboration(r, { sleep, connectTimeoutMs: 30 });
    const { resourceId: L } = await collab.create({ name: "Legacy", server: SERVER });
    await collab.share(L, local("- [ ] Legacy task"));
    const S = await r.createSectionResource({
      name: "Section",
      endpoints: [SERVER],
      coordinatorUrl: SERVER,
    });
    await r.openSection(S);
    const registry = await r.registry();
    expect(registry.map((e) => [e.localName, e.state])).toEqual(
      expect.arrayContaining([
        ["Legacy", expect.not.stringMatching("unsupported")],
        ["Section", "unsupported"],
      ]),
    );
    await expect(r.openResource(S)).rejects.toBeInstanceOf(UnsupportedProfileError);
    await expect(r.openSection(L)).rejects.toBeInstanceOf(UnsupportedProfileError);
    await expect(
      r.commitSection(L, [{ intent: "section.set_title", title: "x" }], { operationId: "x" }),
    ).rejects.toBeInstanceOf(UnsupportedProfileError);
    await expect(
      r.writeIntent(S, { intent: "task.set_status", id: "x" as never, status: "done" }),
    ).rejects.toBeInstanceOf(UnsupportedProfileError);
  });

  it("sync data from a newer plugin: a plain, non-destructive refusal; nothing is written", async () => {
    const device = new Device();
    const vault = new FakeLocal();
    await stop(await start(device.env(vault)));
    const slots = [...device.slots.values.entries()];
    const local0 = JSON.stringify(vault);
    const newer = new Error(
      "IndexedDB openlfcp-v1-x was written by a newer client than this one (version 2); it is left as it is",
    );
    await expect(
      LfcpRuntime.start({
        ...device.env(vault),
        openStorage: async () => {
          throw newer;
        },
      }),
    ).rejects.toBe(newer);
    expect([...device.slots.values.entries()]).toEqual(slots);
    expect(JSON.stringify(vault)).toBe(local0);
    expect(startFailure(newer)).toMatchObject({ newerData: true });
    expect(startFailure(newer).message).toContain("Your notes are not changed");
    const version = Object.assign(
      new Error("The requested version is less than the existing version."),
      {
        name: "VersionError",
      },
    );
    expect(startFailure(version).newerData).toBe(true);
    expect(startFailure(new Error("disk full"))).toEqual({
      newerData: false,
      message: "disk full",
    });
  });

  it("CM10: edits made while the plugin was off merge with the collaborators' changes since", async () => {
    const r = await start(new Device().env(new FakeLocal()));
    const status = r.status;
    if (status.kind !== "ready") throw new Error(status.kind);
    const me = status.principalId;
    const R = await r.createSectionResource({
      name: "L",
      endpoints: [SERVER],
      coordinatorUrl: SERVER,
    });
    await r.openSection(R);
    const [SEC, A, B] = [1, 2, 3].map((n) => `0192e4a0-0000-7000-8000-00000000000${n}`) as [
      string,
      string,
      string,
    ];
    await r.commitSection(
      R,
      [
        { intent: "section.create", sectionId: SEC, title: "Launch", createdBy: me },
        {
          intent: "paragraph.create",
          id: A,
          parent: SEC,
          after: null,
          text: "Alpha",
          createdBy: me,
        },
        { intent: "paragraph.create", id: B, parent: SEC, after: A, text: "Beta", createdBy: me },
      ],
      { operationId: "create" },
    );
    const port = new SdkSectionPort({
      profile: (res) => r.sectionProfile(res),
      commit: (res, intents, o) => r.commitSection(res, intents, o),
      storage: r.storage as LfcpStorage,
      canWrite: (res) => r.canWriteSection(res),
    });
    const engine = new SectionEngine({
      port,
      journal: new KeyValueSectionJournalStore(r.localState),
      bases: new KeyValueSectionBaseStore(r.localState),
      newNodeId: () => crypto.randomUUID(),
      newOperationId: () => crypto.randomUUID(),
      createdBy: me,
      newProjectionId: () => "projection",
      tasks: () => undefined,
      newTask: (line, id) => ({ id, title: line }),
    });
    const ref = { resourceId: R, sectionId: SEC };
    const note = (a: string, b: string) =>
      [
        "## Launch",
        formatBoundary("start", ref),
        formatNodeMarker("paragraph", A),
        a,
        "",
        formatNodeMarker("paragraph", B),
        b,
        formatBoundary("end", ref),
        "",
      ].join("\n");
    const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };
    const pass = async (md: string) => {
      const p = await engine.pass("L.md", md, ctx);
      const out = applyChanges(md, p.changes);
      await engine.written(p, out);
      return out;
    };
    await pass(note("Alpha", "Beta")); // the base, as the plugin last saw it
    // A collaborator's change arrives while this vault's plugin is off…
    const snap = port.snapshot(toBase64url(R), SEC);
    await port.commit(
      toBase64url(R),
      [
        {
          intent: "text.edit",
          id: A,
          edits: [{ index: 5, deleteCount: 0, insert: " (theirs)" }],
          base: snap?.revision as string,
        },
      ],
      { operationId: "theirs" },
    );
    // …and the user edits the other paragraph in the note meanwhile.
    const out = await pass(note("Alpha", "Beta (mine)"));
    expect(out).toBe(note("Alpha (theirs)", "Beta (mine)"));
    const nodes = port.snapshot(toBase64url(R), SEC)?.nodes;
    expect([nodes?.[A]?.text, nodes?.[B]?.text]).toEqual(["Alpha (theirs)", "Beta (mine)"]);
  });
});
