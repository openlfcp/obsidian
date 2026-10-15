// @vitest-environment happy-dom
// LFCP-03-024 (M03-4; U03-09, U03-10, U03-13…U03-17; F-03, F-04): the
// interruption and durable journeys of shared sections, qualified on the
// reference server with real plugins (E2EVault: the plugin on a mock
// Obsidian app, the SDK's signed and encrypted transport, IndexedDB). A
// crash is the harness's: the plugin instance dies (sockets, timers, lock,
// vault handlers; nothing stopped or flushed) and a new one starts over the
// same vault, local storage and IndexedDB. A lost answer is one incoming
// frame dropped (as DropTap does). Each fault is placed before or after a
// named durable effect, and each check reads the journal, the source note,
// the peer and the stored units, not only a notice.
//
//   1. Share: the server hosted the section, its answer (RESOURCE_HOSTED)
//      was lost, then a crash. The start goes on under the same Resource:
//      one Resource stored (no orphan), the note bound once, no lost-hosting
//      notice; a new member joins it and gets its Tasks, never the private
//      text around it.
//   2. An edit committed and sent, the ACK of its DATA_PUT lost, then a
//      crash: the same unit is sent again, applied once by the peer.
//   3. A crash between the SDK's sequence reservation and the unit's write:
//      that sequence is lost, never reused; the edit is sent once.
//   4. An edit queued offline, then a crash: the same unit, the same bytes.
//   5. A claim answered, then a crash before the section was inserted: the
//      same identity, no second claim, a member once.
//   6. Two more copies on one device: one copy removed whole, one note
//      deleted (local only: nothing sent, the peer and the other copy keep
//      everything), then a body deletion (shared: the peer loses the Task).
//   7. A read-only member's edit: held as a kept candidate, never sent;
//      after a crash the note still has it and the candidate is still kept.
//   8. Privacy canaries: no frame on the wire and no byte the server
//      stored holds the private text, the shared titles or the held edit.
//
// Skipped without the server unless LFCP_REQUIRE_LIVE=1 (then an error).

import { fromBase64url, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { sha256 } from "@openlfcp/crypto";
import { decodeMessage, MESSAGE_TYPE } from "@openlfcp/wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Collaboration } from "../../src/core/collab/service";
import { parseSections } from "../../src/core/sections/parser";
import { PANE_VIEW } from "../../src/obsidian/ui/pane-view";
import * as mock from "../mocks/obsidian";
import { answer, click, SECTION_NOTE, SoakPeer } from "../soak/peer";
import { type E2EServer, serverBinary, startServer } from "../support/e2e-server";
import { until } from "../support/e2e-vault";
import { sleep } from "../support/lfcp-env";

const binary = serverBinary();
const live = "bin" in binary;

let server: E2EServer;
let A: SoakPeer;
let B: SoakPeer;
let resource: string;
let R: ResourceId;
/** Every frame each peer sent or received, by peer name. */
const wire = new Map<string, { dir: string; bytes: Uint8Array }[]>();
/** Peers opened by a test, closed at the end. */
const others: SoakPeer[] = [];

const MAX = (2n ** 64n - 1n) as never;
const enc = new TextEncoder();

/** Private text of the owners' notes, outside every section: never on the wire. */
const PRIVATE = [
  "Private intro, never shared.",
  "Private tail.",
  "Private line H0.",
  "Private tail H9.",
];

function tap(p: SoakPeer): SoakPeer {
  const frames = p.vault.network.frames as unknown as {
    push: (...f: { dir: string; bytes: Uint8Array }[]) => number;
  };
  const before = frames.push.bind(frames);
  const log: { dir: string; bytes: Uint8Array }[] = [];
  wire.set(p.name, log);
  frames.push = (...f) => {
    log.push(...f);
    return before(...f);
  };
  return p;
}

async function open(name: string, me: string, seed: number): Promise<SoakPeer> {
  const p = tap(await SoakPeer.open(name, me, server.url, seed));
  if (name !== "A" && name !== "B") others.push(p);
  return p;
}

const messageOf = (bytes: Uint8Array) => {
  try {
    return decodeMessage(Uint8Array.from(bytes)) as {
      type?: string;
      body?: { requestType?: bigint };
    };
  } catch {
    return undefined;
  }
};
const typeOf = (bytes: Uint8Array) => messageOf(bytes)?.type;
const ackOf = (t: bigint) => (bytes: Uint8Array) => {
  const m = messageOf(bytes);
  return m?.type === "ACK" && m.body?.requestType === t;
};
const sent = (p: SoakPeer, type: string) =>
  (wire.get(p.name) ?? []).filter((f) => f.dir === "out" && typeOf(f.bytes) === type).length;

const principalOf = (p: SoakPeer) => {
  const s = p.runtime.status;
  if (s.kind !== "ready") throw new Error(`${p.name}: ${s.kind}`);
  return s.principalId;
};

/** `author`'s units of Resource `r` as `on` stores them. */
async function unitsOf(author: SoakPeer, on: SoakPeer, r = R) {
  const units =
    (await on.runtime.storage?.dataUnits.range(r, principalOf(author), 1n as never, MAX)) ?? [];
  return units.map((u) => ({ seq: u.actorSeq, id: toHex(u.unitId) }));
}

/** No actor sequence used twice; in increasing order. */
function expectNoReuse(units: readonly { seq: bigint }[]): void {
  const seqs = units.map((u) => u.seq);
  expect(new Set(seqs).size, "no actor sequence used twice").toBe(seqs.length);
  expect([...seqs].sort((a, b) => (a < b ? -1 : 1))).toEqual(seqs);
}

/** The SDK's reservation counter of `p`'s sequences in Resource `r`. */
async function reserved(p: SoakPeer, r = R): Promise<bigint | undefined> {
  const counters = await (
    p.runtime.storage as unknown as { counters(): Promise<ReadonlyMap<string, bigint>> }
  ).counters();
  return counters.get(`actor:${toHex(r)}:${toHex(principalOf(p))}`);
}

const queued = async (p: SoakPeer, r = R) =>
  ((await p.runtime.storage?.outbound.list(r)) ?? []).filter((i) => i.kind === "data-unit");

const occurrences = (text: string, part: string) => text.split(part).length - 1;

/** The process dies and a new plugin instance starts over the same state (no pane, no editor). */
async function crash(p: SoakPeer): Promise<void> {
  const leaves = p.vault.app.workspace.leaves;
  for (let i = leaves.length - 1; i >= 0; i--)
    if (leaves[i]?.type === PANE_VIEW) leaves.splice(i, 1);
  await p.vault.shutdown("crash");
  await p.vault.boot(false);
  expect(p.runtime.status.kind).toBe("ready");
}

/** "Insert shared section…" into `path` (closed), the section picked and the preview approved. */
async function insertInto(p: SoakPeer, path: string): Promise<void> {
  const md = new mock.MarkdownView(new mock.TFile(path), p.vault.read(path));
  md.cursorLine = 2;
  const sections = p.vault.plugin.sections;
  if (sections === null) throw new Error("no sections host");
  const done = sections.insertSection(md.editor as never, path);
  await answer("the section choice", (m) => {
    const choices = (m as { choices?: readonly { resource: Uint8Array }[] }).choices;
    const c = choices?.find((x) => toBase64url(x.resource) === resource);
    const choose = (m as { onChooseSuggestion?: (c: unknown) => void }).onChooseSuggestion;
    if (c === undefined || choose === undefined) return false;
    choose.call(m, c);
    m.close();
    return true;
  });
  await answer("the insert preview", click("Insert"));
  await done;
  await p.vault.settle();
}

const copies = (p: SoakPeer, path: string, r = resource) =>
  parseSections(p.vault.read(path)).sections.filter((s) => toBase64url(s.ref.resourceId) === r)
    .length;

/** "Invite collaborator…" with role `role`; the one-time link. */
async function inviteAs(p: SoakPeer, r: string, role: "Read" | "Read + write"): Promise<string> {
  const id = toHex(fromBase64url(r));
  const before = p.vault.prompter.invitations.length;
  await p.vault.command(
    "invite-collaborator",
    [{ choose: (cs) => cs.find((c) => toHex(c.value as Uint8Array) === id)?.value ?? null }, role],
    () => p.vault.prompter.invitations.length > before,
  );
  return p.vault.prompter.invitations.at(-1)?.reveal() as string;
}

/** The members of Resource `r` as `p`'s control chain lists them (principal hex). */
async function members(p: SoakPeer, r = R): Promise<string[]> {
  const collab = new Collaboration(p.runtime, { connectTimeoutMs: 5000, sleep, sections: true });
  return (await collab.status(r)).participants
    .filter((x) => x.invitation === undefined)
    .map((x) => x.principal)
    .sort();
}

beforeAll(async () => {
  if (!live) return;
  server = await startServer(binary.bin);
  A = await open("A", "a", 1);
  B = await open("B", "b", 2);
  ({ resource } = await A.share(6, ["a", "b"]));
  R = fromBase64url(resource) as ResourceId;
  await B.join(await A.invite(resource), "Soak");
  // Into B's closed note: B's edits below are saves of that file.
  await B.insert(resource);
  await until("B's copy current", () =>
    B.vault.read(SECTION_NOTE).includes("b6 fix item") ? true : undefined,
  );
}, 300_000);

afterAll(async () => {
  for (const p of others) await p.vault.close();
  await A?.vault.close();
  await B?.vault.close();
  await server?.stop();
});

describe.skipIf(!live)("interruption and durable journeys (LFCP-03-024)", () => {
  let C: SoakPeer;
  let hosted: string;

  it("1. a share hosted, its answer lost, then a crash: the same Resource, one copy, no orphan, no lost-hosting notice", async () => {
    const path = "Hosted.md";
    const md = [
      "# Hosted",
      "",
      "Private line H0.",
      "",
      "## Hosted work",
      "",
      "- [ ] h1 hosted task",
      "- [ ] h2 hosted task",
      "",
      "## Tail",
      "Private tail H9.",
      "",
    ].join("\n");
    await A.vault.write(path, md);
    const registry = (await A.runtime.registry()).length;
    const stored = (await A.runtime.storage?.resources.list())?.length ?? -1;
    const hosts = sent(A, "RESOURCE_HOST");
    const dropped = A.vault.network.dropped;
    A.vault.network.dropNextIn((b) => typeOf(b) === "RESOURCE_HOSTED");
    const notices = mock.notices.length;
    const view = new mock.MarkdownView({ path } as never, md);
    view.cursorLine = 4;
    void A.vault.plugin.sections?.share(view.editor as never, path).catch(() => undefined);
    await answer("the share preview", click("Share"));
    await until(
      "the hosting answer lost",
      () => (A.vault.network.dropped === dropped + 1 ? true : undefined),
      60_000,
    );
    // Before the crash: the import committed and the note bound (phase projected).
    const bound = parseSections(A.vault.read(path)).sections;
    expect(bound.length).toBe(1);
    hosted = toBase64url(bound[0]?.ref.resourceId as Uint8Array);
    expect(sent(A, "RESOURCE_HOST")).toBe(hosts + 1);

    // Nothing settled the share before the crash: the dead instance's answer was lost.
    expect(mock.notices.slice(notices).some((n) => n.includes("is shared"))).toBe(false);
    await crash(A);
    const restarted = mock.notices.length;
    await until(
      "the share settled after the restart",
      () => (mock.notices.slice(restarted).some((n) => n.includes("is shared")) ? true : undefined),
      120_000,
    );
    const said = mock.notices.slice(notices);
    expect(said.join("\n")).not.toMatch(/stopped syncing|no longer|could not|lost/i);
    // The same Resource, hosted again by its RESOURCE_HOST; nothing else made.
    expect(sent(A, "RESOURCE_HOST")).toBeGreaterThanOrEqual(hosts + 2);
    expect(copies(A, path, hosted)).toBe(1);
    expect(parseSections(A.vault.read(path)).sections.length).toBe(1);
    expect((await A.runtime.registry()).length).toBe(registry + 1);
    expect((await A.runtime.storage?.resources.list())?.length).toBe(stored + 1);
    expect((await A.runtime.registry()).some((e) => toBase64url(e.resourceId) === hosted)).toBe(
      true,
    );
    expect(A.vault.plugin.sections?.actions.flows()).toEqual([]);

    // A new member gets it: its Tasks, once, and none of the private text.
    C = await open("C", "c", 3);
    await C.join(await A.invite(hosted), "Hosted");
    await C.insert(hosted);
    const note = C.vault.read(SECTION_NOTE);
    expect(occurrences(note, "h1 hosted task")).toBe(1);
    expect(occurrences(note, "h2 hosted task")).toBe(1);
    for (const p of PRIVATE) expect(note).not.toContain(p);
  }, 300_000);

  it("2. an edit sent, its ACK lost, then a crash: the same unit is sent again and applied once", async () => {
    const before = await unitsOf(B, A);
    const dropped = B.vault.network.dropped;
    B.vault.network.dropNextIn(ackOf(MESSAGE_TYPE.DATA_PUT));
    await B.vault.editLine(SECTION_NOTE, "b2 draft item", "b2 draft item after a lost ACK");
    await until(
      "the DATA_PUT's ACK lost",
      () => (B.vault.network.dropped === dropped + 1 ? true : undefined),
      60_000,
    );
    const [item] = await queued(B);
    expect(item, "the unit still waits for its ACK").toBeDefined();
    const id = toHex(item?.itemId as Uint8Array);
    const bytes = toHex(sha256(item?.bytes as Uint8Array));
    const puts = sent(B, "DATA_PUT");

    await crash(B);
    await until("B's queue drained", async () =>
      (await queued(B)).length === 0 ? true : undefined,
    );
    expect(sent(B, "DATA_PUT")).toBeGreaterThan(puts);
    await until(
      "the edit on A",
      () => (A.text(SECTION_NOTE).includes("b2 draft item after a lost ACK") ? true : undefined),
      60_000,
    );
    const units = await unitsOf(B, A);
    expect(units.length).toBe(before.length + 1);
    expect(units.at(-1)?.id).toBe(id);
    expectNoReuse(units);
    // The bytes A holds are the bytes queued before the crash.
    const stored = await A.runtime.storage?.dataUnits.range(
      R,
      principalOf(B),
      units.at(-1)?.seq as never,
      MAX,
    );
    expect(toHex(sha256(stored?.[0]?.bytes as Uint8Array))).toBe(bytes);
    expect(occurrences(A.text(SECTION_NOTE), "b2 draft item after a lost ACK")).toBe(1);
  }, 180_000);

  it("3. a crash between a sequence's reservation and its unit's write: lost, never reused; the edit is sent once", async () => {
    const at = (await reserved(B)) as bigint;
    expect(at).toBeGreaterThan(0n);
    B.vault.hangUnitCommits = true;
    const vault = B.vault.app.vault;
    vault.files.set(
      SECTION_NOTE,
      B.vault.read(SECTION_NOTE).replace("b6 fix item", "b6 fix item renamed in a crash"),
    );
    vault.trigger("modify", { path: SECTION_NOTE });
    B.vault.plugin.changes.flush();
    await until("the reservation", async () =>
      (await reserved(B)) === at + 1n ? true : undefined,
    );
    expect(await queued(B)).toEqual([]);
    B.vault.hangUnitCommits = false;

    await crash(B);
    await until(
      "the rename on A",
      () => (A.text(SECTION_NOTE).includes("b6 fix item renamed in a crash") ? true : undefined),
      60_000,
    );
    const units = await unitsOf(B, A);
    expectNoReuse(units);
    expect(units.at(-1)?.seq).toBe(at + 2n); // at + 1 was lost with the crash
    expect(await reserved(B)).toBe(at + 2n);
    expect(occurrences(A.text(SECTION_NOTE), "b6 fix item renamed in a crash")).toBe(1);
    expect(server.log()).not.toMatch(/EQUIVOCATION/);
  }, 180_000);

  it("4. an edit queued offline, then a crash: the same unit and bytes, applied once", async () => {
    const before = await unitsOf(B, A);
    B.offline(true);
    await B.vault.editLine(SECTION_NOTE, "b4 ship item", "b4 ship item queued offline");
    const item = await until("the unit queued", async () => (await queued(B))[0]);
    const id = toHex(item.itemId);
    const bytes = toHex(sha256(item.bytes));

    await crash(B);
    const [after] = await queued(B);
    expect(toHex(after?.itemId as Uint8Array)).toBe(id);
    expect(toHex(sha256(after?.bytes as Uint8Array))).toBe(bytes);
    B.offline(false);
    B.onlineEvent();
    await until(
      "the edit on A",
      () => (A.text(SECTION_NOTE).includes("b4 ship item queued offline") ? true : undefined),
      120_000,
    );
    await until("B's queue drained", async () =>
      (await queued(B)).length === 0 ? true : undefined,
    );
    const units = await unitsOf(B, A);
    expect(units.length).toBe(before.length + 1);
    expect(units.at(-1)?.id).toBe(id);
    expectNoReuse(units);
  }, 180_000);

  it("5. a claim answered, then a crash before the insert: the same identity, a member once, no second claim", async () => {
    const link = await A.invite(resource);
    const principal = toHex(principalOf(C));
    await C.join(link, "Soak");
    expect(
      (await C.runtime.registry()).filter((e) => toBase64url(e.resourceId) === resource),
    ).toHaveLength(1);
    const claims = sent(C, "CONTROL_PUT");

    await crash(C);
    expect(toHex(principalOf(C))).toBe(principal);
    expect(
      (await C.runtime.registry()).filter((e) => toBase64url(e.resourceId) === resource),
    ).toHaveLength(1);
    // The same link again: already a member; nothing is claimed.
    await C.join(link, "Soak");
    expect(sent(C, "CONTROL_PUT")).toBe(claims);
    await until("C a member on A", async () =>
      (await members(A)).includes(principal) ? true : undefined,
    );
    expect((await members(A)).filter((m) => m === principal)).toHaveLength(1);
    // The section loads and inserts as after any join.
    await until(
      "the section loaded on C",
      () => (C.runtime.sectionLoad(R)?.loaded === true ? true : undefined),
      120_000,
    );
  }, 180_000);

  it("6. a copy removed whole and a note deleted are local; a body deletion reaches the peer", async () => {
    for (const path of ["Second.md", "Third.md"]) {
      await B.vault.write(path, `# ${path}\n\nMine.\n`);
      await insertInto(B, path);
      expect(copies(B, path)).toBe(1);
    }
    await sleep(2000);
    const units = (await unitsOf(B, A)).length;
    const at = await reserved(B);
    const aNote = A.text(SECTION_NOTE);
    const aModel = A.model()?.canon;
    const bNote = B.vault.read(SECTION_NOTE);

    // The whole copy removed from Second.md (its markers and every line between them).
    await B.vault.write("Second.md", "# Second.md\n\nMine.\n");
    // Third.md deleted.
    B.vault.app.vault.files.delete("Third.md");
    B.vault.app.vault.trigger("delete", { path: "Third.md" });
    await B.vault.settle();
    await sleep(3000);
    await B.vault.settle();

    expect(await reserved(B), "nothing committed").toBe(at);
    expect(await queued(B)).toEqual([]);
    expect((await unitsOf(B, A)).length).toBe(units);
    expect(A.text(SECTION_NOTE)).toBe(aNote);
    expect(A.model()?.canon).toBe(aModel);
    expect(B.vault.read(SECTION_NOTE)).toBe(bNote);
    expect(B.vault.read("Second.md")).toBe("# Second.md\n\nMine.\n");
    expect(B.vault.app.vault.files.has("Third.md")).toBe(false);

    // A body deletion is shared: A deletes a Task, B's copy loses it, nothing comes back elsewhere.
    A.openEditor();
    const aUnits = (await unitsOf(A, B)).length;
    A.deleteTask("a5 call item");
    await until(
      "B's copy without a5",
      () => (B.vault.read(SECTION_NOTE).includes("a5 call item") ? undefined : true),
      60_000,
    );
    expect((await unitsOf(A, B)).length).toBeGreaterThan(aUnits);
    await sleep(2000);
    expect(B.vault.read("Second.md")).toBe("# Second.md\n\nMine.\n");
    expect(B.vault.app.vault.files.has("Third.md")).toBe(false);
    expect(copies(B, SECTION_NOTE)).toBe(1);
  }, 240_000);

  it("7. a read-only member's edit is a kept candidate: never sent, still kept after a crash", async () => {
    const D = await open("D", "d", 4);
    await D.join(await inviteAs(A, resource, "Read"), "Soak");
    await D.insert(resource);
    await until("D's copy", () =>
      D.vault.read(SECTION_NOTE).includes("a1 plan item") ? true : undefined,
    );
    const held = "a1 plan item held read-only";
    const aNote = A.text(SECTION_NOTE);
    await D.vault.editLine(SECTION_NOTE, "a1 plan item", held);
    await until("the kept candidate", async () => {
      const d = await D.vault.plugin.sections?.diagnostics();
      return d?.candidates.some((c) => c.reason === "read-only") ? d : undefined;
    });
    const kept = (await D.vault.plugin.sections?.diagnostics())?.candidates ?? [];
    expect(await queued(D)).toEqual([]);
    expect(await reserved(D)).toBeUndefined();
    expect(sent(D, "DATA_PUT")).toBe(0);
    // Diagnostics name a candidate's reason and size, never its text.
    expect(JSON.stringify(kept)).not.toContain(held);

    await crash(D);
    await D.vault.settle();
    expect(D.vault.read(SECTION_NOTE)).toContain(held);
    await until("the candidate still kept", async () =>
      (await D.vault.plugin.sections?.diagnostics())?.candidates.some(
        (c) => c.reason === "read-only",
      )
        ? true
        : undefined,
    );
    expect(await queued(D)).toEqual([]);
    expect(sent(D, "DATA_PUT")).toBe(0);
    await sleep(2000);
    expect(A.text(SECTION_NOTE)).toBe(aNote);
    expect(A.text(SECTION_NOTE)).not.toContain(held);
    // D still receives: A's next edit is in D's model; D's held line stays in D's note.
    A.editTask("a3 review item", "review", "reviewed");
    await until(
      "A's edit in D's model",
      () => (D.model()?.canon.includes("a3 reviewed item") ? true : undefined),
      60_000,
    );
    expect(D.vault.read(SECTION_NOTE)).toContain(held);
  }, 240_000);

  it("8. no frame on the wire and nothing the server stored holds the notes' text", async () => {
    const canaries = [
      ...PRIVATE,
      "a1 plan item",
      "b2 draft item after a lost ACK",
      "b6 fix item renamed in a crash",
      "b4 ship item queued offline",
      "h1 hosted task",
      "a1 plan item held read-only",
    ].map((t) => [t, enc.encode(t)] as const);
    const has = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).indexOf(needle) >= 0;
    let frames = 0;
    for (const [name, log] of wire) {
      frames += log.length;
      for (const f of log)
        for (const [t, b] of canaries)
          expect(has(f.bytes, b), `${name} ${f.dir} ${typeOf(f.bytes)}: "${t}"`).toBe(false);
    }
    expect(frames).toBeGreaterThan(100);
    expect(sent(A, "DATA_PUT") + sent(B, "DATA_PUT")).toBeGreaterThan(3);
    const stored = server.stored();
    expect(stored.length).toBeGreaterThan(0);
    for (const s of stored)
      for (const [t, b] of canaries) expect(has(s.bytes, b), `${s.file}: "${t}"`).toBe(false);
  }, 60_000);
});
