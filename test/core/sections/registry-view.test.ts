// U03-02 (LFCP-03-011, F-02, F-10): the section registry view a pane reads.
// Loading, error and empty differ; "not inserted yet" only once the placement
// index is complete; equal titles stay two rows; the shared title and the
// local alias stay apart; an index rebuild, a rename, a delete and a detach
// update the view, and its listeners hear of each change once. A Resource
// with no status is unknown, never healthy. The view reads only local
// sources: it opens no model and no session.

import type { ResourceId } from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { describe, expect, it } from "vitest";
import type { RegistryEntry } from "../../../src/core/lfcp/runtime";
import { PlacementIndex } from "../../../src/core/sections/placement-index";
import {
  type RegistrySnapshot,
  type RegistryViewSources,
  rowLabel,
  SectionRegistryView,
} from "../../../src/core/sections/registry-view";
import type { StatusView } from "../../../src/core/status/reducer";

const rid = (n: number) => new Uint8Array(32).fill(n) as ResourceId;
const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const b64 = (n: number) => Buffer.from(rid(n)).toString("base64url");

function entry(n: number, localName: string | null, extra: Partial<RegistryEntry> = {}) {
  return {
    resourceId: rid(n),
    localName,
    profile: SECTIONS_PROFILE_ID,
    routes: [],
    lastKnownControlHead: null,
    state: "available",
    refusal: null,
    ...extra,
  } as RegistryEntry;
}

/** A fake of the host's local sources, recording each read. */
function sources() {
  const reads: string[] = [];
  const s = {
    entries: [] as RegistryEntry[],
    fail: null as Error | null,
    models: new Map<number, { sectionId: string; title: string }>(),
    watchedSet: new Set<string>(),
    statuses: new Map<string, StatusView>(),
    placements: new PlacementIndex(),
    reads,
  };
  const src: RegistryViewSources = {
    registry: async () => {
      reads.push("registry");
      if (s.fail !== null) throw s.fail;
      return s.entries;
    },
    model: (R) => {
      reads.push("model");
      return s.models.get(R[0] as number) ?? null;
    },
    watched: (h) => s.watchedSet.has(h),
    status: (key) => s.statuses.get(key),
    placements: s.placements,
  };
  return { s, src };
}

const view = (state: StatusView["state"]) => ({ state }) as StatusView;

describe("U03-02 registry view", () => {
  it("loading, error and empty are three states", async () => {
    const { s, src } = sources();
    const v = new SectionRegistryView(src);
    expect(v.snapshot()).toMatchObject({ status: "loading", sections: null, unplaced: null });
    s.fail = new Error("storage closed");
    await v.refresh();
    expect(v.snapshot()).toMatchObject({
      status: "error",
      error: "storage closed",
      sections: null,
      rows: [],
    });
    s.fail = null;
    s.placements.begin();
    s.placements.end();
    await v.refresh();
    expect(v.snapshot()).toMatchObject({ status: "ready", error: null, sections: 0, unplaced: 0 });
  });

  it("a failed read keeps the joined sections it knew, and is not empty", async () => {
    const { s, src } = sources();
    s.entries = [entry(1, "Sprint")];
    const v = new SectionRegistryView(src);
    await v.refresh();
    s.fail = new Error("storage closed");
    await v.refresh();
    const snap = v.snapshot();
    expect(snap.status).toBe("error");
    expect(snap.rows.map((r) => r.localAlias)).toEqual(["Sprint"]);
    expect([snap.sections, snap.unplaced]).toEqual([null, null]);
  });

  it("unplaced only after the placement index is complete; a copy found before counts", async () => {
    const { s, src } = sources();
    s.entries = [entry(1, "Sprint"), entry(2, "Launch")];
    const v = new SectionRegistryView(src);
    await v.refresh();
    expect(v.snapshot().placementIndex).toBe("unknown");
    expect(v.snapshot().rows.map((r) => r.placed)).toEqual(["unknown", "unknown"]);
    s.placements.begin();
    s.placements.index("Plan.md", { copies: [hex(2)], damaged: [] });
    let snap = v.snapshot();
    expect(snap.placementIndex).toBe("building");
    expect(snap.unplaced).toBeNull();
    const launch = v.row(b64(2));
    expect([launch?.placed, launch?.placementCount]).toEqual(["placed", null]);
    expect(v.row(b64(1))?.placed).toBe("unknown");
    s.placements.end();
    snap = v.snapshot();
    expect(snap.unplaced).toBe(1);
    expect(v.row(b64(1))).toMatchObject({ placed: "unplaced", placementCount: 0 });
    expect(v.row(b64(2))).toMatchObject({
      placed: "placed",
      placementCount: 1,
      placements: [{ path: "Plan.md", copies: 1, damaged: 0 }],
    });
    expect(v.inNote("Plan.md").map((r) => r.resource)).toEqual([b64(2)]);
  });

  it("a failed index build leaves placement unknown, never unplaced", async () => {
    const { s, src } = sources();
    s.entries = [entry(1, "Sprint")];
    const v = new SectionRegistryView(src);
    await v.refresh();
    s.placements.begin();
    s.placements.end("the notes were not all read");
    expect(v.snapshot()).toMatchObject({ placementIndex: "unknown", unplaced: null });
    expect(v.row(b64(1))?.placed).toBe("unknown");
  });

  it("equal titles stay two rows; the shared title and the local alias stay apart", async () => {
    const { s, src } = sources();
    s.entries = [entry(1, "Sprint (from B)"), entry(2, "Sprint"), entry(3, "Team")];
    s.models.set(1, { sectionId: "s-1", title: "Sprint" });
    s.models.set(2, { sectionId: "s-2", title: "Sprint" });
    const v = new SectionRegistryView(src);
    await v.refresh();
    const rows = v.snapshot().rows;
    expect(rows.map((r) => [r.resource, r.key, r.sharedTitle, r.localAlias])).toEqual([
      [b64(1), `${b64(1)}#s-1`, "Sprint", "Sprint (from B)"],
      [b64(2), `${b64(2)}#s-2`, "Sprint", "Sprint"],
      [b64(3), null, null, "Team"],
    ]);
    expect(rows.map(rowLabel)).toEqual([
      { primary: "Sprint", aliasOnly: false, onThisDevice: "Sprint (from B)" },
      { primary: "Sprint", aliasOnly: false, onThisDevice: null },
      // N3: before the shared title loaded, the alias, qualified.
      { primary: "Team", aliasOnly: true, onThisDevice: null },
    ]);
    expect(rowLabel({ sharedTitle: null, localAlias: null }).primary).toBeNull();
    expect(rowLabel({ sharedTitle: "", localAlias: " Old " })).toEqual({
      primary: "Old",
      aliasOnly: true,
      onThisDevice: null,
    });
  });

  it("a missing status is unknown, never healthy: unwatched, or watched with no status yet", async () => {
    const { s, src } = sources();
    s.entries = [entry(1, "A"), entry(2, "B"), entry(3, "C")];
    for (const n of [1, 2, 3]) s.models.set(n, { sectionId: `s-${n}`, title: `T${n}` });
    s.watchedSet.add(hex(2));
    s.watchedSet.add(hex(3));
    s.statuses.set(`${b64(3)}#s-3`, view("CURRENT"));
    // A status kept for a Resource no longer watched is not used.
    s.statuses.set(`${b64(1)}#s-1`, view("CURRENT"));
    const v = new SectionRegistryView(src);
    await v.refresh();
    expect(v.snapshot().rows.map((r) => r.status)).toEqual([
      { watched: false, state: null },
      { watched: true, state: null },
      { watched: true, state: "CURRENT" },
    ]);
  });

  it("only section Resources are listed; the registry state and refusal are kept", async () => {
    const { s, src } = sources();
    s.entries = [
      entry(1, "Tasks", { profile: "lfcp.shared-objects.v1" }),
      entry(2, "Gone", { state: "refused", refusal: { code: "RESOURCE_NOT_HOSTED" } as never }),
    ];
    const v = new SectionRegistryView(src);
    await v.refresh();
    expect(v.snapshot().rows.map((r) => [r.localAlias, r.registryState, r.refusal])).toEqual([
      ["Gone", "refused", "RESOURCE_NOT_HOSTED"],
    ]);
  });

  it("index rebuild, rename, delete and detach update the view; each change is told once", async () => {
    const { s, src } = sources();
    s.entries = [entry(1, "Sprint")];
    const v = new SectionRegistryView(src);
    const told: RegistrySnapshot[] = [];
    v.onChange((snap) => told.push(snap));
    await v.refresh();
    s.placements.begin();
    s.placements.index("A.md", { copies: [hex(1)], damaged: [] });
    s.placements.index("B.md", { copies: [hex(1)], damaged: [] });
    s.placements.end();
    expect(v.row(b64(1))?.placementCount).toBe(2);
    const n = told.length;
    // A model or status recompute with nothing new is not told.
    v.update();
    expect(told.length).toBe(n);
    // Rename: the copy goes with the note.
    s.placements.rename("A.md", "Dir/A2.md");
    expect(v.row(b64(1))?.placements.map((p) => p.path)).toEqual(["B.md", "Dir/A2.md"]);
    // Delete a note.
    s.placements.unindex("B.md");
    expect(v.row(b64(1))?.placementCount).toBe(1);
    // Detach in the last note: unplaced, the section stays listed.
    s.placements.index("Dir/A2.md", { copies: [], damaged: [] });
    expect(v.row(b64(1))).toMatchObject({ placed: "unplaced", placementCount: 0 });
    expect(v.snapshot().unplaced).toBe(1);
    // Rebuild: unknown while building, then the notes found again.
    s.placements.begin();
    expect(v.row(b64(1))?.placed).toBe("unknown");
    expect(v.snapshot().unplaced).toBeNull();
    s.placements.index("C.md", { copies: [hex(1)], damaged: [] });
    s.placements.end();
    expect(v.row(b64(1))).toMatchObject({ placed: "placed", placementCount: 1 });
    expect(told.length).toBe(n + 6);
    const versions = told.map((t) => t.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("a joined section appears on a refresh; a discarded one goes", async () => {
    const { s, src } = sources();
    s.placements.begin();
    s.placements.end();
    const v = new SectionRegistryView(src);
    await v.refresh();
    expect(v.snapshot().sections).toBe(0);
    s.entries = [entry(1, "Sprint")];
    await v.refresh();
    expect(v.snapshot()).toMatchObject({ sections: 1, unplaced: 1 });
    // Its model opened (the join loaded it): the shared title and key.
    s.models.set(1, { sectionId: "s-1", title: "Sprint" });
    v.update();
    expect(v.row(b64(1))?.key).toBe(`${b64(1)}#s-1`);
    s.entries = [];
    await v.refresh();
    expect(v.snapshot()).toMatchObject({ sections: 0, unplaced: 0 });
  });

  it("reads never overlap; a refresh asked during one runs once after it", async () => {
    const { s, src } = sources();
    let release: () => void = () => undefined;
    let calls = 0;
    const slow: RegistryViewSources = {
      ...src,
      registry: async () => {
        calls++;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        return s.entries;
      },
    };
    const v = new SectionRegistryView(slow);
    const first = v.refresh();
    // The first read is under way; the registry changes meanwhile.
    while (calls === 0) await Promise.resolve();
    s.entries = [entry(1, "Sprint")];
    const second = v.refresh();
    const third = v.refresh();
    release();
    await Promise.all([first, second, third]);
    expect(calls).toBe(2);
    expect(v.snapshot().rows.length).toBe(1);
  });

  it("a refresh asked just as a read ends starts a new read; none is lost", async () => {
    const { s, src } = sources();
    let calls = 0;
    const counted: RegistryViewSources = {
      ...src,
      registry: async () => {
        calls++;
        return s.entries;
      },
    };
    const v = new SectionRegistryView(counted);
    let asked: Promise<void> | null = null;
    // The last change of the first read: a refresh asked a microtask later,
    // after the read's last check and before anything else runs.
    const stop = v.onChange(() => {
      stop();
      queueMicrotask(() => {
        s.entries = [entry(1, "Joined")];
        asked = v.refresh();
      });
    });
    await v.refresh();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).not.toBeNull();
    await asked;
    expect(calls).toBe(2);
    expect(v.snapshot().rows.map((r) => r.localAlias)).toEqual(["Joined"]);
  });

  it("a read that throws at once still ends; the next refresh reads again", async () => {
    const { s, src } = sources();
    let calls = 0;
    const throwing: RegistryViewSources = {
      ...src,
      registry: () => {
        calls++;
        if (calls === 1) throw new Error("closed");
        return Promise.resolve(s.entries);
      },
    };
    const v = new SectionRegistryView(throwing);
    await v.refresh();
    expect(v.snapshot().status).toBe("error");
    await v.refresh();
    expect([calls, v.snapshot().status]).toEqual([2, "ready"]);
  });

  it("opens nothing: only the registry and already-open models are read", async () => {
    const { s, src } = sources();
    s.entries = [entry(1, "A"), entry(2, "B")];
    const v = new SectionRegistryView(src);
    await v.refresh();
    v.update();
    expect(new Set(s.reads)).toEqual(new Set(["registry", "model"]));
    expect(Object.keys(src).sort()).toEqual([
      "model",
      "placements",
      "registry",
      "status",
      "watched",
    ]);
  });

  it("dispose stops listening to the index", async () => {
    const { s, src } = sources();
    const v = new SectionRegistryView(src);
    let told = 0;
    v.onChange(() => told++);
    v.dispose();
    s.placements.begin();
    expect(told).toBe(0);
  });
});
