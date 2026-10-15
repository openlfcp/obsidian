// LFCP-03-033: a staged batch is reverted only while it is not durable.

import type { CommitBinding, StagedOperation } from "@openlfcp/client";
import { describe, expect, it } from "vitest";
import { keepDurable } from "../../../src/core/lfcp/durable-commit";

function binding(onCommitted: () => void = () => undefined) {
  const calls: string[] = [];
  const staged: StagedOperation<string> = {
    values: ["change"],
    affectedNodeIds: ["n1"],
    modelRevision: "r1",
    apply: () => calls.push("apply"),
    revert: () => calls.push("revert"),
    writes: () => [],
    committed: () => {
      calls.push("committed");
      onCommitted();
    },
  };
  const inner: CommitBinding<string> = {
    codec: { dataProfile: "p", encode: (v) => new TextEncoder().encode(v), decode: () => "" },
    stage: (intents) => (intents.length === 0 ? null : staged),
    section: () => undefined,
  };
  return { calls, wrapped: keepDurable(inner) };
}

describe("keepDurable", () => {
  it("reverts a batch that was not stored", () => {
    const { calls, wrapped } = binding();
    const s = wrapped.stage(["x"]);
    s?.apply();
    s?.revert();
    expect(calls).toEqual(["apply", "revert"]);
  });

  it("never reverts a stored batch, even when what follows the store throws", () => {
    const { calls, wrapped } = binding();
    const s = wrapped.stage(["x"]);
    s?.apply();
    s?.committed([]);
    s?.revert();
    expect(calls).toEqual(["apply", "committed"]);
  });

  it("counts a batch as stored once committed is called, even if that call throws", () => {
    const { calls, wrapped } = binding(() => {
      throw new Error("a listener fails");
    });
    const s = wrapped.stage(["x"]);
    s?.apply();
    expect(() => s?.committed([])).toThrow("a listener fails");
    s?.revert();
    expect(calls).toEqual(["apply", "committed"]);
  });

  it("keeps what the binding says: no batch, the values, the section", () => {
    const { wrapped } = binding();
    expect(wrapped.stage([])).toBeNull();
    const s = wrapped.stage(["x"]);
    expect(s?.values).toEqual(["change"]);
    expect(s?.affectedNodeIds).toEqual(["n1"]);
    expect(s?.modelRevision).toBe("r1");
    expect(wrapped.section?.()).toBeUndefined();
  });
});
