// What one session's transport did last (LFCP-03-005, F-C06), from the
// SDK's own connection transitions only: the §63 states it reports
// (SyncEvent "connection"), the window's "offline"/"online" events the
// runtime is given, and the liveness probe giving up on a silent
// connection (liveness.ts). Nothing here is guessed from a timer: a
// connection is "connecting" after the SDK said CONNECTING and until it
// says READY or DISCONNECTED, and an attempt "failed" only when the SDK
// reported it DISCONNECTED before READY. While a retry after a loss or a
// failure is under way it keeps reading as that loss or failure, so the
// sections do not flip between "offline" and "connecting" on every
// backoff; the retry's own end then decides: READY, or "failed" (a first
// retry after "lost" that fails becomes "failed"). Pure bookkeeping.

import type { ClientConnectionState } from "@openlfcp/wire";

/**
 * - "none": no transition reported yet (no evidence either way);
 * - "connecting": the first attempt is under way (CONNECTING, NEGOTIATING,
 *   AUTHENTICATING), since the session started or was last READY;
 * - "ready": the session is READY;
 * - "lost": it was READY in this attempt, then DISCONNECTED;
 * - "failed": the attempt was DISCONNECTED before READY.
 */
export type TransportState = "none" | "connecting" | "ready" | "lost" | "failed";

/** Why the connection is down, when something said so. */
export type TransportCause =
  /** The system said the network is gone (the window's "offline"), and not back since. */
  | "network-offline"
  /** The liveness probe's PING went unanswered: the connection was dropped. */
  | "not-responding";

export interface TransportFact {
  readonly state: TransportState;
  /** For "lost" and "failed": why, when known; null otherwise. */
  readonly cause: TransportCause | null;
}

export const NO_TRANSPORT: TransportFact = { state: "none", cause: null };

export class TransportTracker {
  #state: TransportState = "none";
  /** How the last connection or attempt ended, since the last READY; null: none did. */
  #down: "lost" | "failed" | null = null;
  /** The current attempt reached READY. */
  #reached = false;
  #networkDown = false;
  #unresponsive = false;

  /** A §63 transition the SDK reported (SyncEvent "connection"). */
  connection(state: ClientConnectionState): void {
    switch (state) {
      case "CONNECTING":
        // A new attempt; what ended the last connection stays its cause until READY.
        if (this.#state !== "connecting") this.#reached = false;
        this.#state = "connecting";
        return;
      case "NEGOTIATING":
      case "AUTHENTICATING":
        this.#state = "connecting";
        return;
      case "READY":
        this.#state = "ready";
        this.#down = null;
        this.#reached = true;
        this.#networkDown = false;
        this.#unresponsive = false;
        return;
      case "DISCONNECTED":
        // The SDK reports DISCONNECTED twice (the state, then the close with
        // its reason): the second changes nothing.
        this.#state = this.#reached ? "lost" : "failed";
        this.#down = this.#state;
        return;
    }
  }

  /** The window's "offline": the system says the network is gone. */
  networkLost(): void {
    this.#networkDown = true;
  }

  /** The window's "online", or the app shown or focused again. */
  networkBack(): void {
    this.#networkDown = false;
  }

  /**
   * The liveness probe took the connection for dead (liveness.ts); the
   * runtime drops it. Its cause until a connection is READY again.
   */
  unresponsive(): void {
    this.#unresponsive = true;
  }

  get fact(): TransportFact {
    // A retry is not news until it succeeds or ends: the last outcome stands.
    const state = this.#state === "connecting" && this.#down !== null ? this.#down : this.#state;
    const down = state === "lost" || state === "failed";
    return {
      state,
      cause: !down
        ? null
        : this.#networkDown
          ? "network-offline"
          : this.#unresponsive
            ? "not-responding"
            : null,
    };
  }
}
