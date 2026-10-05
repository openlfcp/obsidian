import { principalId } from "@openlfcp/core";
import { principalKeySecretRef } from "@openlfcp/storage";
import { describe, expect, it } from "vitest";
import { markerSlotId, SlotSecretStore, secretSlotId } from "../../../src/core/lfcp/secrets";
import { FakeSecretSlots } from "../../support/lfcp-env";

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";
const ref = principalKeySecretRef(principalId(new Uint8Array(32).fill(7)), "signing");

describe("SlotSecretStore (secretStorage, LFCP-059)", () => {
  it("uses valid Obsidian secret IDs, namespaced per install", () => {
    expect(secretSlotId(A, ref)).toMatch(/^openlfcp-[0-9a-f]{32}-[0-9a-f]{32}$/);
    expect(secretSlotId(A, ref)).not.toBe(secretSlotId(B, ref));
    expect(markerSlotId(A)).toBe(`openlfcp-${A}-marker`);
    expect(() => secretSlotId("NOT-AN-ID", ref)).toThrow();
  });

  it("keeps installs apart, round-trips empty values and deletes with a tombstone", async () => {
    const slots = new FakeSecretSlots();
    const a = new SlotSecretStore(slots, A);
    const b = new SlotSecretStore(slots, B);
    await a.put(ref, Uint8Array.of(1, 2, 3));
    expect(await a.get(ref)).toEqual(Uint8Array.of(1, 2, 3));
    expect(await b.get(ref)).toBeUndefined();
    await b.put(ref, new Uint8Array());
    expect(await b.get(ref)).toEqual(new Uint8Array());
    await a.delete(ref);
    expect(await a.get(ref)).toBeUndefined();
    expect(slots.get(secretSlotId(A, ref))).toBe(""); // no delete in secretStorage
    expect(JSON.stringify({ a })).toBe('{"a":"[SlotSecretStore]"}');
  });
});
