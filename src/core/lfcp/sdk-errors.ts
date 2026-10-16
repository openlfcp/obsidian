// The SDK's INTERNAL error event (sync-client #serial: any handler on its
// session's queue that threw) as a safe class, and whether it is the
// ordinary end of a lost connection rather than an error (the owner's check
// of 0.4.0-beta.9: B logged "error code=INTERNAL" twice as Wi-Fi went off,
// right after its Resources went CLOSED). The message is never kept: only
// which of the SDK's known failures it is.

/** The class of an SDK error message, as a diagnostics code. */
export function sdkErrorClass(message: string | undefined): string {
  const m = message ?? "";
  if (/connection is not READY/i.test(m)) return "send-not-ready";
  if (/closed before|connection (?:was )?closed|socket (?:is )?(?:closed|not open)/i.test(m))
    return "connection-closed";
  if (/storage precondition|no outbound item/i.test(m)) return "outbound-race";
  if (/batch status was not stored/i.test(m)) return "batch-status-store";
  if (/not stored|storage/i.test(m)) return "storage";
  return "other";
}

/** How long after its connection went down an INTERNAL of the session counts as that loss's. */
export const LOSS_WINDOW_MS = 2000;

/**
 * Whether an INTERNAL error event of a session is its connection's loss
 * finishing (a handler queued before the close that ran after it, or the
 * close's own bookkeeping), not an error: the session is not READY, and it
 * went down within LOSS_WINDOW_MS. Anything else stays an error.
 */
export function lossNoise(o: {
  readonly code: string;
  readonly ready: boolean;
  readonly now: number;
  readonly disconnectedAt: number | null;
}): boolean {
  return (
    o.code === "INTERNAL" &&
    !o.ready &&
    o.disconnectedAt !== null &&
    o.now - o.disconnectedAt <= LOSS_WINDOW_MS
  );
}

/**
 * The class of an error a profile's change listener threw (SDK 0.2.2
 * onListenerError, LFCP-03-050), as a diagnostics code: an SDK error's
 * code, else the error's kind ("type-error"). Never its message, which can
 * carry note text.
 */
export function listenerErrorClass(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
    if (/^[A-Za-z]{1,40}$/.test(error.name))
      return error.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    return "error";
  }
  return "non-error";
}
