// Plain-language text for LFCP outcomes shown to the user (LFCP-065).
// Codes are the LFCP-WIRE-01 §62 registry names and the SDK's client-side
// error codes. No message ever contains an invitation URI, a secret or key
// material: callers pass codes, never the inputs that failed.

import { NEEDS_NEWER_VERSION } from "../lfcp/runtime";

/** A removed member opened a new invitation to the section it was removed from (MVP 0.3 rejoin). */
export const REMOVED_REJOIN =
  "You were removed from this section. Rejoining a section you were removed from isn't supported yet; your local copy stays on this device.";

/**
 * A join of a Resource this vault already holds, when its kind is not known
 * (the registry could not be read): neither section nor 0.1 words (LFCP-03-042).
 */
export const ALREADY_HELD = "This vault had already joined it. No new claim was made.";

const WIRE: Readonly<Record<string, string>> = {
  PROTOCOL_UNSUPPORTED: "The server does not speak a compatible version of LFCP.",
  MALFORMED_MESSAGE: "The server rejected a malformed request. Update the plugin and try again.",
  AUTH_FAILED: "The server could not authenticate this device's identity.",
  AUTHORIZATION_FAILED:
    "Not allowed. The invitation may be used up or revoked, or your access does not cover this.",
  RESOURCE_NOT_FOUND: "The server does not know it (nothing with this ID is shared there).",
  RESOURCE_NOT_HOSTED: "The server does not host it.",
  INVALID_SIGNATURE: "A signature did not verify. Nothing was changed.",
  INVALID_CONTROL_CHAIN: "The history of who has access did not validate. Nothing was changed.",
  CONTROL_CONFLICT:
    "The history of who has access has forked. Sharing and invitations are blocked until it is resolved.",
  CONTROL_HEAD_MISMATCH: "Someone else changed who has access at the same moment. Try again.",
  NOT_CONTROL_COORDINATOR: "This server does not coordinate who has access here.",
  PROFILE_UNSUPPORTED: "The server does not support Shared Objects.",
  KEY_PACKAGE_UNAVAILABLE: "The encryption key is not available yet.",
  STALE_DATA_EPOCH: "A change was made with an outdated key and was refused.",
  MISSING_DEPENDENCY: "Something this step needs is missing on the server or on this device.",
  ACTOR_EQUIVOCATION: "Conflicting changes were sent under one sequence number.",
  // ADR 0008: the server lacks a change this one follows; the SDK re-supplies it and retries.
  UNKNOWN_PREVIOUS: "Waiting for the server to catch up with earlier changes; they are sent again.",
  RATE_LIMITED: "The server asks to slow down. Try again in a moment.",
  QUOTA_EXCEEDED: "The server's storage quota for it is used up.",
  MESSAGE_TOO_LARGE: "A change is larger than the server accepts.",
  HOSTING_DENIED: "The server does not let this device host anything new.",
  RESOURCE_TOMBSTONED: "Its owner closed it on the server.",
  INTERNAL_ERROR: "The server had an internal error. Try again later.",
};

const CLIENT: Readonly<Record<string, string>> = {
  INVALID_INVITATION: "This is not a valid invitation link.",
  INVALID_INVITE_URI: "This is not a valid invitation link.",
  KEY_PACKAGE_OPEN_FAILED: "The invitation did not deliver the encryption key.",
  DEK_COMMITMENT_MISMATCH: "This device's encryption key does not match the current one.",
  UNSUPPORTED_VALUE: "The request contained a value this version does not support.",
  PROFILE_INVALID: "The task cannot be shared as it is (it is not a valid shared task).",
  OBJECT_ID_COLLISION: "Another shared object already uses this ID.",
  SEQUENCE_REUSE: "Writing is paused on this device (its local state is behind).",
  NEWER_VERSION_NEEDED: `${NEEDS_NEWER_VERSION}.`,
};

/** The text for a §62 or SDK code; unknown codes are named as they are. */
export function plainCode(code: string): string {
  return WIRE[code] ?? CLIENT[code] ?? `The operation failed (${code}).`;
}

/** An error's code, when it carries one (LfcpError), else null. */
export function codeOf(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Plain text for a thrown error: its code's text, or its message. */
export function plainError(e: unknown): string {
  const code = codeOf(e);
  if (code !== null && (WIRE[code] !== undefined || CLIENT[code] !== undefined))
    return plainCode(code);
  return e instanceof Error ? e.message : String(e);
}
