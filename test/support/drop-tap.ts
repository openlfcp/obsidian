// A WebSocket interposer for live tests (after sdk-ts's conformance
// WireTap): it delivers every LFCP message as it is, except the first
// incoming one a rule picks while armed, which it drops (a lost answer).

import { platformWebSocket, type WebSocketFactory, type WebSocketLike } from "@openlfcp/client";
import { type AnyMessage, decodeMessage, MESSAGE_TYPE } from "@openlfcp/wire";

const decode = (bytes: Uint8Array): AnyMessage | undefined => {
  try {
    return decodeMessage(bytes);
  } catch {
    return undefined;
  }
};

/** The coordinator's ACK of a CONTROL_PUT (a claim's answer). */
export const isControlPutAck = (m: AnyMessage | undefined): boolean => {
  const x = m as { type?: string; body?: { requestType?: bigint } } | undefined;
  return x?.type === "ACK" && x.body?.requestType === MESSAGE_TYPE.CONTROL_PUT;
};

export class DropTap {
  #armed: ((m: AnyMessage | undefined) => boolean) | null = null;
  dropped = 0;

  /** Drops the next incoming message `pick` chooses. */
  dropNext(pick: (m: AnyMessage | undefined) => boolean): void {
    this.#armed = pick;
  }

  readonly factory: WebSocketFactory = (url, protocols) => {
    const ws = platformWebSocket()(url, protocols);
    let onmessage: WebSocketLike["onmessage"] = null;
    ws.onmessage = (ev) => {
      const data = ev.data as unknown;
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : undefined;
      const pick = this.#armed;
      if (bytes !== undefined && pick !== null && pick(decode(Uint8Array.from(bytes)))) {
        this.#armed = null;
        this.dropped++;
        return;
      }
      onmessage?.(ev);
    };
    return new Proxy(ws, {
      get(target, p) {
        if (p === "onmessage") return onmessage;
        const v = Reflect.get(target, p) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
      set(target, p, v) {
        if (p === "onmessage") {
          onmessage = v as WebSocketLike["onmessage"];
          return true;
        }
        return Reflect.set(target, p, v);
      },
    }) as WebSocketLike;
  };
}
