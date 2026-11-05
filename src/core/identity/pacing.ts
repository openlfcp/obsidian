// The pace of the device flows against a sync server's per-IP limits
// (LFCP-04-414, decision I18). The reference server allows 20 new
// WebSockets per IP per minute (a bucket of 20, refilled 20 a minute), and
// devices behind one home or office network share that IP. Each call of an
// SDK identity flow opens its own connection (its ChannelPool lives for one
// call; connection reuse inside the SDK is a backlog item), and the dialogs
// ask again while they wait. Measured before (status-414, R3): two pairings
// in a row and a removal opened 33 WebSockets in 25 s and the last 5 were
// refused, the removal left unfinished.
//
// Two things keep them within the limit:
//   - the dialogs ask again with a backoff (4 s, 8 s, 15 s, then every
//     30 s), from the start again when the person acts;
//   - every connection the device flows of one installation open takes a
//     token from one bucket (ConnectionPacer): a burst, then a steady rate.
//     All dialogs of the installation share it. A call waits for its token
//     instead of being refused by the server.
// Obsidian-free.

/** The delays between a dialog's questions to the server: then the last one, repeated. */
export const POLL_BACKOFF_MS: readonly number[] = Object.freeze([4000, 8000, 15_000, 30_000]);

/** The delay before question `n` + 1 of a dialog (n from 0, since the last user action). */
export const pollDelay = (n: number): number =>
  POLL_BACKOFF_MS[Math.min(Math.max(0, n), POLL_BACKOFF_MS.length - 1)] as number;

/** A token bucket: `burst` tokens, refilled at `perMinute`. */
export interface Pacing {
  readonly burst: number;
  readonly perMinute: number;
}

/**
 * The device flows' share of a server's 20 new WebSockets per IP per
 * minute, per installation: two installations of one person work together
 * when pairing (the managing one and the new one), and each also holds its
 * sections' sessions (not paced, one per server, long-lived). Two
 * installations at this pace stay within the server's bucket and its rate.
 */
export const DEVICE_FLOW_PACING: Pacing = Object.freeze({ burst: 8, perMinute: 9 });

/**
 * Hands out one token per connection; a caller without a token waits for
 * the next one. Callers are served in order. With no clock moving, a
 * caller waits `60000 / perMinute` ms per missing token.
 */
export class ConnectionPacer {
  readonly #o: Pacing & {
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  #tokens: number;
  #at: number;
  #queue: Promise<void> = Promise.resolve();
  /** Connections paced so far, and how long they waited in all (ms): for diagnostics and tests. */
  taken = 0;
  waitedMs = 0;

  constructor(
    o: Pacing & { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> },
  ) {
    if (o.burst < 1 || o.perMinute <= 0) throw new Error("a pace needs a burst and a rate");
    this.#o = o;
    this.#tokens = o.burst;
    this.#at = o.now();
  }

  /** Resolves when a connection may be opened (a token is taken). */
  take(): Promise<void> {
    const turn = this.#queue.then(() => this.#take());
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  async #take(): Promise<void> {
    const msPerToken = 60_000 / this.#o.perMinute;
    const refill = () => {
      const now = this.#o.now();
      this.#tokens = Math.min(this.#o.burst, this.#tokens + (now - this.#at) / msPerToken);
      this.#at = now;
    };
    refill();
    while (this.#tokens < 1) {
      const wait = Math.ceil((1 - this.#tokens) * msPerToken);
      this.waitedMs += wait;
      await this.#o.sleep(wait);
      const before = this.#tokens;
      refill();
      // A clock that did not move (a test's sleep): the wait itself earned the token.
      if (this.#tokens === before)
        this.#tokens = Math.min(this.#o.burst, before + wait / msPerToken);
    }
    this.#tokens -= 1;
    this.taken++;
  }
}
