// A scripted LFCP server for tests without a server binary (LFCP-04-406):
// the SDK's own server handshake (serverReceive), then RESOURCE_OPEN and
// CONTROL_GET answered with the Control Records a test gives, exact bytes
// and all, including records the SDK in use cannot read.

import { LFCP_SUBPROTOCOL, type WebSocketFactory, type WebSocketLike } from "@openlfcp/client";
import { controlRecordId, type ResourceId } from "@openlfcp/core";
import {
  type AnyMessage,
  decodeMessage,
  encodeMessage,
  objectId,
  replyTo,
  type ServerSession,
  serverReceive,
  startServerSession,
  WIRE_PROFILE,
} from "@openlfcp/wire";

export const SCRIPTED_URL = "wss://scripted.example.invalid/v1/ws";

/** A server that completes the handshake and answers an open with `chain(R)` past the stored head. */
export class ScriptedServer {
  readonly received: string[] = [];
  constructor(
    private readonly chain: (R: ResourceId) => Uint8Array[],
    /** The sequence of the head the server announces (the last record's). */
    private readonly headSeq = 1n,
  ) {}

  readonly factory: WebSocketFactory = () => {
    let session: ServerSession = startServerSession();
    const socket: WebSocketLike = {
      binaryType: "arraybuffer",
      protocol: LFCP_SUBPROTOCOL,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      close: () => {
        setTimeout(() => socket.onclose?.({ code: 1000, reason: "" }), 0);
      },
      send: (data) => {
        const m = decodeMessage(Uint8Array.from(data as Uint8Array));
        this.received.push(m.type);
        const step = serverReceive(session, m, {
          serverId: new Uint8Array(32).fill(5),
          wireProfiles: [WIRE_PROFILE],
          maxMessageBytes: 1_000_000n,
          durability: 2n,
          heartbeatMs: 30_000n,
        });
        session = step.session;
        const out: AnyMessage[] = [...step.send];
        if (step.deliver !== undefined) out.push(...this.#answer(step.deliver));
        for (const reply of out) {
          const bytes = encodeMessage(reply);
          setTimeout(() => socket.onmessage?.({ data: bytes.slice().buffer }), 0);
        }
      },
    } as WebSocketLike;
    setTimeout(() => socket.onopen?.({}), 0);
    return socket;
  };

  #answer(m: AnyMessage): AnyMessage[] {
    if (m.type === "RESOURCE_OPEN") {
      const records = this.chain(m.body.resourceId);
      const last = records[records.length - 1];
      return [
        replyTo(m, "RESOURCE_OPENED", {
          resourceId: m.body.resourceId,
          heads:
            last === undefined
              ? []
              : [{ seq: this.headSeq, recordId: controlRecordId(objectId(last)) }],
          haves: [],
        }),
      ];
    }
    if (m.type === "CONTROL_GET")
      return [
        replyTo(m, "CONTROL_BATCH", {
          resourceId: m.body.resourceId,
          objects: this.chain(m.body.resourceId),
        }),
      ];
    return [];
  }
}
