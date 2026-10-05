// The textual object reference (MARKDOWN-REFS-01 §7):
//
//   lfcp1:<resource-b64url>#<object-type>:<object-id>

import { decodeResourceId, isObjectId, isObjectType, toBase64Url } from "./tokens";

/** The binding a ref names: the same for both placements (§2). */
export interface ObjectRef {
  /** The raw 32-byte Resource ID. */
  readonly resourceId: Uint8Array;
  /** The Shared Objects type, such as `task`. */
  readonly objectType: string;
  /** The canonical UUIDv7 Object ID. */
  readonly objectId: string;
}

/** Why an object reference is invalid (§15, §27). */
export type ObjectRefError = "MALFORMED_LFCP_REF" | "RESOURCE_ID_INVALID" | "OBJECT_ID_INVALID";

export type ObjectRefResult =
  | { readonly ok: true; readonly ref: ObjectRef }
  | { readonly ok: false; readonly code: ObjectRefError };

/**
 * Parse an object reference. The `lfcp1:` prefix, the `#` fragment and the
 * type/ID separator are structure (MALFORMED_LFCP_REF); then the Resource
 * token (RESOURCE_ID_INVALID), the type (MALFORMED_LFCP_REF, MR-A1) and the
 * Object ID (OBJECT_ID_INVALID) are checked in that order.
 */
export function parseObjectRef(text: string): ObjectRefResult {
  const fail = (code: ObjectRefError): ObjectRefResult => ({ ok: false, code });
  if (!text.startsWith("lfcp1:")) return fail("MALFORMED_LFCP_REF");
  const rest = text.slice("lfcp1:".length);
  const hash = rest.indexOf("#");
  if (hash < 0) return fail("MALFORMED_LFCP_REF");
  const fragment = rest.slice(hash + 1);
  const colon = fragment.indexOf(":");
  if (colon < 0) return fail("MALFORMED_LFCP_REF");
  const resourceId = decodeResourceId(rest.slice(0, hash));
  if (!resourceId) return fail("RESOURCE_ID_INVALID");
  const objectType = fragment.slice(0, colon);
  if (!isObjectType(objectType)) return fail("MALFORMED_LFCP_REF");
  const objectId = fragment.slice(colon + 1);
  if (!isObjectId(objectId)) return fail("OBJECT_ID_INVALID");
  return { ok: true, ref: { resourceId, objectType, objectId } };
}

/** The canonical text of an object reference. Throws on an invalid one. */
export function formatObjectRef(ref: ObjectRef): string {
  if (ref.resourceId.length !== 32) throw new Error("a Resource ID has 32 bytes");
  if (!isObjectType(ref.objectType)) throw new Error(`invalid object type ${ref.objectType}`);
  if (!isObjectId(ref.objectId)) throw new Error(`invalid Object ID ${ref.objectId}`);
  return `lfcp1:${toBase64Url(ref.resourceId)}#${ref.objectType}:${ref.objectId}`;
}

/** Whether two refs name the same Shared Object (§2: placement aside). */
export function sameBinding(a: ObjectRef, b: ObjectRef): boolean {
  return (
    a.objectType === b.objectType &&
    a.objectId === b.objectId &&
    a.resourceId.length === b.resourceId.length &&
    a.resourceId.every((byte, i) => byte === b.resourceId[i])
  );
}

/**
 * §9: the ref's type must equal the referenced object's immutable `type`.
 * A mismatch is OBJECT_TYPE_MISMATCH and is never repaired by changing the
 * object. The caller supplies the object's type from the Shared Object.
 */
export function checkObjectType(
  ref: ObjectRef,
  actualType: string,
): "OBJECT_TYPE_MISMATCH" | undefined {
  return ref.objectType === actualType ? undefined : "OBJECT_TYPE_MISMATCH";
}
