// LFCP-067: Obsidian restart recovery, on the two-vault harness. A restart
// is a NEW plugin instance from fresh modules over the same persisted state
// (vault files, secretStorage, vault-scoped local storage, IndexedDB):
// either clean (disable/enable) or a crash (the instance dies: nothing is
// stopped or flushed). fake-indexeddb lives in this process, so a restart
// here cannot cross a real process boundary; the SDK's own child-process
// crash tests (LFCP-038, SQLite) cover that layer.

import {
  loadControlChain,
  queueKeyEpoch,
  queueKeyPackage,
  resourceSyncState,
} from "@openlfcp/client";
import { type PrincipalId, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { sha256 } from "@openlfcp/crypto";
import { rotateEpoch, sealKeyPackage } from "@openlfcp/wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { E2EVault, until } from "../support/e2e-vault";

const binary = serverBinary();
const live = "bin" in binary;

const TASK = "Restart task RT-1";
const OTHER = "Second task RT-2";
const PATH_A = "a.md";
const PATH_B = "b.md";
const PATH_B2 = "b-moved-later.md";

let server: E2EServer;
let A: E2EVault;
let B: E2EVault;
let R: ResourceId;
let taskId: string;
let otherId: string;
let bob: PrincipalId;
/** B's public descriptor (what A's Key Package is sealed to). */
let bobDescriptor: NonNullable<
  ReturnType<E2EVault["runtime"]["collaborationContext"]>
>["principal"]["signer"]["descriptor"];

const MAX = (2n ** 64n - 1n) as never;
const principalOf = (v: E2EVault): PrincipalId => {
  const s = v.runtime.status;
  if (s.kind !== "ready") throw new Error(`${v.name}: ${s.kind}`);
  return s.principalId;
};
/** B's units as A stores them: sequences must be unique and increasing, never reused. */
const bobUnitsOnA = async () => {
  const units = (await A.runtime.storage?.dataUnits.range(R, bob, 1n as never, MAX)) ?? [];
  return units.map((u) => ({
    seq: u.actorSeq,
    id: toHex(u.unitId),
    epoch: u.dataEpoch,
    accepted: u.accepted,
  }));
};
const counters = async (v: E2EVault) =>
  (v.runtime.storage as unknown as { counters(): Promise<ReadonlyMap<string, bigint>> }).counters();
const task = async (v: E2EVault, id = taskId) =>
  (await v.runtime.profileOf(R)).replica.task(id)?.task;
const queued = async (v: E2EVault) => (await v.runtime.storage?.outbound.list(R)) ?? [];
const sha = (bytes: Uint8Array) => toHex(sha256(bytes));

function expectNoReuse(units: { seq: bigint; id: string }[]): void {
  const seqs = units.map((u) => u.seq);
  expect(new Set(seqs).size, "no actor sequence used twice").toBe(seqs.length);
  expect([...seqs].sort((a, b) => (a < b ? -1 : 1))).toEqual(seqs);
}

beforeAll(async () => {
  if (!live) return;
  server = await startServer(binary.bin);
  A = await E2EVault.open("A");
  B = await E2EVault.open("B");
  bob = principalOf(B);
  bobDescriptor = (
    B.runtime.collaborationContext() as NonNullable<
      ReturnType<typeof B.runtime.collaborationContext>
    >
  ).principal.signer.descriptor;
  await A.write(PATH_A, `# A\n\n- [ ] ${TASK}\n- [ ] ${OTHER}\n`);
  await A.command("create-collaboration", ["Restarts", server.url]);
  R = (await A.runtime.registry())[0]?.resourceId as ResourceId;
  for (const t of [TASK, OTHER]) {
    A.focus(PATH_A, t);
    await A.command("share-task-under-cursor", ["Restarts"]);
  }
  const ids = [...A.read(PATH_A).matchAll(/#task:([0-9a-f-]+)/g)].map((m) => m[1] as string);
  [taskId, otherId] = ids as [string, string];
  await A.command("invite-collaborator", ["Restarts", "Read + write"]);
  await B.command("join-collaboration", [
    A.prompter.invitations.at(-1)?.reveal() as string,
    "Restarts",
  ]);
  await until("both tasks on B", async () => ((await task(B, otherId)) ? true : undefined));
  await B.write(PATH_B, "# B private\n\n");
  B.focus(PATH_B, "# B private");
  await B.command("insert-shared-object", ["Restarts", TASK]);
  await B.write(PATH_B2, "# Another B note\n\n");
  B.focus(PATH_B2, "# Another B note");
  await B.command("insert-shared-object", ["Restarts", OTHER]);
}, 300_000);

afterAll(async () => {
  await A?.close();
  await B?.close();
  await server?.stop();
});

describe.skipIf(!live)("restart recovery (LFCP-067)", () => {
  it("1. a clean restart keeps the Principal, the state, no false lock, and the first sync sends nothing", async () => {
    const install = B.app.local.get("openlfcp-install");
    const root = JSON.stringify((await B.runtime.profileOf(R)).replica.root());
    const notes = new Map(B.app.vault.files);
    const units = (await bobUnitsOnA()).length;
    await B.restart("clean");
    expect(B.runtime.status.kind).toBe("ready");
    expect(toHex(principalOf(B))).toBe(toHex(bob));
    expect(B.app.local.get("openlfcp-install")).toBe(install);
    await B.settle(); // startup reconciliation
    expect(JSON.stringify((await B.runtime.profileOf(R)).replica.root())).toBe(root);
    expect(new Map(B.app.vault.files)).toEqual(notes);
    expect(await queued(B)).toEqual([]);
    await A.settle();
    expect((await bobUnitsOnA()).length).toBe(units);
  }, 60_000);

  it("2. a change queued offline survives a crash with the same unit and bytes, and is applied once", async () => {
    B.network.offline = true;
    await B.editLine(PATH_B, `- [ ] ${TASK}`, `- [x] ${TASK}`);
    const [item] = await queued(B);
    expect(item?.kind).toBe("data-unit");
    const bytes = sha(item?.bytes as Uint8Array);
    const before = await bobUnitsOnA();
    await B.restart("crash");
    expect(B.runtime.status.kind).toBe("ready");
    const [after] = await queued(B);
    expect(toHex(after?.itemId as Uint8Array)).toBe(toHex(item?.itemId as Uint8Array));
    expect(sha(after?.bytes as Uint8Array)).toBe(bytes);
    B.network.offline = false;
    await until(
      "the completion on A",
      async () => ((await task(A))?.status === "done" ? true : undefined),
      60_000,
    );
    await until("B's queue drained", async () =>
      (await queued(B)).length === 0 ? true : undefined,
    );
    const units = await bobUnitsOnA();
    expect(units.length).toBe(before.length + 1); // one completion, one unit
    expect(units.at(-1)?.id).toBe(toHex(item?.itemId as Uint8Array));
    expectNoReuse(units);
    await until("A's note shows it", () =>
      A.read(PATH_A).includes(`- [x] ${TASK}`) ? true : undefined,
    );
  }, 120_000);

  it("3. a crash between applying an intent and queueing its unit loses a sequence, never reuses one", async () => {
    const key = [...(await counters(B)).keys()].find((k) => k.startsWith("actor:")) as string;
    const reserved = (await counters(B)).get(key) as bigint;
    B.hangUnitCommits = true;
    // The user's save; the write hangs after the reservation, before the unit is stored.
    B.app.vault.files.set(PATH_B, B.read(PATH_B).replace(TASK, `${TASK} renamed`));
    B.app.vault.trigger("modify", { path: PATH_B });
    B.plugin.changes.flush();
    await until("the reservation", async () =>
      (await counters(B)).get(key) === reserved + 1n ? true : undefined,
    );
    expect(await queued(B)).toEqual([]);
    B.hangUnitCommits = false;
    await B.restart("crash");
    // The note still shows the edit; startup sees it differs from its base and sends it once.
    await until(
      "the rename on A",
      async () => ((await task(A))?.title === `${TASK} renamed` ? true : undefined),
      60_000,
    );
    const units = await bobUnitsOnA();
    expectNoReuse(units);
    expect(units.at(-1)?.seq).toBe(reserved + 2n); // reserved + 1 was lost with the crash
    expect((await counters(B)).get(key)).toBe(reserved + 2n);
    expect(server.log()).not.toMatch(/EQUIVOCATION/);
  }, 120_000);

  it("4. a Key Epoch rotated while B was down: B's queued change is re-applied in the new epoch (G-EP5)", async () => {
    B.network.offline = true;
    await B.editLine(PATH_B, `- [x] ${TASK} renamed`, `- [ ] ${TASK} renamed`);
    const [stale] = await queued(B);
    const staleSeq = (await B.runtime.storage?.dataUnits.get(stale?.itemId as never))
      ?.actorSeq as bigint;
    await B.shutdown("clean");

    // A (the owner) rotates the DEK: KEY_EPOCH closing epoch 0 at what A has, and a Key Package for B.
    const ctx = A.runtime.collaborationContext();
    if (ctx === null) throw new Error("A not ready");
    const chain = await loadControlChain(ctx.storage, R);
    if (chain?.kind !== "linear") throw new Error("no chain");
    const have = (await resourceSyncState(ctx.storage, R)).have;
    const rotation = rotateEpoch(chain.state, ctx.principal.signer, {
      reason: 1n,
      finalFrontier: have,
    });
    // The creator keeps its DEK (queueKeyEpoch): no Key Package for itself.
    await queueKeyEpoch(ctx.storage, ctx.secrets, rotation);
    const kp = await sealKeyPackage({
      resourceId: R,
      epoch: rotation.epoch,
      controlHead: rotation.recordId,
      recipient: bobDescriptor,
      dek: rotation.dek,
      signer: ctx.principal.signer,
    });
    await queueKeyPackage(ctx.storage, kp.bytes);
    await A.runtime.openResource(R);
    ctx.session(server.url).flush();
    await until("the rotation on A, with its DEK", async () => {
      const c = await loadControlChain(ctx.storage, R);
      const row = (await ctx.storage.control.epochs(R)).find((e) => e.epoch === 1n);
      return c?.kind === "linear" && c.state.epoch.epoch === 1n && row?.dekRef != null
        ? true
        : undefined;
    });
    await until("A's queue drained", async () =>
      (await A.runtime.storage?.outbound.list(R))?.length === 0 ? true : undefined,
    );

    // B comes back: its epoch-0 unit is beyond the cutoff; the intent goes out again as a new unit.
    await B.boot();
    B.network.offline = false;
    await until(
      "the reopen on A",
      async () => ((await task(A))?.status === "todo" ? true : undefined),
      60_000,
    );
    const units = await bobUnitsOnA();
    expectNoReuse(units);
    const last = units.at(-1);
    expect(last?.epoch).toBe(1n);
    expect(last?.seq).toBeGreaterThan(staleSeq);
    expect(units.find((u) => u.id === toHex(stale?.itemId as Uint8Array))?.accepted ?? false).toBe(
      false,
    );
    await until("B's queue drained", async () =>
      (await queued(B)).length === 0 ? true : undefined,
    );
    expect(B.read(PATH_B)).toContain(`- [ ] ${TASK} renamed`);
    // The next write after the own-unit exclusion works (§9, baseline.6).
    await B.editLine(PATH_B, `- [ ] ${TASK} renamed`, `- [/] ${TASK} renamed`);
    await until(
      "B's next write on A",
      async () => ((await task(A))?.status === "in_progress" ? true : undefined),
      60_000,
    );
    expectNoReuse(await bobUnitsOnA());
  }, 180_000);

  it("5. notes changed while the plugin was off: edits are sent, moves and detaches respected, nothing else written", async () => {
    await B.settle();
    const unitsBefore = (await bobUnitsOnA()).length;
    await B.shutdown("clean");
    // While off: an edit, a move, a detach, and lost bases for the moved note.
    B.app.vault.files.set(
      PATH_B,
      B.read(PATH_B).replace(`- [/] ${TASK} renamed`, `- [x] ${TASK} renamed`),
    );
    const moved = B.read(PATH_B2);
    B.app.vault.files.delete(PATH_B2);
    B.app.vault.files.set("Archive/b-moved.md", moved);
    await B.boot();
    await B.runtime.localState.put("base:Archive/b-moved.md", null);
    await B.settle();
    await until(
      "the edit on A",
      async () => ((await task(A))?.status === "done" ? true : undefined),
      60_000,
    );
    expect((await bobUnitsOnA()).length).toBe(unitsBefore + 1); // only the edit
    expect(B.read("Archive/b-moved.md")).toBe(moved); // found at its new path, not rewritten
    expect(B.plugin.projection.indexed("Archive/b-moved.md")).toEqual([
      `${toBase64url(R)}#${otherId}`,
    ]);
    // Detached while off: the ref is not recreated.
    await B.shutdown("clean");
    const detached = B.read("Archive/b-moved.md").replace(/\n {2}<!-- lfcp-ref: [^>]+ -->/, "");
    B.app.vault.files.set("Archive/b-moved.md", detached);
    await B.boot();
    await B.settle();
    expect(B.read("Archive/b-moved.md")).toBe(detached);
    expect((await bobUnitsOnA()).length).toBe(unitsBefore + 1);
    expect((await task(A, otherId))?.lifecycle).toBe("active");
  }, 120_000);
});
