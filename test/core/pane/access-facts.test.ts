// LFCP-03-013: the pane's access facts are read from the access list on
// demand, once at a time, kept until what they rest on changes, then
// forgotten at once (unknown, never the old answer); a read started before
// the change is dropped by its epoch, and a failed read is unknown.

import { describe, expect, it } from "vitest";
import { PaneAccessFacts } from "../../../src/core/pane/access-facts";
import type { PaneAccess } from "../../../src/core/pane/host-facts";

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(readable = (_key: string) => true) {
  const loads: { key: string; d: ReturnType<typeof deferred<PaneAccess>> }[] = [];
  let changed = 0;
  const facts = new PaneAccessFacts({
    load: (key) => {
      const d = deferred<PaneAccess>();
      loads.push({ key, d });
      return d.promise;
    },
    readable,
    changed: () => {
      changed++;
    },
  });
  return { facts, loads, changed: () => changed };
}

const ALLOWED: PaneAccess = { canInvite: true, hosting: "hosted" };
const DENIED: PaneAccess = { canInvite: false, hosting: "hosted" };

describe("pane access facts (LFCP-03-013)", () => {
  it("unknown until read; one read at a time; kept once read", async () => {
    const t = setup();
    expect(t.facts.get("k")).toBeUndefined();
    expect(t.facts.get("k")).toBeUndefined();
    expect(t.loads).toHaveLength(1);
    t.loads[0]?.d.resolve(ALLOWED);
    await flush();
    expect(t.changed()).toBe(1);
    expect(t.facts.get("k")).toEqual(ALLOWED);
    expect(t.loads).toHaveLength(1);
  });

  it("P3: a change forgets the facts at once; a read started before it is dropped", async () => {
    const t = setup();
    t.facts.get("k");
    t.loads[0]?.d.resolve(ALLOWED);
    await flush();
    // The access changed (a revocation): unknown now, not the old grant.
    t.facts.forget("k");
    expect(t.facts.get("k")).toBeUndefined();
    expect(t.loads).toHaveLength(2);
    // Another change while that read runs: its answer is late.
    t.facts.forget("k");
    t.loads[1]?.d.resolve(ALLOWED);
    await flush();
    expect(t.facts.get("k")).toBeUndefined();
    expect(t.loads).toHaveLength(3);
    t.loads[2]?.d.resolve(DENIED);
    await flush();
    expect(t.facts.get("k")).toEqual(DENIED);
  });

  it("forgetAll: a hosting change forgets every section, a read in flight included", async () => {
    const t = setup();
    t.facts.get("a");
    t.facts.get("b");
    t.loads[0]?.d.resolve({ canInvite: true, hosting: "pending" });
    await flush();
    t.facts.forgetAll();
    t.loads[1]?.d.resolve(ALLOWED);
    await flush();
    expect(t.facts.get("a")).toBeUndefined();
    expect(t.facts.get("b")).toBeUndefined();
    expect(t.loads).toHaveLength(4);
  });

  it("a failed read is unknown, neither a grant nor a denial, and is not retried in a loop", async () => {
    const t = setup();
    t.facts.get("k");
    t.loads[0]?.d.reject(new Error("closed"));
    await flush();
    expect(t.facts.get("k")).toEqual({ canInvite: null, hosting: "unknown" });
    expect(t.loads).toHaveLength(1);
  });

  it("a section that may not be read (not watched) stays unknown and opens nothing", () => {
    const t = setup(() => false);
    expect(t.facts.get("k")).toBeUndefined();
    expect(t.loads).toHaveLength(0);
  });
});
