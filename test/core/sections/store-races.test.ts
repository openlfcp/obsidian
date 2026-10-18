// LFCP-03-056 (obsidian#62): the section stores over a KV as the runtime's localState is
// (LfcpRuntime.localState): updates of one key run one at a time, a put does not wait for
// them, and every call takes a turn of the event loop, so calls that start together
// interleave at each await. A read-modify-write made of separate get and put calls loses to
// another one started beside it.

import { describe, expect, it } from "vitest";
import type { StoredBase } from "../../../src/core/sections/base";
import {
  advance,
  type JournalEntry,
  JournalError,
  type Phase,
} from "../../../src/core/sections/journal";
import {
  type KeyValue,
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";

const turn = () => new Promise<void>((r) => setTimeout(r, 0));

function runtimeKeyValue(): KeyValue & { readonly map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  const chains = new Map<string, Promise<void>>();
  const get = async (k: string) => {
    await turn();
    return structuredClone(map.get(k));
  };
  const put = async (k: string, v: unknown) => {
    await turn();
    map.set(k, structuredClone(v));
  };
  return {
    map,
    get,
    put,
    update: (k, change) => {
      const run = async () => put(k, change(await get(k)));
      const done = (chains.get(k) ?? Promise.resolve()).then(run, run);
      chains.set(
        k,
        done.then(
          () => undefined,
          () => undefined,
        ),
      );
      return done;
    },
  };
}

const R = new Uint8Array(32).fill(7);
const base = (path: string, title = "Launch"): StoredBase => ({
  locator: { path, section: { resourceId: R, sectionId: "s-1" } },
  state: { title, nodes: {}, order: {} },
  revision: "h1",
});

/** Every path index agrees with the base each projection holds. */
async function indexed(bases: KeyValueSectionBaseStore, ids: string[], paths: string[]) {
  const where: Record<string, string[]> = {};
  for (const path of paths) where[path] = await bases.projectionsOf(path);
  const held: Record<string, string[]> = {};
  for (const path of paths) held[path] = [];
  for (const id of ids) {
    const b = await bases.load(id);
    if (b !== undefined) held[b.locator.path]?.push(id);
  }
  return { where, held };
}

describe("KeyValueSectionBaseStore: parallel writers of one projection (LFCP-03-056)", () => {
  it("two saves with different paths leave the index at the path the base holds", async () => {
    const bases = new KeyValueSectionBaseStore(runtimeKeyValue());
    await bases.save("p", base("a.md"));
    await Promise.all([bases.save("p", base("b.md")), bases.save("p", base("c.md"))]);
    const { where, held } = await indexed(bases, ["p"], ["a.md", "b.md", "c.md"]);
    expect(where).toEqual(held);
  });

  // The second call starts `lag` turns of the loop after the first: every interleaving of their awaits.
  const lagged = async (first: () => Promise<void>, second: () => Promise<void>, lag: number) => {
    const a = first();
    for (let i = 0; i < lag; i++) await turn();
    await Promise.all([a, second()]);
  };
  const LAGS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  it("a save of a pass beside a rename of its note leaves the index at the path the base holds", async () => {
    for (const rename of [true, false])
      for (const lag of LAGS) {
        const bases = new KeyValueSectionBaseStore(runtimeKeyValue());
        await bases.save("p", base("old.md"));
        const save = () => bases.save("p", base("old.md", "Edited"));
        const move = () => bases.rename("old.md", "new.md");
        await (rename ? lagged(move, save, lag) : lagged(save, move, lag));
        const { where, held } = await indexed(bases, ["p"], ["old.md", "new.md"]);
        expect(where, `rename first: ${rename}, lag ${lag}`).toEqual(held);
      }
  });

  it("a rename beside a delete leaves no index entry of a deleted base", async () => {
    for (const rename of [true, false])
      for (const lag of LAGS) {
        const bases = new KeyValueSectionBaseStore(runtimeKeyValue());
        await bases.save("p", base("old.md"));
        const del = () => bases.save("p", null);
        const move = () => bases.rename("old.md", "new.md");
        await (rename ? lagged(move, del, lag) : lagged(del, move, lag));
        const { where, held } = await indexed(bases, ["p"], ["old.md", "new.md"]);
        expect(where, `rename first: ${rename}, lag ${lag}`).toEqual(held);
      }
  });

  it("a rename beside a save keeps the save's changes, never an older base", async () => {
    const bases = new KeyValueSectionBaseStore(runtimeKeyValue());
    await bases.save("p", base("old.md"));
    await Promise.all([
      bases.rename("old.md", "new.md"),
      bases.save("p", base("old.md", "Edited")),
    ]);
    const b = await bases.load("p");
    // The save came before the rename (moved with its changes) or after it (its own path).
    expect([
      ["new.md", "Edited"],
      ["old.md", "Edited"],
    ]).toContainEqual([b?.locator.path, b?.state.title]);
  });
});

describe("KeyValueSectionJournalStore: parallel puts of one operation (LFCP-03-056)", () => {
  const captured: JournalEntry = {
    operationId: "op-1",
    projectionId: "p-1",
    resource: "r",
    phase: "captured",
    sourceHash: "h0",
    allocatedIds: {},
  };
  const to = (e: JournalEntry, phase: Phase, extra = {}) => advance(e, phase, extra);
  const ids = to(captured, "ids-allocated", { intents: [] });
  const committed = to(ids, "committed", { receipt: { operationId: "op-1" } as never });
  const done = to(to(committed, "projected"), "done");

  it("a phase that lost the race to a later one is refused, the later one stays", async () => {
    const journal = new KeyValueSectionJournalStore(runtimeKeyValue());
    await journal.put(captured);
    const results = await Promise.allSettled([journal.put(committed), journal.put(ids)]);
    expect((await journal.get("op-1"))?.phase).toBe("committed");
    expect(results[1]?.status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(JournalError);
    expect((await journal.unfinished()).map((e) => e.phase)).toEqual(["committed"]);
  });

  it("an operation done beside an earlier phase stays done and out of the open list", async () => {
    const journal = new KeyValueSectionJournalStore(runtimeKeyValue());
    await journal.put(captured);
    await journal.put(ids);
    await Promise.allSettled([journal.put(done), journal.put(committed)]);
    expect((await journal.get("op-1"))?.phase).toBe("done");
    expect(await journal.unfinished()).toEqual([]);
  });

  it("an operation abandoned beside its commit ends in one of the two, listed as it is", async () => {
    const journal = new KeyValueSectionJournalStore(runtimeKeyValue());
    await journal.put(captured);
    await journal.put(ids);
    const abandoned = to(ids, "abandoned", { reason: "coalesced" });
    await Promise.allSettled([journal.put(abandoned), journal.put(committed)]);
    // Abandoned is final: a commit may not come back over it.
    expect((await journal.get("op-1"))?.phase).toBe("abandoned");
    expect(await journal.unfinished()).toEqual([]);
  });

  it("the open list agrees with the last phase whatever the order the puts finish in", async () => {
    const journal = new KeyValueSectionJournalStore(runtimeKeyValue());
    await journal.put(captured);
    await Promise.allSettled([journal.put(ids), journal.put(committed), journal.put(done)]);
    const last = (await journal.get("op-1"))?.phase;
    expect(last).toBe("done");
    expect(await journal.unfinished()).toEqual([]);
  });
});
