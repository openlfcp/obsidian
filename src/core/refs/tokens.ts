// Validators for the tokens inside an object reference (MARKDOWN-REFS-01
// §7–§10), over @openlfcp/core (LFCP-059 replaced the local copies). The
// names stay as LFCP-060 exported them.

import { fromBase64url, isObjectId as isCoreObjectId, toBase64url } from "@openlfcp/core";

/** Unpadded base64url (RFC 4648 §5) of `bytes`. */
export const toBase64Url = (bytes: Uint8Array): string => toBase64url(bytes);

/**
 * Decode canonical unpadded base64url, or `undefined`: padding, characters
 * outside the alphabet, an impossible length and non-zero unused bits are
 * rejected, so re-encoding reproduces the token exactly (§8).
 */
export function fromBase64Url(token: string): Uint8Array | undefined {
  try {
    return fromBase64url(token);
  } catch {
    return undefined;
  }
}

/** A Resource ID token: canonical unpadded base64url of 32 bytes (§8). */
export function decodeResourceId(token: string): Uint8Array | undefined {
  const bytes = fromBase64Url(token);
  return bytes?.length === 32 ? bytes : undefined;
}

/**
 * A canonical Object ID (§10, SHARED-OBJECTS-PROFILE-01 §19): lowercase
 * hexadecimal UUID with standard hyphens, version 7 and variant bits 10.
 */
export const isObjectId = (text: string): boolean => isCoreObjectId(text);

/**
 * MR-A1, normative since baseline.5 (§9): an object type token is `task` or a
 * reverse-domain name as SHARED-OBJECTS-PROFILE-01 §18 defines it (at least
 * two labels of lowercase letters and digits with inner hyphens); types are
 * case-sensitive.
 */
export function isObjectType(text: string): boolean {
  return (
    text === "task" ||
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(text)
  );
}
