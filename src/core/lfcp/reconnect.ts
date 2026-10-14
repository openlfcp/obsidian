// The sessions' reconnect backoff, restartable. The plugin's policy waits
// 1 s, doubling, at most 15 s (the SDK's own goes to 60 s: after a server
// or route outage of a few minutes, a session came back up to a minute
// after the server did; soak finding #8 on 0.4.0-beta.17), each wait
// within ±20 % so that many devices do not retry in step. When the network
// comes back, or the app is shown or focused again, the next attempt is
// made at once and, should it fail, the attempts after it wait as from the
// start: 1 s, 2 s, … Pure but for the jitter's random source.

import type { ReconnectPolicy } from "@openlfcp/client";

/** The longest wait between two attempts (ms), before jitter. */
export const RECONNECT_CAP_MS = 15_000;
/** Each wait is within ±this share of its nominal value. */
export const RECONNECT_JITTER = 0.2;

/** 1 s, doubling, at most {@link RECONNECT_CAP_MS}, forever, within ±{@link RECONNECT_JITTER}. */
export function cappedReconnect(random: () => number = Math.random): ReconnectPolicy {
  return (attempt) => {
    const nominal = Math.min(RECONNECT_CAP_MS, 1000 * 2 ** (Math.max(1, attempt) - 1));
    return Math.round(nominal * (1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * random()));
  };
}

export interface RestartableReconnect {
  /** The policy for SyncClientOptions.reconnect. */
  readonly policy: ReconnectPolicy;
  /** The attempts so far no longer count. */
  restart(): void;
}

export function restartableReconnect(
  base: ReconnectPolicy = cappedReconnect(),
): RestartableReconnect {
  let from = 0;
  let last = 0;
  return {
    policy: (attempt) => {
      // The SDK counts again from 1 after a session was READY.
      if (attempt <= from) from = 0;
      last = attempt;
      return base(attempt - from);
    },
    restart: () => {
      from = last;
    },
  };
}
