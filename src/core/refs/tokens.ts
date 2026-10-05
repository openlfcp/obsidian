// Small validators for the tokens inside an object reference
// (MARKDOWN-REFS-01 §7–§10). They duplicate @openlfcp/core on purpose,
// because the plugin does not depend on the SDK yet; LFCP-059 replaces
// them with the SDK's versions.

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url (RFC 4648 §5) of `bytes`. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = bytes.subarray(i, i + 3);
    const n = ((chunk[0] ?? 0) << 16) | ((chunk[1] ?? 0) << 8) | (chunk[2] ?? 0);
    for (let k = 0; k <= chunk.length; k++) out += B64URL[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}

/**
 * Decode canonical unpadded base64url, or `undefined`: padding, characters
 * outside the alphabet, an impossible length and non-zero unused bits are
 * rejected, so re-encoding reproduces the token exactly (§8).
 */
export function fromBase64Url(token: string): Uint8Array | undefined {
  if (token.length % 4 === 1) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < token.length; i += 4) {
    const chunk = token.slice(i, i + 4);
    let n = 0;
    for (let k = 0; k < chunk.length; k++) {
      const v = B64URL.indexOf(chunk[k] as string);
      if (v < 0) return undefined;
      n |= v << (18 - 6 * k);
    }
    for (let k = 0; k < chunk.length - 1; k++) bytes.push((n >> (16 - 8 * k)) & 255);
  }
  const out = Uint8Array.from(bytes);
  return toBase64Url(out) === token ? out : undefined;
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
export function isObjectId(text: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text);
}

/**
 * PROVISIONAL (MR-A1): an object type token is `task` or a reverse-domain
 * name as SHARED-OBJECTS-PROFILE-01 §18 defines it (at least two labels of
 * lowercase letters and digits with inner hyphens). §9 leaves the grammar
 * open; types are case-sensitive.
 */
export function isObjectType(text: string): boolean {
  return (
    text === "task" ||
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(text)
  );
}
