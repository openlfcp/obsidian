// A request/response LFCP session for the LFCP-071 E2E: the SDK's
// LfcpConnection (the real HELLO/CHALLENGE/AUTH/READY handshake), but the
// test sends exact messages of its choosing (a stale DATA_PUT, an open by a
// Principal without a grant, a unit a client must refuse) and reads the
// server's answers. Test-only; it never logs payloads.

import { LfcpConnection } from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
import { type AnyMessage, ERROR_CODE, type Signer } from "@openlfcp/wire";

const CODE_NAME = new Map<bigint, string>(Object.entries(ERROR_CODE).map(([k, v]) => [v, k]));

/** The §62 name of a NACK or ERROR code. */
export const codeName = (code: bigint): string => CODE_NAME.get(code) ?? `ERROR_${code}`;

export class RawSession {
  readonly #connection: LfcpConnection;
  readonly #inbox: AnyMessage[] = [];
  #ready = false;
  #closed: string | null = null;

  constructor(options: { url: string; signer: Signer; credential?: Uint8Array }) {
    this.#connection = new LfcpConnection(
      {
        url: options.url,
        signer: options.signer,
        now: () => Date.now(),
        ...(options.credential === undefined ? {} : { credential: options.credential }),
      },
      {
        state: () => undefined,
        ready: () => {
          this.#ready = true;
        },
        message: (m) => {
          this.#inbox.push(m);
        },
        closed: (reason) => {
          this.#closed = reason;
        },
      },
    );
  }

  async #until<T>(take: () => T | undefined, what: string, ms: number): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = take();
      if (v !== undefined) return v;
      if (this.#closed !== null)
        throw new Error(`closed while waiting for ${what}: ${this.#closed}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async connect(ms = 10_000): Promise<void> {
    this.#connection.connect();
    await this.#until(() => (this.#ready ? true : undefined), "READY", ms);
  }

  /** Sends a message and returns its first correlated reply. */
  async request(m: AnyMessage, ms = 10_000): Promise<AnyMessage> {
    this.#connection.send(m);
    const id = toHex(m.messageId);
    return this.#until(
      () => {
        const i = this.#inbox.findIndex(
          (r) => r.correlationId !== undefined && toHex(r.correlationId) === id,
        );
        return i === -1 ? undefined : this.#inbox.splice(i, 1)[0];
      },
      `the reply to ${m.type}`,
      ms,
    );
  }

  close(): void {
    this.#connection.close("raw session done");
  }
}
