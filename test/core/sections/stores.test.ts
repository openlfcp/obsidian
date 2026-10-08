// The section engine's records in the install database (LFCP-02-038),
// over a key-value store that keeps structured clones as the install
// database does. A restart is a new engine on the same store.

import { principalId } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import {
  MemorySectionBaseStore,
  markdownState,
  type StoredBase,
} from "../../../src/core/sections/base";
import { applyChanges, SectionEngine } from "../../../src/core/sections/engine";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
} from "../../../src/core/sections/grammar";
import { advance, type JournalEntry, JournalError } from "../../../src/core/sections/journal";
import { parseSections } from "../../../src/core/sections/parser";
import {
  type KeyValue,
  KeyValueSectionBaseStore,
  KeyValueSectionJournalStore,
} from "../../../src/core/sections/stores";
import { FakeSectionPort } from "./fake-port";

/** The install database's local state, in memory: values are cloned in and out. */
function kv(): KeyValue & { readonly map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  const get = async (k: string) => structuredClone(map.get(k));
  const put = async (k: string, v: unknown) => void map.set(k, structuredClone(v));
  let chain = Promise.resolve();
  return {
    map,
    get,
    put,
    update: (k, change) => {
      chain = chain.then(async () => put(k, change(await get(k))));
      return chain;
    },
  };
}

const R = new Uint8Array(32).fill(7);
const base = (path: string, title = "Launch"): StoredBase => ({
  locator: { path, section: { resourceId: R, sectionId: "s-1" } },
  state: { title, nodes: {}, order: {} },
  revision: "h1",
  nodeRevisions: { n: null },
});

describe("KeyValueSectionBaseStore", () => {
  it("keeps bases by projection, finds them by note, follows a rename, forgets a deleted one", async () => {
    const store = new KeyValueSectionBaseStore(kv());
    await store.save("p-1", base("a.md"));
    await store.save("p-2", base("a.md", "Copy"));
    expect(await store.projectionsOf("a.md")).toEqual(["p-1", "p-2"]);
    expect(await store.load("p-1")).toEqual(base("a.md"));
    await store.rename("a.md", "b.md");
    expect(await store.projectionsOf("a.md")).toEqual([]);
    expect(await store.projectionsOf("b.md")).toEqual(["p-1", "p-2"]);
    expect((await store.load("p-2"))?.locator.path).toBe("b.md");
    await store.save("p-1", null);
    expect(await store.load("p-1")).toBeUndefined();
    expect(await store.projectionsOf("b.md")).toEqual(["p-2"]);
  });

  it("reads the same as the in-memory store", async () => {
    const a = new KeyValueSectionBaseStore(kv());
    const b = new MemorySectionBaseStore();
    for (const s of [a, b]) await s.save("p", base("n.md"));
    expect(await a.load("p")).toEqual(await b.load("p"));
  });
});

describe("KeyValueSectionJournalStore", () => {
  const entry: JournalEntry = {
    operationId: "op-1",
    projectionId: "p-1",
    resource: "r",
    phase: "captured",
    sourceHash: "h0",
    allocatedIds: {},
  };

  it("keeps entries forward only, lists the unfinished ones, survives a restart", async () => {
    const state = kv();
    const journal = new KeyValueSectionJournalStore(state);
    await journal.put(entry);
    const ids = advance(entry, "ids-allocated", {
      allocatedIds: { 3: "n-1" },
      intents: [{ intent: "node.delete", id: "n-0" }],
    });
    await journal.put(ids);
    await expect(journal.put(entry)).rejects.toBeInstanceOf(JournalError);
    // A restart: a new store on the same database.
    const after = new KeyValueSectionJournalStore(state);
    expect(await after.unfinished()).toEqual([ids]);
    await after.put(advance(ids, "abandoned", { reason: "test" }));
    expect(await after.unfinished()).toEqual([]);
    expect((await after.get("op-1"))?.phase).toBe("abandoned");
  });

  it("keeps candidates until they are resolved", async () => {
    const journal = new KeyValueSectionJournalStore(kv());
    const c = {
      candidateId: "c-1",
      projectionId: "p-1",
      reason: "read-only" as const,
      sourceText: "x",
    };
    await journal.putCandidate(c);
    expect(await journal.candidates("p-1")).toEqual([c]);
    await journal.resolveCandidate("c-1");
    expect(await journal.candidates("p-1")).toEqual([]);
  });
});

describe("the engine across a restart, on the install database", () => {
  it("a commit whose bindings were never written is projected by the next engine, with the same ID", async () => {
    const RB = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
    const id = (n: number) => `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
    const S = parseSectionRef(`lfcp1:${RB}#section:${id(1)}`);
    if (S === undefined) throw new Error("ref");
    const note = (body: string[]) =>
      ["## Launch", formatBoundary("start", S), ...body, formatBoundary("end", S), ""].join("\n");
    const initial = note([formatNodeMarker("paragraph", id(2)), "Draft"]);
    const port = new FakeSectionPort();
    const s = parseSections(initial).sections[0];
    if (s === undefined) throw new Error("section");
    port.host(RB, id(1), markdownState(initial, s).state);
    const state = kv();
    let n = 100;
    const engine = () =>
      new SectionEngine({
        port,
        journal: new KeyValueSectionJournalStore(state),
        bases: new KeyValueSectionBaseStore(state),
        newNodeId: () => id(n++),
        newOperationId: () => `op-${n++}`,
        createdBy: principalId(new Uint8Array(32).fill(4)),
        newProjectionId: () => "projection",
        tasks: () => undefined,
        newTask: (line, taskId) => ({ id: taskId, title: line.replace(/^- \[ \] /, "") }),
      });
    const ctx = { caretLine: null, deletedIds: new Set<string>(), origin: "other" as const };
    const first = engine();
    const seed = await first.pass("Launch.md", initial, ctx);
    await first.written(seed, initial);
    const typed = note([formatNodeMarker("paragraph", id(2)), "Draft", "", "- [ ] Call Anna"]);
    const lost = await first.pass("Launch.md", typed, ctx); // committed; the process stops before writing
    expect(lost.changes).not.toEqual([]);
    expect(port.changes).toHaveLength(1);

    const second = engine(); // restart
    const pass = await second.pass("Launch.md", typed, ctx);
    const out = applyChanges(typed, pass.changes);
    await second.written(pass, out);
    expect(port.changes).toHaveLength(1);
    expect(out).toContain(`#task:${id(100)} -->`);
    const again = await second.pass("Launch.md", out, ctx);
    expect(again.changes).toEqual([]);
  });
});
