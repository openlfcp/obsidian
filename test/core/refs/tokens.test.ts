// The token validators (over @openlfcp/core since LFCP-059), and a
// differential check against the spec's own fixtures at spec.lock.

import { describe, expect, it } from "vitest";
import {
  decodeResourceId,
  fromBase64Url,
  isObjectId,
  isObjectType,
  parseObjectRef,
  toBase64Url,
} from "../../../src/core/refs";
import { openSpec } from "../../support/spec";

const spec = openSpec();
const json = (path: string) => JSON.parse(spec.read(path));
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

describe("base64url (MR§8, WIRE §18.2)", () => {
  it("round-trips every length and rejects non-canonical forms", () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
    // Bad length, padding, alphabet, and non-zero unused bits (AB, AR).
    for (const bad of ["A", "AQ=", "AA==", "A+B/", "AB!", "AB", "AR"]) {
      expect(fromBase64Url(bad), bad).toBeUndefined();
    }
    expect(fromBase64Url("AQ")).toEqual(Uint8Array.of(1));
  });

  it("matches the Wire vectors' invitation URI encodings", () => {
    const suite = json("test-vectors/lfcp-wire-01/LFCP-TEST-VECTORS-01.json");
    const invite = suite.cases.find((c: { id: string }) => c.id === "invite_uri").expected;
    const resource = hex(suite.fixtures.resource.id.hex);
    expect(toBase64Url(resource)).toBe(invite.resource_b64url.b64url);
    expect(decodeResourceId(invite.resource_b64url.b64url)).toEqual(resource);
    expect(toBase64Url(hex(invite.secret_cbor.hex))).toBe(invite.secret_b64url.b64url);
    // A 32-byte grant ID decodes as a Resource-sized token; the secret does not.
    expect(decodeResourceId(invite.grant_id_b64url.b64url)).toHaveLength(32);
    expect(decodeResourceId(invite.secret_b64url.b64url)).toBeUndefined();
  });

  it("matches the Shared Objects PrincipalRef vectors and fixtures", () => {
    const suite = json("test-vectors/shared-objects-01/SHARED-OBJECTS-TEST-VECTORS-01.json");
    for (const [name, p] of Object.entries<{ id_hex: string; ref: string }>(
      suite.fixtures.principals,
    )) {
      expect(`p:${toBase64Url(hex(p.id_hex))}`, name).toBe(p.ref);
      expect(decodeResourceId(p.ref.slice(2)), name).toEqual(hex(p.id_hex));
    }
    const short = json(
      "profiles/shared-objects-01/schema/fixtures/invalid-principal-ref-31-bytes.json",
    );
    const refs = Object.values<{ created_by: string }>(short.objects).map((o) => o.created_by);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(decodeResourceId(ref.slice(2)), ref).toBeUndefined();
  });
});

describe("Object IDs (MR§10, SHARED-OBJECTS-PROFILE-01 §19)", () => {
  it("match D06-D08", () => {
    const suite = json("test-vectors/shared-objects-01/SHARED-OBJECTS-TEST-VECTORS-01.json");
    const cases = suite.cases.filter((c: { kind: string }) => c.kind === "object_id_validation");
    expect(cases).toHaveLength(3);
    for (const c of cases) expect(isObjectId(c.inputs.object_id), c.id).toBe(c.expected.valid);
  });

  it("match every object key of the profile schema fixtures", () => {
    const dir = "profiles/shared-objects-01/schema/fixtures";
    const expected = json(`${dir}/expected.json`).cases as Record<string, { diagnostic: string }>;
    const names = [
      "valid-completed-task.json",
      "valid-typical-task.json",
      "valid-unknown-object-type.json",
      "valid-tombstoned-task.json",
      "invalid-object-id-uuidv4.json",
    ];
    for (const name of names) {
      const state = json(`${dir}/${name}`);
      const invalidId = expected[name]?.diagnostic === "INVALID_OBJECT_ID";
      for (const key of Object.keys(state.objects))
        expect(isObjectId(key), `${name} ${key}`).toBe(!invalidId);
    }
  });
});

describe("object refs (MR§7, MR§9)", () => {
  it("parse and classify errors in order: structure, Resource, type, Object ID", () => {
    const r = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
    const o = "019a2f85-7b31-7c42-b85a-fc843e2f40ad";
    expect(parseObjectRef(`lfcp1:${r}#task:${o}`).ok).toBe(true);
    const code = (text: string) => {
      const result = parseObjectRef(text);
      return result.ok ? "ok" : result.code;
    };
    expect(code(`lfcp2:${r}#task:${o}`)).toBe("MALFORMED_LFCP_REF");
    expect(code(`lfcp1:${r}`)).toBe("MALFORMED_LFCP_REF");
    expect(code(`lfcp1:${r}#task`)).toBe("MALFORMED_LFCP_REF");
    expect(code(`lfcp1:AAA#Task:bad`)).toBe("RESOURCE_ID_INVALID");
    expect(code(`lfcp1:${r}#Task:${o}`)).toBe("MALFORMED_LFCP_REF");
    expect(code(`lfcp1:${r}#task:${o.toUpperCase()}`)).toBe("OBJECT_ID_INVALID");
  });

  it("accept `task` and reverse-domain types only (MR-A1)", () => {
    for (const ok of ["task", "org.example.poll", "com.vendor.issue", "a.b"])
      expect(isObjectType(ok), ok).toBe(true);
    for (const bad of ["Task", "poll", "", "org..x", "-org.x", "org.x-", "org.Example"]) {
      expect(isObjectType(bad), bad).toBe(false);
    }
  });
});
