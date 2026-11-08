// LFCP-04-406 review follow-up (obsidian#105, R1–R3, B1–B2), against the
// real runtime and SDK with a scripted server: a barrier behind another
// barrier in one batch, a refusal followed by LIVE from the sync of the old
// head, a barrier for a Resource the session never opened, or still opens,
// while another Resource's barrier is refused, records of an earlier
// connection after a reconnect, and a late RESOURCE_OPENED (C1).
//
// The barrier records here are type 9 with the body {0: h''}: not a valid
// DEVICE_GRANT. SDK 0.2.2 refused type 9 as reserved ("Control Record type 9
// is reserved", naming no Resource); SDK 0.3.0 reads types 9 and 10 and
// refuses this body as MALFORMED, naming the Resource (refusedMalformed).
// Either way the SDK refuses a barrier record and the Resource is blocked,
// which is what these tests are about. A valid DEVICE_GRANT is accepted by
// 0.3.0 and blocks nothing: R1's first barrier is one, so that the SDK
// refuses the batch at its second record, as 0.2.2 did (review obsidian#107).

import {
  LFCP_SUBPROTOCOL,
  leafPayload,
  loadControlChain,
  signChain,
  type WebSocketFactory,
  type WebSocketLike,
} from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import { generateAgreementKeyPair, generateSigningKeyPair } from "@openlfcp/crypto";
import type { LfcpStorage } from "@openlfcp/storage";
import {
  type AnyMessage,
  createMessage,
  decodeMessage,
  encodeMessage,
  objectId,
  principalDescriptorFromKeys,
  replyTo,
  type ServerSession,
  type Signer,
  serverReceive,
  signControlRecord,
  signObject,
  startServerSession,
  validateControlChain,
  WIRE_PROFILE,
} from "@openlfcp/wire";
import { afterEach, describe, expect, it } from "vitest";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";
import { ScriptedServer, SCRIPTED_URL as URL } from "../../support/scripted-server";

const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

/** A record at `seq` of `type` (9: body {0: h''}; 6: a commit with field 2), signed by `signer`. */
function record(R: ResourceId, seq: number, type: 6 | 9 | 31, prev: Uint8Array, signer: Signer) {
  const b = (x: Uint8Array) => [0x58, x.length, ...x];
  const body = type === 6 ? [0xa3, 0x00, 0x40, 0x01, 0x40, 0x02, 0x40] : [0xa1, 0x00, 0x40];
  const t = type < 24 ? [type] : [0x18, type];
  const payload = [0xa6, 0x00, ...b(R), 0x01, seq, 0x02, ...b(prev), 0x03, ...t, 0x04];
  return signObject(
    Uint8Array.from([...payload, ...b(signer.descriptor.principalId), 0x05, ...body]),
    signer,
  ).bytes;
}

interface SdkError {
  readonly code: string;
  readonly message: string;
  readonly resource: string | null;
}

/** The SDK's errors on a runtime, as they come. */
function sdkErrors(runtime: LfcpRuntime): SdkError[] {
  const errors: SdkError[] = [];
  runtime.on((e) => {
    if (e.type === "error")
      errors.push({
        code: e.code,
        message: e.message,
        resource: e.resourceId === undefined ? null : toHex(e.resourceId),
      });
  });
  return errors;
}

/** The SDK refused `R`'s records as malformed: SDK 0.3.0's refusal of this type-9 body. */
const refusedMalformed = (errors: readonly SdkError[], R: ResourceId): boolean =>
  errors.some((e) => e.code === "MALFORMED_MESSAGE" && e.resource === toHex(R));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error("timed out");
}

async function started(webSocket: WebSocketFactory) {
  const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal(), { webSocket }));
  running.push(runtime);
  const signer = runtime.collaborationContext()?.principal.signer;
  if (signer === undefined) throw new Error("not ready");
  const section = async (name: string) => {
    const R = await runtime.createSectionResource({ name, endpoints: [URL], coordinatorUrl: URL });
    const head = await runtime.storage?.control.head(R);
    if (head === undefined) throw new Error("no head");
    return { R, head: head.head };
  };
  return { runtime, signer, section };
}

describe("identity barrier review follow-up (obsidian#105)", () => {
  it("R1: a barrier the SDK reads, then one it refuses, in one batch, is blocked at the first barrier", async () => {
    let records: Uint8Array[] = [];
    const server = new ScriptedServer(() => records, 2n);
    const { runtime, signer, section } = await started(server.factory);
    const { R, head } = await section("mixed");
    // The first barrier is a valid DEVICE_GRANT, which SDK 0.3.0 reads (SDK 0.2.2 read
    // the original's commit with field 2 as far as its type, and refused the next record).
    const stored = await loadControlChain(runtime.storage as LfcpStorage, R);
    if (stored?.kind !== "linear") throw new Error("no chain");
    const device = principalDescriptorFromKeys(
      generateSigningKeyPair(),
      generateAgreementKeyPair(),
    );
    const root = signer.descriptor.principalId;
    const grant = signControlRecord(
      { resourceId: R, controlSeq: 1n, prevControlId: head as never },
      {
        type: "DEVICE_GRANT",
        root,
        chain: signChain(stored.state, signer, leafPayload(root, device, 0, [1n, 2n], [])),
      },
      signer,
    ).bytes;
    const refused = record(R, 2, 9, objectId(grant), signer);
    records = [grant, refused];
    // The SDK's own validator: the first barrier alone passes, and the refusal names the later record.
    const genesis = stored.records.map((r) => r.signed.bytes);
    expect(validateControlChain([...genesis, grant]).kind).toBe("linear");
    const both = validateControlChain([...genesis, grant, refused]);
    expect(both.kind === "invalid" && toHex(both.recordId ?? new Uint8Array())).toBe(
      toHex(objectId(refused)),
    );
    const errors = sdkErrors(runtime);
    await runtime.openSection(R);
    await until(() => runtime.identityBlock(R) !== null);
    // The SDK refused the batch for its second record; the block is at the first barrier.
    expect(refusedMalformed(errors, R)).toBe(true);
    expect(runtime.identityBlock(R)).toMatchObject({ entry: "device-grant", seq: "1" });
  });

  it("R2: LIVE from the sync of the old head does not lift the block of the refused record", async () => {
    let R: ResourceId | undefined;
    let head: Uint8Array = new Uint8Array();
    let barrier: Uint8Array = new Uint8Array();
    const states: string[] = [];
    // RESOURCE_OPENED names the stored head; a pushed DEVICE_GRANT on head + 1 follows at once.
    const factory: WebSocketFactory = () => {
      let session: ServerSession = startServerSession();
      const socket: WebSocketLike = {
        binaryType: "arraybuffer",
        protocol: LFCP_SUBPROTOCOL,
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        close: () => undefined,
        send: (data) => {
          const m = decodeMessage(Uint8Array.from(data as Uint8Array));
          const step = serverReceive(session, m, {
            serverId: new Uint8Array(32).fill(5),
            wireProfiles: [WIRE_PROFILE],
            maxMessageBytes: 1_000_000n,
            durability: 2n,
            heartbeatMs: 30_000n,
          });
          session = step.session;
          const out: AnyMessage[] = [...step.send];
          if (m.type === "RESOURCE_OPEN" && R !== undefined)
            out.push(
              replyTo(m, "RESOURCE_OPENED", {
                resourceId: R,
                heads: [{ seq: 0n, recordId: head as never }],
                haves: [],
              }),
              createMessage("CONTROL_BATCH", { resourceId: R, objects: [barrier] }),
            );
          if (out.length > 0)
            setTimeout(() => {
              for (const x of out) socket.onmessage?.({ data: encodeMessage(x) });
            }, 0);
        },
      };
      setTimeout(() => socket.onopen?.({}), 0);
      return socket;
    };
    const { runtime, signer, section } = await started(factory);
    const s = await section("race");
    R = s.R;
    head = s.head;
    barrier = record(R, 1, 9, head, signer);
    runtime.on((e) => {
      if (e.type === "resource-state") states.push(e.state);
    });
    await runtime.openSection(R);
    await until(() => states.includes("LIVE"));
    await sleep(100);
    expect(runtime.identityBlock(R)).toMatchObject({ entry: "device-grant", seq: "1" });
  });

  it("R3: a barrier of a Resource this session never opened is not confirmed by another's refusal", async () => {
    let A: ResourceId | undefined;
    let ignored: Uint8Array = new Uint8Array();
    let records: Uint8Array[] = [];
    const server = new ScriptedServer(() => records);
    // Before answering B's CONTROL_GET, the server pushes a batch for A, which the SDK ignores.
    const factory: WebSocketFactory = (url, protocols) => {
      const socket = server.factory(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        const m = decodeMessage(Uint8Array.from(data as Uint8Array));
        if (m.type === "CONTROL_GET" && A !== undefined)
          socket.onmessage?.({
            data: encodeMessage(
              createMessage("CONTROL_BATCH", { resourceId: A, objects: [ignored] }),
            ),
          });
        send(data);
      };
      return socket;
    };
    const { runtime, signer, section } = await started(factory);
    const a = await section("unopened A");
    const b = await section("opened B");
    A = a.R;
    ignored = record(a.R, 1, 9, a.head, signer);
    records = [record(b.R, 1, 9, b.head, signer)];
    await runtime.openSection(b.R);
    await until(() => runtime.identityBlock(b.R) !== null);
    await sleep(50);
    expect(runtime.phase(a.R)).toBe("CLOSED");
    expect(runtime.identityBlock(a.R)).toBeNull();
  });

  it("B1: a batch for a Resource still OPENING (ignored by the SDK) neither takes another's refusal nor outlives a restart", async () => {
    let A: ResourceId | undefined;
    let B: ResourceId | undefined;
    let headA: Uint8Array = new Uint8Array();
    let grantA: Uint8Array = new Uint8Array();
    let grantB: Uint8Array = new Uint8Array();
    let releaseA: () => void = () => undefined;
    const server = new AnsweringServer((m, emit) => {
      if (m.type === "RESOURCE_OPEN" && A !== undefined && B !== undefined) {
        if (toHex(m.body.resourceId) === toHex(A))
          releaseA = () =>
            emit(
              replyTo(m, "RESOURCE_OPENED", {
                resourceId: m.body.resourceId,
                heads: [{ seq: 0n, recordId: headA as never }],
                haves: [],
              }),
            );
        else
          emit(
            replyTo(m, "RESOURCE_OPENED", {
              resourceId: m.body.resourceId,
              heads: [{ seq: 1n, recordId: objectId(grantB) as never }],
              haves: [],
            }),
          );
      }
      if (m.type === "CONTROL_GET" && A !== undefined && B !== undefined) {
        emit(createMessage("CONTROL_BATCH", { resourceId: A, objects: [grantA] }));
        emit(replyTo(m, "CONTROL_BATCH", { resourceId: B, objects: [grantB] }));
      }
    });
    const device = new Device();
    const local = new FakeLocal();
    const runtime = await LfcpRuntime.start(device.env(local, { webSocket: server.factory }));
    running.push(runtime);
    const signer = runtime.collaborationContext()?.principal.signer;
    if (signer === undefined) throw new Error("not ready");
    A = await runtime.createSectionResource({
      name: "healthy A",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    B = await runtime.createSectionResource({
      name: "barrier B",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    headA = (await runtime.storage?.control.head(A))?.head ?? new Uint8Array();
    grantA = record(A, 1, 9, headA, signer);
    grantB = record(
      B,
      1,
      9,
      (await runtime.storage?.control.head(B))?.head ?? new Uint8Array(),
      signer,
    );
    const errors = sdkErrors(runtime);
    const a = A;
    const b = B;
    await runtime.openSection(a);
    await until(() => runtime.phase(a) === "OPENING");
    await runtime.openSection(b);
    await until(() => refusedMalformed(errors, b));
    await until(() => runtime.identityBlock(b) !== null);
    // A's batch came while A was OPENING: the SDK ignored it, and B's refusal is B's alone.
    expect(refusedMalformed(errors, a)).toBe(false);
    expect(runtime.identityBlock(a)).toBeNull();
    releaseA();
    await until(() => runtime.phase(a) === "LIVE");
    await sleep(50);
    await runtime.stop();
    running.splice(0);
    const again = await LfcpRuntime.start(device.env(local));
    running.push(again);
    expect(again.identityBlock(a)).toBeNull();
    expect(again.identityBlock(b)).toMatchObject({ entry: "device-grant" });
  });

  it("B2: records refused on an earlier connection do not hide the barrier after a reconnect", async () => {
    let R: ResourceId | undefined;
    let old: Uint8Array = new Uint8Array();
    let grant: Uint8Array = new Uint8Array();
    let second = false;
    const server = new AnsweringServer((m, emit) => {
      if (R === undefined) return;
      const now = second ? grant : old;
      if (m.type === "RESOURCE_OPEN")
        emit(
          replyTo(m, "RESOURCE_OPENED", {
            resourceId: R,
            heads: [{ seq: 1n, recordId: objectId(now) as never }],
            haves: [],
          }),
        );
      if (m.type === "CONTROL_GET")
        emit(replyTo(m, "CONTROL_BATCH", { resourceId: R, objects: [now] }));
    });
    const runtime = await LfcpRuntime.start(
      new Device().env(new FakeLocal(), { webSocket: server.factory }),
    );
    running.push(runtime);
    const signer = runtime.collaborationContext()?.principal.signer;
    if (signer === undefined) throw new Error("not ready");
    const r = await runtime.createSectionResource({
      name: "reconnect",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    R = r;
    const head = (await runtime.storage?.control.head(r))?.head ?? new Uint8Array();
    grant = record(r, 1, 9, head, signer);
    // An unknown core type (31) whose record ID sorts before the grant's: the
    // SDK's validator reports it first when both are validated together.
    for (let i = 0; i < 10_000; i++) {
      const prev = head.slice();
      prev[0] = i & 255;
      prev[1] = i >> 8;
      old = record(r, 1, 31, prev, signer);
      if (toHex(objectId(old)) < toHex(objectId(grant))) break;
    }
    const errors = sdkErrors(runtime);
    await runtime.openSection(r);
    await until(() => errors.some((x) => x.message.includes("type 31")));
    expect(runtime.identityBlock(r)).toBeNull();
    const client = runtime.collaborationContext()?.session(URL);
    if (client === undefined) throw new Error("no session");
    await client.stop();
    second = true;
    client.start();
    await until(() => refusedMalformed(errors, r));
    await until(() => runtime.identityBlock(r) !== null);
    expect(runtime.identityBlock(r)).toMatchObject({ entry: "device-grant", seq: "1" });
  });

  it("C1: a late RESOURCE_OPENED (a retried open after a reconnect) does not erase a barrier already received", async () => {
    let R: ResourceId | undefined;
    let head: Uint8Array = new Uint8Array();
    let grant: Uint8Array = new Uint8Array();
    let reconnected = false;
    let late: AnyMessage | undefined;
    let opens = 0;
    const server = new AnsweringServer((m, emit) => {
      if (R === undefined) return;
      if (m.type === "CONTROL_GET" && reconnected && late !== undefined) {
        emit(replyTo(m, "CONTROL_BATCH", { resourceId: R, objects: [grant] }));
        // The answer to the first RESOURCE_OPEN of this connection, late: the SDK ignores it.
        emit(late);
        return;
      }
      if (m.type !== "RESOURCE_OPEN") return;
      if (!reconnected) {
        emit(
          replyTo(m, "RESOURCE_OPENED", {
            resourceId: R,
            heads: [{ seq: 0n, recordId: head as never }],
            haves: [],
          }),
        );
        return;
      }
      opens++;
      const answer = replyTo(m, "RESOURCE_OPENED", {
        resourceId: R,
        heads: [{ seq: 1n, recordId: objectId(grant) as never }],
        haves: [],
      });
      if (opens === 1) late = answer;
      else emit(answer);
    });
    const runtime = await LfcpRuntime.start(
      new Device().env(new FakeLocal(), { webSocket: server.factory }),
    );
    running.push(runtime);
    const signer = runtime.collaborationContext()?.principal.signer;
    if (signer === undefined) throw new Error("not ready");
    const r = await runtime.createSectionResource({
      name: "late answer",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    R = r;
    head = (await runtime.storage?.control.head(r))?.head ?? new Uint8Array();
    grant = record(r, 1, 9, head, signer);
    const errors = sdkErrors(runtime);
    await runtime.openSection(r);
    await until(() => runtime.phase(r) === "LIVE");
    const client = runtime.collaborationContext()?.session(URL);
    if (client === undefined) throw new Error("no session");
    await client.stop();
    reconnected = true;
    client.start();
    await until(() => late !== undefined);
    // The SDK's own request timeout (15 s) sends RESOURCE_OPEN again; only its tick is advanced.
    client.tick(Date.now() + 16_000);
    await until(() => refusedMalformed(errors, r));
    await client.idle();
    await sleep(80);
    expect(opens).toBe(2);
    expect(runtime.identityBlock(r)).toMatchObject({ entry: "device-grant", seq: "1" });
  });
});

/** A server that completes the handshake and lets `answer` reply to each delivered message. */
class AnsweringServer {
  constructor(private readonly answer: (m: AnyMessage, emit: (m: AnyMessage) => void) => void) {}

  readonly factory: WebSocketFactory = () => {
    let session: ServerSession = startServerSession();
    const socket: WebSocketLike = {
      binaryType: "arraybuffer",
      protocol: LFCP_SUBPROTOCOL,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      close: () => undefined,
      send: (data) => {
        const m = decodeMessage(Uint8Array.from(data as Uint8Array));
        const step = serverReceive(session, m, {
          serverId: new Uint8Array(32).fill(5),
          wireProfiles: [WIRE_PROFILE],
          maxMessageBytes: 1_000_000n,
          durability: 2n,
          heartbeatMs: 30_000n,
        });
        session = step.session;
        const emit = (x: AnyMessage) => socket.onmessage?.({ data: encodeMessage(x) });
        setTimeout(() => {
          for (const x of step.send) emit(x);
          if (step.deliver !== undefined) this.answer(step.deliver, emit);
        }, 0);
      },
    };
    setTimeout(() => socket.onopen?.({}), 0);
    return socket;
  };
}
