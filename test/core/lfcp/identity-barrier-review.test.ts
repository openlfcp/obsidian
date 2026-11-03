// LFCP-04-406 review follow-up (obsidian#105, R1–R3), against the real
// runtime and SDK 0.2.2 with a scripted server: a barrier behind another
// barrier in one batch, a refusal followed by LIVE from the sync of the old
// head, and a barrier for a Resource the session never opened while another
// Resource's barrier is refused.

import { LFCP_SUBPROTOCOL, type WebSocketFactory, type WebSocketLike } from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";
import {
  type AnyMessage,
  createMessage,
  decodeMessage,
  encodeMessage,
  objectId,
  replyTo,
  type ServerSession,
  type Signer,
  serverReceive,
  signObject,
  startServerSession,
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
function record(R: ResourceId, seq: number, type: 6 | 9, prev: Uint8Array, signer: Signer) {
  const b = (x: Uint8Array) => [0x58, x.length, ...x];
  const body = type === 6 ? [0xa3, 0x00, 0x40, 0x01, 0x40, 0x02, 0x40] : [0xa1, 0x00, 0x40];
  const payload = [0xa6, 0x00, ...b(R), 0x01, seq, 0x02, ...b(prev), 0x03, type, 0x04];
  return signObject(
    Uint8Array.from([...payload, ...b(signer.descriptor.principalId), 0x05, ...body]),
    signer,
  ).bytes;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
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
  it("R1: a commit with field 2 then a DEVICE_GRANT in one batch is blocked, at the first barrier", async () => {
    let records: Uint8Array[] = [];
    const server = new ScriptedServer(() => records, 2n);
    const { runtime, signer, section } = await started(server.factory);
    const { R, head } = await section("mixed");
    const commit = record(R, 1, 6, head, signer);
    records = [commit, record(R, 2, 9, objectId(commit), signer)];
    const errors: string[] = [];
    runtime.on((e) => {
      if (e.type === "error") errors.push(e.message);
    });
    await runtime.openSection(R);
    await until(() => runtime.identityBlock(R) !== null);
    // The SDK's parser refused type 9 before it read the commit's body.
    expect(errors.some((m) => m.includes("type 9 is reserved"))).toBe(true);
    expect(runtime.identityBlock(R)).toMatchObject({ entry: "transfer-device", seq: "1" });
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
});
