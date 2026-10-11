// The sessions' reconnect backoff, restartable (the SDK's policy keeps
// doubling up to 60 s while the device is offline). When the network comes
// back, the next attempt is made at once and, should it fail, the attempts
// after it wait as from the start: 1 s, 2 s, … Pure.

import { defaultReconnect, type ReconnectPolicy } from "@openlfcp/client";

export interface RestartableReconnect {
  /** The policy for SyncClientOptions.reconnect. */
  readonly policy: ReconnectPolicy;
  /** The attempts so far no longer count. */
  restart(): void;
}

export function restartableReconnect(
  base: ReconnectPolicy = defaultReconnect,
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
