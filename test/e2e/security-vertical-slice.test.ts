// LFCP-071: the MVP 0.1 security/privacy vertical slice, a RELEASE GATE.
// One scenario crosses every security boundary with real components: two
// (then three) vaults, each with its own app, secretStorage, IndexedDB
// install and Principal, running the real plugin; the real reference server
// binary; real WebSockets; the real invitation and claim flow. There is no
// plaintext transport, fake grant, pre-shared access, in-memory server, or
// disabled signature or epoch check. If this fails, MVP 0.1 is not ready.
//
// The plugin UI covers sharing, inviting, joining, editing and conflict
// resolution. Capability revocation, Data Epoch rotation, a stale write
// beyond a cutoff, Snapshot publication and server-delivered forged units
// have no UI: those steps call the SDK through the plugin runtime
// (runtime.collaborationContext(): the vault's own storage, secrets,
// Principal and pooled session), and each says so.
//
// Revocation scenario (phase 13): the owner revokes B's whole grant (the
// claim's data/read and data/write), then rotates the epoch with a Key
// Package for the owner only. B gets no later DEK and cannot write.
//
// Precise privacy claim: the server never receives application plaintext
// (private Markdown, Task text), DEKs, private keys or invitation secrets.
// It does see protocol metadata by design (Resource and Principal IDs,
// sequences, epochs, sizes, timing); nothing here asserts otherwise.
//
// Steps run in order and share state. Skipped without cargo or ../server
// unless LFCP_REQUIRE_LIVE=1 (then an error). Failure messages carry the
// phase, vault, Resource ID, Control Head, epoch and non-secret object IDs,
// never keys, DEKs, the invitation secret or decrypted test data.

import {
  createDataUnit,
  type DataProfileHandler,
  DataUnitApplier,
  dekResolver,
  latestAcceptedOwnUnit,
  loadControlChain,
  queueControlRecord,
  queueKeyEpoch,
  queueKeyPackage,
  resourceSyncState,
  type SyncEvent,
} from "@openlfcp/client";
import { type DataEpoch, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import {
  dekCommitment,
  exportSecretKeyBytes,
  generateAgreementKeyPair,
  generateSigningKeyPair,
} from "@openlfcp/crypto";
import {
  type CheckedChange,
  checkChange,
  deriveActorId,
  frameProfilePayload,
  PROFILE_ID,
  type SharedObjectsDataProfile,
  SharedObjectsReplica,
  unframeChange,
} from "@openlfcp/shared-objects";
import {
  type AnyMessage,
  type ControlHeadRef,
  createMessage,
  type DataProfileCodec,
  decodeMessage,
  encodeDataUnitPayload,
  InMemorySeenUnits,
  parseDataUnit,
  principalDescriptorFromKeys,
  receiveDataUnit,
  rotateEpoch,
  sealKeyPackage,
  signControlRecord,
  signObject,
  validateControlChain,
} from "@openlfcp/wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverBinary } from "../support/e2e-server";
import { E2EVault, until } from "../support/e2e-vault";
import { codeName, RawSession } from "../support/security-raw-session";
import { type SecurityServer, startSecurityServer } from "../support/security-server";

const binary = serverBinary();
const live = "bin" in binary;

// Unique per run; the markers must never reach the server.
const RUN = toHex(crypto.getRandomValues(new Uint8Array(4)));
const PRIVATE_A = `PRIVATE_A_${RUN}`;
const PRIVATE_B = `PRIVATE_B_${RUN}`;
const TASK = `TASK_SECRET_${RUN}`;
const MARKERS = [PRIVATE_A, PRIVATE_B, TASK, `TASK_SECRET`];
const PATH_A = `Private/a-${RUN}.md`;
const PATH_B = `Work/b-${RUN}.md`;
const NAME = "Security slice";

const NOTE_A = `# Vault A

Only Vault A knows this. ${PRIVATE_A}

- [ ] ${TASK}

Closing private A text.
`;
const NOTE_B = `# Vault B

Only Vault B knows this. ${PRIVATE_B}

Insert here.
`;

let server: SecurityServer;
let A: E2EVault;
let B: E2EVault;
let C: E2EVault;
let R: ResourceId;
let taskId: string;
let phase = "setup";
/** Each vault's private key bytes, captured once for the final rescan (never printed). */
const privateKeys: { label: string; bytes: Buffer }[] = [];
const links: string[] = [];
const eventsOf = new Map<string, SyncEvent[]>();

beforeAll(async () => {
  if (!live) return;
  server = await startSecurityServer(binary.bin);
  A = await E2EVault.open("A");
  B = await E2EVault.open("B");
  C = await E2EVault.open("C");
  for (const v of [A, B, C]) watch(v);
}, 300_000);

afterAll(async () => {
  for (const v of [A, B, C]) await v?.close().catch(() => undefined);
  await server?.stop();
});

/** Collects the vault's SyncEvents (again after a restart: a new runtime). */
function watch(v: E2EVault): void {
  const list = eventsOf.get(v.name) ?? [];
  eventsOf.set(v.name, list);
  v.runtime.on((e) => list.push(e));
}
const events = (v: E2EVault) => eventsOf.get(v.name) ?? [];

/** The SDK inputs of the vault's runtime: its storage, secrets, Principal and pooled sessions. */
function ctx(v: E2EVault) {
  const c = v.runtime.collaborationContext();
  if (c === null) throw new Error(`${v.name}: the runtime is not ready`);
  return c;
}
const me = (v: E2EVault) => ctx(v).principal.signer.descriptor;

async function chainOf(v: E2EVault) {
  const chain = await loadControlChain(ctx(v).storage, R);
  if (chain?.kind !== "linear") throw new Error(`${v.name}: no linear chain (${chain?.kind})`);
  return chain;
}
const profileOf = (v: E2EVault): Promise<SharedObjectsDataProfile> => v.runtime.profileOf(R);
const sharedTask = async (v: E2EVault) => (await profileOf(v)).replica.task(taskId);
const rootOf = async (v: E2EVault) => JSON.stringify((await profileOf(v)).replica.root());
const outbound = async (v: E2EVault) =>
  ((await ctx(v).storage.outbound.list()) ?? []).filter((i) => toHex(i.resourceId) === toHex(R));
const drained = async (v: E2EVault) => ((await outbound(v)).length === 0 ? true : undefined);

/** Every LFCP message on the vault's wire from frame `from` on. */
function messages(v: E2EVault, from = 0): { dir: "in" | "out"; m: AnyMessage }[] {
  const out: { dir: "in" | "out"; m: AnyMessage }[] = [];
  for (const f of v.network.frames.slice(from)) {
    try {
      out.push({ dir: f.dir, m: decodeMessage(f.bytes) });
    } catch {
      // not an LFCP message frame
    }
  }
  return out;
}

/** A failure report: phase, vault, Resource, head, epoch and object IDs; never secrets. */
async function context(v: E2EVault): Promise<string> {
  try {
    const chain = await chainOf(v);
    return `phase ${phase}, vault ${v.name}, Resource ${toHex(R)}, Control Head ${toHex(chain.state.head)} (seq ${chain.state.seq}), epoch ${chain.state.epoch.epoch}, task ${taskId}`;
  } catch {
    return `phase ${phase}, vault ${v.name}`;
  }
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
  phase = name;
  try {
    await body();
  } catch (e) {
    const where = await Promise.all([A, B, C].filter(Boolean).map(context));
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n--- ${where.join("\n--- ")}\n--- server log (tail, no payloads) ---\n${server.log().slice(-3000)}`,
    );
  }
}

/**
 * SDK through the plugin runtime (no UI for it): the owner optionally
 * revokes a grant (CAPABILITY_REVOKE), then rotates the Data Epoch
 * (KEY_EPOCH: fresh DEK, new commitment, the closing epoch's final
 * frontier = what the owner accepted) and seals the new DEK to `readers`
 * only. Both records go to the Control Coordinator with CONTROL_PUT.
 */
async function revokeAndRotate(options: {
  readonly revoke?: string;
  readonly reason: bigint;
  readonly readers: readonly E2EVault[];
}): Promise<{ epoch: DataEpoch; finalFrontier: readonly unknown[] }> {
  const c = ctx(A);
  const chain = await chainOf(A);
  const records = chain.records.map((r) => r.signed.bytes);
  let state = chain.state;
  if (options.revoke !== undefined) {
    const grant = [...state.grants.values()].find(
      (g) => toHex(g.subject) === options.revoke && g.revokedBy === null,
    );
    if (grant === undefined) throw new Error("no live grant to revoke");
    const revoke = signControlRecord(
      { resourceId: R, controlSeq: state.seq + 1n, prevControlId: state.head },
      { type: "CAPABILITY_REVOKE", grantId: grant.id },
      c.principal.signer,
    );
    await queueControlRecord(c.storage, revoke.bytes);
    records.push(revoke.bytes);
    const v = validateControlChain(records);
    if (v.kind !== "linear") throw new Error(v.kind);
    state = v.state;
  }
  const finalFrontier = (await resourceSyncState(c.storage, R)).have;
  const rotation = rotateEpoch(state, c.principal.signer, {
    reason: options.reason,
    finalFrontier,
  });
  // The creator keeps its DEK (queueKeyEpoch): it never needs a Key
  // Package for a key it made.
  await queueKeyEpoch(c.storage, c.secrets, rotation);
  for (const reader of options.readers) {
    const recipient = state.principals.get(toHex(me(reader).principalId)) ?? me(reader);
    const kp = await sealKeyPackage({
      resourceId: R,
      epoch: rotation.epoch,
      controlHead: rotation.recordId,
      recipient,
      dek: rotation.dek,
      signer: c.principal.signer,
    });
    await queueKeyPackage(c.storage, kp.bytes);
  }
  c.session(server.url).flush();
  await until("the owner's records and packages on the server", () => drained(A), 60_000);
  await until(
    "the owner holds the new epoch's DEK",
    async () =>
      (await chainOf(A)).state.epoch.epoch === rotation.epoch &&
      (await dekResolver(c.storage, c.secrets, R)(rotation.epoch)) !== undefined
        ? true
        : undefined,
    60_000,
  );
  return { epoch: rotation.epoch, finalFrontier };
}

// Each phase waits on protocol events with bounded timeouts; the phase itself may take minutes.
describe.skipIf(!live)(
  "LFCP-071 security/privacy vertical slice (RELEASE GATE)",
  { timeout: 240_000 },
  () => {
    it("1. independent Principals: different IDs and keys, kept local, no account service", () =>
      step("1 Principal creation", async () => {
        const ids = [A, B, C].map((v) => toHex(me(v).principalId));
        expect(new Set(ids).size).toBe(3);
        const sign = [A, B].map((v) =>
          Buffer.from(exportSecretKeyBytes(ctx(v).principal.signer.key)),
        );
        const agree = [A, B].map((v) =>
          Buffer.from(exportSecretKeyBytes(ctx(v).principal.agreement)),
        );
        expect(sign[0]?.equals(sign[1] as Buffer)).toBe(false);
        // Kept for phase 17 (a restart reloads the crypto module, so they are read now).
        for (const v of [A, B, C]) {
          privateKeys.push({
            label: `${v.name} signing key`,
            bytes: Buffer.from(exportSecretKeyBytes(ctx(v).principal.signer.key)),
          });
          privateKeys.push({
            label: `${v.name} agreement key`,
            bytes: Buffer.from(exportSecretKeyBytes(ctx(v).principal.agreement)),
          });
        }
        expect(agree[0]?.equals(agree[1] as Buffer)).toBe(false);
        // Nothing was sent anywhere yet: Principals need no server and no account.
        for (const v of [A, B, C]) expect(v.network.frames).toEqual([]);
      }));

    it("2. A creates the Resource (Genesis, epoch-0 DEK and commitment) and hosts it", () =>
      step("2 Resource Genesis", async () => {
        await A.write(PATH_A, NOTE_A);
        expect(await A.command("create-collaboration", [NAME, server.url])).toContain(
          "created and hosted",
        );
        R = (await A.runtime.registry()).find((e) => e.localName === NAME)
          ?.resourceId as ResourceId;
        const chain = await chainOf(A);
        const genesis = chain.records[0]?.signed.bytes as Uint8Array;
        expect(chain.state.owner.principalId).toEqual(me(A).principalId);
        expect(chain.state.dataProfile).toBe(PROFILE_ID);
        expect(chain.state.epoch.epoch).toBe(0n);
        const dek0 = await dekResolver(ctx(A).storage, ctx(A).secrets, R)(0n as DataEpoch);
        expect(dek0).toBeDefined();
        expect(toHex(dekCommitment(R, 0n as DataEpoch, dek0 as never))).toBe(
          toHex(chain.state.epoch.dekCommitment),
        );
        // RESOURCE_HOST went out, and the server stored the exact Genesis bytes.
        expect(messages(A).some((x) => x.dir === "out" && x.m.type === "RESOURCE_HOST")).toBe(true);
        await until("A's objects on the server", () => drained(A));
        expect(server.stored().some((f) => f.bytes.includes(Buffer.from(genesis)))).toBe(true);
        // A shares the Task (child-line ref, the default placement).
        A.focus(PATH_A, TASK);
        expect(await A.command("share-task-under-cursor", [NAME])).toContain("task shared");
        const ref = `lfcp1:${toBase64url(R)}#task:`;
        taskId = (
          new RegExp(`${ref}([0-9a-f-]+)`).exec(A.read(PATH_A)) as RegExpExecArray
        )[1] as string;
        expect(A.read(PATH_A)).toContain(`- [ ] ${TASK}\n  <!-- lfcp-ref: ${ref}${taskId} -->\n`);
        await until("the Task on the server", () => drained(A));
      }));

    it("3. secure invitation: B claims once through HPKE; a second claim of the link fails", () =>
      step("3 secure invitation", async () => {
        await A.command("invite-collaborator", [NAME, "Read + write"]);
        const link = A.prompter.invitations.at(-1)?.reveal() as string;
        links.push(link);
        expect(link).toMatch(/^lfcp:\/\/join\//);
        expect(await B.command("join-collaboration", [link, `${NAME} at B`])).toContain("joined");
        // B is authorized by its own claimed grant, holds the epoch-0 DEK, and the DEK matches the commitment.
        const chain = await chainOf(B);
        const grant = [...chain.state.grants.values()].find(
          (g) => toHex(g.subject) === toHex(me(B).principalId),
        );
        expect(grant?.source).toBe("claim");
        expect(grant?.abilities).toEqual(expect.arrayContaining([1n, 2n])); // data/read, data/write
        const dek0 = await dekResolver(ctx(B).storage, ctx(B).secrets, R)(0n as DataEpoch);
        expect(toHex(dekCommitment(R, 0n as DataEpoch, dek0 as never))).toBe(
          toHex(chain.state.epoch.dekCommitment),
        );
        const invitationGrant = [...chain.state.grants.values()].find((g) => g.claimLimit === 1n);
        expect(invitationGrant?.claimsUsed).toBe(1n);
        // C uses the same one-time link: the coordinator refuses the second claim.
        const refused = await C.command("join-collaboration", [link, `${NAME} at C`]);
        expect(refused).toContain("Not allowed");
        expect(await C.runtime.hasResource(R)).toBe(false);
        expect((await sharedTask(B))?.task?.title).toBe(TASK);
      }));

    it("4. authenticated sessions: HELLO, CHALLENGE, AUTH, READY; one server ID; a credential is no authority", () =>
      step("4 authenticated sessions", async () => {
        const ids = new Set<string>();
        for (const v of [A, B]) {
          const order = messages(v)
            .map((x) => `${x.dir}:${x.m.type}`)
            .filter((t) => /HELLO|CHALLENGE|:AUTH$|READY/.test(t));
          expect(order.slice(0, 4)).toEqual(["out:HELLO", "in:CHALLENGE", "out:AUTH", "in:READY"]);
          for (const x of messages(v))
            if (x.m.type === "READY" || x.m.type === "CHALLENGE")
              ids.add(toHex((x.m.body as { serverId: Uint8Array }).serverId));
        }
        expect(ids.size).toBe(1);
        // A Principal with a hosting credential but no grant: authenticated, yet no Resource authority.
        const key = generateSigningKeyPair();
        const stranger = {
          key,
          descriptor: principalDescriptorFromKeys(key, generateAgreementKeyPair()),
        };
        const raw = new RawSession({
          url: server.url,
          signer: stranger,
          credential: new TextEncoder().encode(`hosting-credential-${RUN}`),
        });
        try {
          await raw.connect();
          const open = await raw.request(
            createMessage("RESOURCE_OPEN", { resourceId: R, heads: [], haves: [], grantIds: [] }),
          );
          expect(open.type === "NACK" && codeName(open.body.code)).toBe("AUTHORIZATION_FAILED");
          const get = await raw.request(
            createMessage("KEY_PACKAGE_GET", {
              resourceId: R,
              recipient: stranger.descriptor.principalId,
              epochs: [0n as DataEpoch],
            }),
          );
          if (get.type === "KEY_PACKAGE_BATCH") expect(get.body.objects).toEqual([]);
          else expect(get.type).toBe("NACK");
        } finally {
          raw.close();
        }
        expect(server.log()).not.toContain(`hosting-credential-${RUN}`);
      }));

    it("5. private Markdown fixtures project one Shared Task: child-line on A, inline on B", () =>
      step("5 private Markdown fixtures", async () => {
        await B.write(PATH_B, NOTE_B);
        B.plugin.settings.refPlacement = "inline";
        B.focus(PATH_B, "Insert here.");
        await B.command("insert-shared-object", [`${NAME} at B`, TASK]);
        B.plugin.settings.refPlacement = "child-line";
        expect(B.read(PATH_B)).toContain(
          `- [ ] ${TASK} <!-- lfcp-ref: lfcp1:${toBase64url(R)}#task:${taskId} -->`,
        );
        expect(B.read(PATH_B)).toContain(PRIVATE_B);
        expect(A.read(PATH_A)).toContain(`- [ ] ${TASK}\n  <!-- lfcp-ref:`);
      }));

    it("6. a Task edit runs the whole pipeline: intent, Automerge, framing, actor key, AEAD, COSE, DATA_PUT", () =>
      step("6 encrypted Task change", async () => {
        const from = A.network.frames.length;
        await A.editLine(PATH_A, `- [ ] ${TASK}`, `- [ ] ${TASK} 📅 2026-11-01`);
        await until("A's change acknowledged", () => drained(A));
        const puts = messages(A, from).filter((x) => x.dir === "out" && x.m.type === "DATA_PUT");
        expect(puts.length).toBeGreaterThan(0);
        const objects = puts.flatMap(
          (x) => (x.m.body as unknown as { objects: Uint8Array[] }).objects,
        );
        for (const o of objects) {
          expect(Buffer.from(o).includes(Buffer.from(TASK))).toBe(false); // ciphertext, not plaintext
          const p = parseDataUnit(o).payload; // canonical COSE_Sign1 that parses as a Data Unit
          expect(toHex(p.actor)).toBe(toHex(me(A).principalId));
        }
        // Independently re-verify A's units from their wire bytes: signature, actor key, AEAD,
        // framing; the plaintext is a §11 frame of an Automerge change of A's §8 actor.
        const mine = await ctx(A).storage.dataUnits.range(
          R,
          me(A).principalId,
          1n as never,
          (2n ** 64n - 1n) as never,
        );
        const seen = new InMemorySeenUnits();
        const plaintexts: CheckedChange[] = [];
        const capture: DataProfileCodec<CheckedChange> = {
          dataProfile: PROFILE_ID,
          encode: () => {
            throw new Error("decode only");
          },
          decode: (plaintext) => {
            const c = unframeChange(plaintext);
            plaintexts.push(c);
            return c;
          },
        };
        const view = await chainOf(A);
        for (const u of mine) {
          const r = await receiveDataUnit(view, u.bytes, {
            seen,
            dek: dekResolver(ctx(A).storage, ctx(A).secrets, R),
            profile: capture,
          });
          expect(r.kind).toBe("accepted"); // receiveDataUnit records it in `seen`
        }
        expect(
          objects.every((o) => mine.some((u) => Buffer.from(u.bytes).equals(Buffer.from(o)))),
        ).toBe(true);
        const actor = toHex(deriveActorId(R, me(A).principalId));
        expect(plaintexts.every((c) => c.actor === actor)).toBe(true);
        const replay = SharedObjectsReplica.fromChanges(
          plaintexts.map((c) => c.bytes),
          { resource: R, principal: me(B).principalId },
        ).replica;
        expect(replay.task(taskId)?.task?.due).toBe("2026-11-01");
        // No plaintext transport: no frame of either vault carries the Task text.
        for (const v of [A, B])
          for (const f of v.network.frames)
            expect(Buffer.from(f.bytes).includes(Buffer.from(TASK))).toBe(false);
      }));

    it("7. the server stores opaque units: no private Markdown or Task plaintext in its state or log", () =>
      step("7 server privacy", async () => {
        const stored = server.stored();
        expect(stored.length).toBeGreaterThan(0);
        for (const { file, bytes } of stored)
          for (const m of MARKERS)
            expect(bytes.includes(Buffer.from(m)), `${m} in ${file}`).toBe(false);
        for (const m of MARKERS) expect(server.log().includes(m), `${m} in the log`).toBe(false);
        // The stored unit is exactly the signed ciphertext object A sent.
        const last = (
          await ctx(A).storage.dataUnits.range(
            R,
            me(A).principalId,
            1n as never,
            (2n ** 64n - 1n) as never,
          )
        ).at(-1);
        expect(stored.some((f) => f.bytes.includes(Buffer.from(last?.bytes as Uint8Array)))).toBe(
          true,
        );
      }));

    it("8. two-way sync: B changes the title, A sets the due date; same ObjectId, private text untouched", () =>
      step("8 two-way sync", async () => {
        const privateA = A.read(PATH_A).replace(/^- \[.\].*\n( {2}<!--.*\n)?/m, "");
        await B.editLine(PATH_B, `${TASK} 📅 2026-11-01 <!--`, `${TASK} B 📅 2026-11-01 <!--`);
        await until("B's title on A", () =>
          A.read(PATH_A).includes(`${TASK} B`) ? true : undefined,
        );
        await A.editLine(PATH_A, "📅 2026-11-01", "📅 2026-11-15");
        await until("A's due date on B", () =>
          B.read(PATH_B).includes("📅 2026-11-15 <!--") ? true : undefined,
        );
        expect((await sharedTask(A))?.task).toMatchObject({
          id: taskId,
          title: `${TASK} B`,
          due: "2026-11-15",
        });
        expect(await rootOf(A)).toBe(await rootOf(B));
        expect(A.read(PATH_A).replace(/^- \[.\].*\n( {2}<!--.*\n)?/m, "")).toBe(privateA);
        expect(B.read(PATH_B)).toContain(PRIVATE_B);
        expect(A.read(PATH_A)).toContain(`${TASK} B 📅 2026-11-15\n  <!-- lfcp-ref:`);
        expect(B.read(PATH_B)).toContain(`${TASK} B 📅 2026-11-15 <!-- lfcp-ref:`);
      }));

    it("9. offline edits on both sides converge through real DATA_HAVE / DATA_GET / DATA_BATCH", () =>
      step("9 offline + Have catch-up", async () => {
        B.network.offline = true;
        await A.editLine(PATH_A, `${TASK} B`, `${TASK} B2`);
        await until("A's edit acknowledged", () => drained(A));
        await B.editLine(PATH_B, "📅 2026-11-15", "📅 2026-11-20");
        expect((await sharedTask(B))?.task?.title).toBe(`${TASK} B`);
        const from = B.network.frames.length;
        B.network.offline = false;
        await until(
          "both edits on both vaults",
          () =>
            A.read(PATH_A).includes(`${TASK} B2 📅 2026-11-20`) &&
            B.read(PATH_B).includes(`${TASK} B2 📅 2026-11-20 <!--`)
              ? true
              : undefined,
          60_000,
        );
        // Real anti-entropy, no state copy: on reconnect the Have vectors ride on RESOURCE_OPEN /
        // RESOURCE_OPENED (§66), then DATA_GET / DATA_BATCH fetch what B lacks; DATA_HAVE is the
        // periodic exchange while LIVE.
        const after = messages(B, from);
        const types = after.map((x) => `${x.dir}:${x.m.type}`);
        const open = after.find((x) => x.dir === "out" && x.m.type === "RESOURCE_OPEN");
        if (open === undefined) throw new Error("B did not reopen the Resource");
        expect((open.m.body as unknown as { haves: unknown[] }).haves.length).toBeGreaterThan(0);
        expect(types, types.join(" ")).toEqual(
          expect.arrayContaining(["in:RESOURCE_OPENED", "out:DATA_GET", "in:DATA_BATCH"]),
        );
        expect(types.indexOf("out:DATA_GET")).toBeGreaterThan(types.indexOf("in:RESOURCE_OPENED"));
        await until("a periodic DATA_HAVE from B", () =>
          messages(B).some((x) => x.dir === "out" && x.m.type === "DATA_HAVE") ? true : undefined,
        );
        expect(await rootOf(A)).toBe(await rootOf(B));
      }));

    it("10. a semantic conflict (done vs cancelled) is visible on both and resolved by an intent", () =>
      step("10 semantic conflict", async () => {
        A.network.offline = true;
        B.network.offline = true;
        await A.editLine(PATH_A, `- [ ] ${TASK} B2`, `- [x] ${TASK} B2`);
        await B.editLine(PATH_B, `- [ ] ${TASK} B2`, `- [-] ${TASK} B2`);
        A.network.offline = false;
        B.network.offline = false;
        for (const v of [A, B])
          await until(
            `the conflict on ${v.name}`,
            async () => ((await sharedTask(v))?.fields.status.conflicted ? true : undefined),
            60_000,
          );
        for (const v of [A, B]) {
          await v.settle();
          // Both values stay: no timestamp or UUID picks a winner.
          expect((await sharedTask(v))?.fields.status.values).toEqual(["cancelled", "done"]);
          expect(v.host.statusBar[0]?.text).toMatch(/1 shared task has a conflict/);
        }
        B.focus(PATH_B, TASK);
        expect(await B.command("resolve-shared-conflict", ["status", "done"])).toContain(
          "resolved",
        );
        for (const v of [A, B])
          await until(
            `the resolution on ${v.name}`,
            async () => {
              const t = await sharedTask(v);
              return t?.fields.status.conflicted === false && t.task?.status === "done"
                ? true
                : undefined;
            },
            60_000,
          );
        expect(await rootOf(A)).toBe(await rootOf(B));
      }));

    it("11. a crashed plugin restarts with its Principal, sequence, head, state and pending bytes", () =>
      step("11 client restart", async () => {
        await until("B idle", () => drained(B));
        B.network.offline = true;
        await B.editLine(PATH_B, `${TASK} B2`, `${TASK} B3`);
        const before = {
          principal: toHex(me(B).principalId),
          head: toHex((await chainOf(B)).state.head),
          root: await rootOf(B),
          actorSeq: (await profileOf(B)).replica.actorSeq,
          pending: (await outbound(B)).map((i) => [
            toHex(i.itemId),
            Buffer.from(i.bytes).toString("hex"),
          ]),
        };
        expect(before.pending).toHaveLength(1);
        await B.restart("crash");
        watch(B);
        expect(toHex(me(B).principalId)).toBe(before.principal);
        expect(toHex((await chainOf(B)).state.head)).toBe(before.head);
        expect(await rootOf(B)).toBe(before.root);
        expect((await profileOf(B)).replica.actorSeq).toBe(before.actorSeq);
        expect(
          (await outbound(B)).map((i) => [toHex(i.itemId), Buffer.from(i.bytes).toString("hex")]),
        ).toEqual(before.pending);
        B.network.offline = false;
        await until(
          "B's pending edit on A",
          () => (A.read(PATH_A).includes(`${TASK} B3`) ? true : undefined),
          60_000,
        );
        await until("B idle again", () => drained(B));
        // Exactly once: one unit per B sequence on A, and the next write takes the next sequence.
        const units = await ctx(A).storage.dataUnits.range(
          R,
          me(B).principalId,
          1n as never,
          (2n ** 64n - 1n) as never,
        );
        expect(new Set(units.map((u) => u.actorSeq)).size).toBe(units.length);
        await B.editLine(PATH_B, `${TASK} B3`, `${TASK} B4`);
        await until("B4 on A", () => (A.read(PATH_A).includes(`${TASK} B4`) ? true : undefined));
        expect((await profileOf(B)).replica.actorSeq).toBe(before.actorSeq + 1);
        // The projection index was rebuilt: B's note follows A again.
        await A.editLine(PATH_A, "📅 2026-11-20", "📅 2026-11-25");
        await until("A's edit in B's restarted note", () =>
          B.read(PATH_B).includes("📅 2026-11-25 <!--") ? true : undefined,
        );
      }));

    it("12. an abruptly restarted server keeps its ID, the Resource, head, units and packages", () =>
      step("12 server restart", async () => {
        const readyIds = (v: E2EVault, from = 0) =>
          messages(v, from)
            .filter((x) => x.m.type === "READY")
            .map((x) => toHex((x.m.body as { serverId: Uint8Array }).serverId));
        const id = readyIds(A)[0];
        const objects = (await profileOf(A)).replica.objectIds().length;
        const fromA = A.network.frames.length;
        const fromB = B.network.frames.length;
        await server.restart();
        for (const v of [A, B])
          await until(
            `${v.name} LIVE again`,
            () =>
              v.runtime.phase(R) === "LIVE" &&
              (v === A ? A.network.frames.length > fromA : B.network.frames.length > fromB)
                ? true
                : undefined,
            60_000,
          );
        expect(new Set([...readyIds(A, fromA), ...readyIds(B, fromB)])).toEqual(new Set([id]));
        // The Resource, its head, units and Key Packages are still served, to a new session.
        const raw = new RawSession({ url: server.url, signer: ctx(B).principal.signer });
        try {
          await raw.connect();
          const opened = await raw.request(
            createMessage("RESOURCE_OPEN", { resourceId: R, heads: [], haves: [], grantIds: [] }),
          );
          expect(opened.type).toBe("RESOURCE_OPENED");
          const heads = (opened.body as unknown as { heads: ControlHeadRef[] }).heads;
          expect(heads.map((h) => toHex(h.recordId))).toEqual([
            toHex((await chainOf(A)).state.head),
          ]);
          const kp = await raw.request(
            createMessage("KEY_PACKAGE_GET", {
              resourceId: R,
              recipient: me(B).principalId,
              epochs: [0n as DataEpoch],
            }),
          );
          expect(kp.type).toBe("KEY_PACKAGE_BATCH");
        } finally {
          raw.close();
        }
        await A.editLine(PATH_A, `${TASK} B4`, `${TASK} after restart`);
        await until(
          "the post-restart edit on B",
          () => (B.read(PATH_B).includes(`${TASK} after restart`) ? true : undefined),
          60_000,
        );
        expect((await profileOf(A)).replica.objectIds().length).toBe(objects);
        expect((await profileOf(B)).replica.objectIds().length).toBe(objects);
      }));

    let staleSeq = 0;
    it("13a, 14a. a routine rotation cuts off B's offline work; B re-applies it as new units and keeps writing (§9)", () =>
      step("14a rotation with an offline writer", async () => {
        await until("idle", async () =>
          (await drained(A)) && (await drained(B)) ? true : undefined,
        );
        const seq0 = (await profileOf(B)).replica.actorSeq;
        B.network.offline = true;
        await B.editLine(PATH_B, `${TASK} after restart`, `${TASK} offline in epoch 0`);
        expect((await profileOf(B)).replica.actorSeq).toBe(seq0 + 1);
        const [stale] = await outbound(B);
        staleSeq = Number(parseDataUnit(stale?.bytes as Uint8Array).payload.actorSeq);
        // SDK through the plugin runtime: KEY_EPOCH 0 → 1 (routine), packages for A and B.
        const { epoch } = await revokeAndRotate({ reason: 0n, readers: [A, B] });
        expect(epoch).toBe(1n);
        B.network.offline = false;
        // B's unit is beyond the cutoff: never merged anywhere; B re-applies its intent in epoch 1.
        await until(
          "B's re-applied edit on A",
          () => (A.read(PATH_A).includes(`${TASK} offline in epoch 0`) ? true : undefined),
          90_000,
        );
        const staleRow = await ctx(B).storage.dataUnits.get(
          parseDataUnit(stale?.bytes as Uint8Array).signed.id as never,
        );
        expect(staleRow?.status).toBe("quarantined");
        const mineOnA = await ctx(A).storage.dataUnits.range(
          R,
          me(B).principalId,
          1n as never,
          (2n ** 64n - 1n) as never,
        );
        const reapplied = mineOnA.filter((u) => u.accepted && u.dataEpoch === 1n);
        expect(reapplied.length).toBeGreaterThan(0);
        expect(mineOnA.some((u) => u.actorSeq === BigInt(staleSeq) && u.accepted)).toBe(false);
        // The removed change's Automerge sequence was reused, not skipped (§9 own exclusion).
        expect((await profileOf(B)).replica.actorSeq).toBe(seq0 + 1);
        expect((await profileOf(B)).replica.writable).toBe(true);
        // And B keeps writing in epoch 1.
        await B.editLine(PATH_B, `${TASK} offline in epoch 0`, `${TASK} epoch 1`);
        await until(
          "B's epoch-1 edit on A",
          () => (A.read(PATH_A).includes(`${TASK} epoch 1`) ? true : undefined),
          60_000,
        );
        expect(events(B).filter((e) => e.type === "error" && e.code === "SEQUENCE_REUSE")).toEqual(
          [],
        );
        expect(await rootOf(A)).toBe(await rootOf(B));
      }));

    let staleBytes: Uint8Array;
    it("13b, 14b, 15. A revokes B (data/read and data/write) and rotates; B's stale write is refused and quarantined", () =>
      step("13-15 revocation, rotation, stale write", async () => {
        await until("idle", async () =>
          (await drained(A)) && (await drained(B)) ? true : undefined,
        );
        B.network.offline = true;
        // B, offline and unaware, edits under its epoch-1 key: this unit will be beyond the cutoff.
        await B.editLine(PATH_B, `${TASK} epoch 1`, `${TASK} stale`);
        staleBytes = (await outbound(B))[0]?.bytes as Uint8Array;
        expect(parseDataUnit(staleBytes).payload.dataEpoch).toBe(1n);
        // SDK through the plugin runtime: CAPABILITY_REVOKE of B's claimed grant, then KEY_EPOCH 1 → 2
        // (reason 1, member revoked) with a Key Package for A only.
        const before = await rootOf(A);
        const { epoch } = await revokeAndRotate({
          revoke: toHex(me(B).principalId),
          reason: 1n,
          readers: [A],
        });
        expect(epoch).toBe(2n);
        const chain = await chainOf(A);
        expect(
          [...chain.state.grants.values()].find(
            (g) => toHex(g.subject) === toHex(me(B).principalId),
          )?.revokedBy,
        ).not.toBeNull();
        // The server refuses B's stale unit.
        const raw = new RawSession({ url: server.url, signer: ctx(B).principal.signer });
        try {
          await raw.connect();
          const put = await raw.request(
            createMessage("DATA_PUT", { resourceId: R, objects: [staleBytes] }),
          );
          expect(put.type === "NACK" && codeName(put.body.code)).toBe("STALE_DATA_EPOCH");
          // B gets no epoch-2 DEK: no package is served for it.
          const kp = await raw.request(
            createMessage("KEY_PACKAGE_GET", {
              resourceId: R,
              recipient: me(B).principalId,
              epochs: [2n as DataEpoch],
            }),
          );
          if (kp.type === "KEY_PACKAGE_BATCH") expect(kp.body.objects).toEqual([]);
          else expect(kp.type).toBe("NACK");
        } finally {
          raw.close();
        }
        // A client given the bytes directly (as a malicious server could) quarantines them, keeps the
        // evidence and does not merge. SDK through the plugin runtime: A's storage and Shared Objects handler.
        const profile = await profileOf(A);
        const applier = new DataUnitApplier({
          storage: ctx(A).storage,
          dek: dekResolver(ctx(A).storage, ctx(A).secrets, R),
          handlers: [
            {
              dataProfile: profile.dataProfile,
              codecFor: (u) => profile.codecFor(u),
              apply: (u, v) => profile.apply(u, v),
              exclude: (ids) => profile.exclude(ids),
            } satisfies DataProfileHandler<CheckedChange> as DataProfileHandler<unknown>,
          ],
        });
        expect(await applier.receive(chain, staleBytes)).toMatchObject({
          kind: "quarantined",
          code: "STALE_DATA_EPOCH",
        });
        expect(
          (await ctx(A).storage.dataUnits.get(parseDataUnit(staleBytes).signed.id as never))
            ?.status,
        ).toBe("quarantined");
        expect(await rootOf(A)).toBe(before);
        expect(A.read(PATH_A)).not.toContain(`${TASK} stale`);
        // B back online: it is no longer allowed to open the Resource, and its stale item is kept, not dropped.
        const fromB = B.network.frames.length;
        B.network.offline = false;
        await until(
          "B refused",
          () =>
            events(B).some((e) => e.type === "error" && e.code === "AUTHORIZATION_FAILED")
              ? true
              : undefined,
          30_000,
        ).catch((e) => {
          const wire = messages(B, fromB).map(
            (x) =>
              `${x.dir}:${x.m.type}${x.m.type === "NACK" || x.m.type === "ERROR" ? `(${codeName((x.m.body as unknown as { code: bigint }).code)})` : ""}`,
          );
          const errs = events(B)
            .filter((x) => x.type === "error" || x.type === "nack")
            .map(
              (x) =>
                `${x.type}:${"code" in x ? x.code : JSON.stringify(x.outcome, (_, v) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? "<bytes>" : v)).slice(0, 160)}`,
            );
          throw new Error(
            `${(e as Error).message}\nB wire: ${wire.join(" ")}\nB errors: ${errs.join(" | ")}`,
          );
        });
        expect(
          (await outbound(B)).some((i) => Buffer.from(i.bytes).equals(Buffer.from(staleBytes))),
        ).toBe(true);
        expect(
          await dekResolver(ctx(B).storage, ctx(B).secrets, R)(2n as DataEpoch),
        ).toBeUndefined();
      }));

    it("16. a real Snapshot: a new member loads it, catches up beyond its frontier, equals full replay", () =>
      step("16 Snapshot", async () => {
        // SDK through the plugin runtime: A publishes a signed, encrypted Snapshot of its save image.
        await ctx(A).session(server.url).publishSnapshot(R);
        await until("the Snapshot on the server", () => drained(A));
        expect(events(A).some((e) => e.type === "snapshot-published")).toBe(true);
        await A.editLine(PATH_A, `${TASK} epoch 1`, `${TASK} after snapshot`);
        await until("post-Snapshot unit on the server", () => drained(A));
        // C joins through a fresh invitation (the product path) and catches up from the Snapshot.
        await A.command("invite-collaborator", [NAME, "Read"]);
        const link = A.prompter.invitations.at(-1)?.reveal() as string;
        links.push(link);
        expect(await C.command("join-collaboration", [link, `${NAME} at C`])).toContain("joined");
        await C.runtime.openResource(R);
        await until(
          "C has the post-Snapshot state",
          async () =>
            (await C.runtime.hasResource(R)) &&
            (await sharedTask(C))?.task?.title === `${TASK} after snapshot`
              ? true
              : undefined,
          60_000,
        );
        expect(events(C).some((e) => e.type === "snapshot-loaded")).toBe(true);
        // Snapshot + catch-up equals A's full state; Control came from the chain, not the Snapshot.
        expect(await rootOf(C)).toBe(await rootOf(A));
        expect(toHex((await chainOf(C)).state.head)).toBe(toHex((await chainOf(A)).state.head));
        // Earlier-epoch units within their cutoffs stay accepted for C (covered by the Snapshot).
        const bOnC = await ctx(C).storage.dataUnits.range(
          R,
          me(B).principalId,
          1n as never,
          (2n ** 64n - 1n) as never,
        );
        expect(bOnC.filter((u) => u.dataEpoch === 0n).every((u) => u.accepted)).toBe(true);
      }));

    it("18. the client verifies every server-delivered unit: forged units are refused, not merged", () =>
      step("18 server trust", async () => {
        // SDK through the plugin runtime: A's own key signs two units the server accepts but a
        // client must refuse. (1) Encrypted under a wrong key (AEAD fails). (2) A valid unit whose
        // Shared Objects change belongs to B's actor (§8, §11: CHANGE_ACTOR_MISMATCH).
        const c = ctx(A);
        const chain = await chainOf(A);
        const dek = await dekResolver(c.storage, c.secrets, R)(chain.state.epoch.epoch);
        const profile = await profileOf(A);
        if (dek === undefined) throw new Error("A has no current DEK");
        const bActor = toHex(deriveActorId(R, me(B).principalId));
        const bChange = profile.replica
          .changes()
          .map(checkChange)
          .find((x) => x.actor === bActor) as CheckedChange;
        // (1) Garbage ciphertext under a valid signature, as the SDK would never produce it.
        const garbage = signObject(
          encodeDataUnitPayload({
            resourceId: R,
            dataEpoch: chain.state.epoch.epoch,
            actor: me(A).principalId,
            actorSeq: await c.storage.actorSequences.reserveNext(R, me(A).principalId),
            prevDataUnitId: await latestAcceptedOwnUnit(c.storage, R, me(A).principalId),
            controlHead: chain.state.head,
            ciphertext: crypto.getRandomValues(new Uint8Array(48)),
          }),
          c.principal.signer,
        );
        // (2) A correctly encrypted unit framing B's change: the codec is A's own, not the profile's.
        const misattributed = await createDataUnit({
          view: chain,
          controlHead: chain.state.head,
          actor: c.principal.signer,
          dek: dek as never,
          sequences: c.storage.actorSequences,
          previousUnitId: await latestAcceptedOwnUnit(c.storage, R, me(A).principalId),
          profile: {
            dataProfile: PROFILE_ID,
            encode: () => frameProfilePayload(bChange.bytes),
            decode: () => undefined,
          } as never,
          value: undefined,
        });
        const forged = [garbage.bytes, misattributed.bytes];
        const before = await rootOf(C);
        const raw = new RawSession({ url: server.url, signer: c.principal.signer });
        try {
          await raw.connect();
          for (const bytes of forged) {
            const put = await raw.request(
              createMessage("DATA_PUT", { resourceId: R, objects: [bytes] }),
            );
            expect(put.type).toBe("ACK"); // the server cannot tell
          }
        } finally {
          raw.close();
        }
        const ids = forged.map((b) => toHex(parseDataUnit(b).signed.id));
        const outcome = (id: string) =>
          events(C).find(
            (e) =>
              e.type === "unit" &&
              "unitId" in e.outcome &&
              toHex(e.outcome.unitId as Uint8Array) === id,
          );
        await until(
          "C refused both forged units",
          () => (ids.every((id) => outcome(id)) ? true : undefined),
          60_000,
        );
        expect(outcome(ids[0] as string)).toMatchObject({
          outcome: { kind: "local-failure", reason: "AEAD" },
        });
        expect(outcome(ids[1] as string)).toMatchObject({
          outcome: { kind: "local-failure", reason: "PROFILE_REJECTED" },
        });
        expect(await rootOf(C)).toBe(before);
        for (const id of ids)
          expect(
            (await ctx(C).storage.dataUnits.get(Uint8Array.from(Buffer.from(id, "hex")) as never))
              ?.accepted ?? false,
          ).toBe(false);
        // A's next real edit still reaches C: the forged units wedged nothing.
        await A.editLine(PATH_A, `${TASK} after snapshot`, `${TASK} final`);
        await until(
          "A's final edit on C",
          async () => ((await sharedTask(C))?.task?.title === `${TASK} final` ? true : undefined),
          60_000,
        );
      }));

    it("17. final rescan: no Markdown, Task plaintext, DEK, private key or invitation secret on the server", () =>
      step("17 final privacy", async () => {
        const secrets: { label: string; bytes: Buffer }[] = [...privateKeys];
        expect(secrets).toHaveLength(6);
        for (const e of [0n, 1n, 2n]) {
          const dek = await dekResolver(ctx(A).storage, ctx(A).secrets, R)(e as DataEpoch);
          if (dek !== undefined)
            secrets.push({
              label: `DEK of epoch ${e}`,
              bytes: Buffer.from(exportSecretKeyBytes(dek)),
            });
        }
        expect(secrets.filter((s) => s.label.startsWith("DEK"))).toHaveLength(3);
        for (const link of links) {
          const secret = link.slice(link.indexOf("#secret=") + 8);
          secrets.push({ label: "an invitation secret", bytes: Buffer.from(secret) });
          secrets.push({ label: "an invitation link", bytes: Buffer.from(link) });
        }
        const texts = MARKERS.map((m) => ({ label: m, bytes: Buffer.from(m) }));
        const health = await server.http("/health");
        const places = [
          ...server.stored().map((f) => ({ where: f.file, bytes: f.bytes })),
          { where: "the server log", bytes: Buffer.from(server.log()) },
          { where: "/health", bytes: Buffer.from(JSON.stringify(health.body)) },
        ];
        for (const p of places)
          for (const s of [...secrets, ...texts])
            expect(p.bytes.includes(s.bytes), `${s.label} in ${p.where}`).toBe(false);
        // The wire carried none of it either (only sealed packages and ciphertext).
        for (const v of [A, B, C])
          for (const f of v.network.frames)
            for (const s of [...secrets, ...texts])
              expect(Buffer.from(f.bytes).includes(s.bytes), `${s.label} on ${v.name}'s wire`).toBe(
                false,
              );
        // Client-local stores do hold the authorized decrypted Task (that is their job), but never
        // the other vault's private Markdown.
        expect(await rootOf(A)).toContain(TASK);
        for (const text of B.app.vault.files.values()) expect(text).not.toContain(PRIVATE_A);
        for (const text of C.app.vault.files.values()) {
          expect(text).not.toContain(PRIVATE_A);
          expect(text).not.toContain(PRIVATE_B);
        }
      }));
  },
);
