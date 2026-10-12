// A client-side liveness probe for one session's connection (owner check of
// 0.4.0-beta.6): with the Wi-Fi off, macOS kept navigator.onLine true while
// another interface was up, so the window's "offline" event (877f398) did
// not come, and a session noticed its dead connection only after three
// heartbeat intervals without a message (LFCP-WIRE-01 §38: 90 s at the
// reference server's 30 s), the badges saying synced meanwhile.
//
// While the session is READY, when nothing arrived for `idleMs` the probe
// sends a PING of its own; any LFCP message counts as the answer (§38: PING
// and PONG count like every message). With nothing within `replyMs` the
// connection is taken for dead: the caller closes it and reconnects, as
// after any loss. A PING is allowed in every state (§38, §63), the server
// answers it with PONG, which the SDK ignores; the SDK's own heartbeat and
// its 3 × h timeout are unchanged.
//
// It sees the connection through the WebSocket factory the SDK is given:
// the bytes are not read, only that a message arrived.

import type { WebSocketFactory, WebSocketLike } from "@openlfcp/client";
import { createMessage, encodeMessage } from "@openlfcp/wire";

export interface LivenessOptions {
  /** Silence after which a PING is sent (default 15 s). */
  readonly idleMs: number;
  /** How long the PING waits for any message (default 5 s). */
  readonly replyMs: number;
}

export const LIVENESS: LivenessOptions = { idleMs: 15_000, replyMs: 5_000 };

export class LivenessProbe {
  #socket: WebSocketLike | null = null;
  #lastReceived = 0;
  #pingAt: number | null = null;

  constructor(
    private readonly base: () => WebSocketFactory,
    private readonly now: () => number,
    private readonly options: LivenessOptions = LIVENESS,
  ) {}

  /** The factory for the SDK: the platform's sockets, each message's arrival noted. */
  readonly factory: WebSocketFactory = (url, protocols) => {
    const real = this.base()(url, protocols);
    this.#socket = real;
    this.#lastReceived = this.now();
    this.#pingAt = null;
    const heard = () => {
      if (this.#socket !== real) return;
      this.#lastReceived = this.now();
      this.#pingAt = null;
    };
    return {
      get binaryType() {
        return real.binaryType;
      },
      set binaryType(v: string) {
        real.binaryType = v;
      },
      get protocol() {
        return real.protocol;
      },
      send: (data) => real.send(data),
      close: (code, reason) => real.close(code, reason),
      get onopen() {
        return real.onopen;
      },
      set onopen(fn) {
        real.onopen = fn;
      },
      get onclose() {
        return real.onclose;
      },
      set onclose(fn) {
        real.onclose = fn;
      },
      get onerror() {
        return real.onerror;
      },
      set onerror(fn) {
        real.onerror = fn;
      },
      get onmessage() {
        return real.onmessage;
      },
      set onmessage(fn) {
        real.onmessage =
          fn === null
            ? null
            : (ev) => {
                heard();
                fn(ev);
              };
      },
    };
  };

  /**
   * On the session's clock: false when the connection is taken for dead (a
   * PING unanswered for `replyMs`). `ready`: the session is READY; before
   * that the SDK's handshake timeout applies.
   */
  tick(now: number, ready: boolean): boolean {
    const socket = this.#socket;
    if (!ready || socket === null) {
      this.#pingAt = null;
      return true;
    }
    if (this.#pingAt !== null) {
      if (now - this.#pingAt < this.options.replyMs) return true;
      this.#pingAt = null;
      this.#socket = null;
      return false;
    }
    if (now - this.#lastReceived >= this.options.idleMs) {
      this.#pingAt = now;
      try {
        socket.send(
          encodeMessage(
            createMessage("PING", {
              payload: globalThis.crypto.getRandomValues(new Uint8Array(8)),
            }),
          ),
        );
      } catch {
        // A socket that cannot send is as good as dead: the reply wait decides.
      }
    }
    return true;
  }
}
