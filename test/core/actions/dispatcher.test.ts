// LFCP-03-023 (U03-07, F-C08): the action seam as a contract, on the pure
// dispatcher. Every action of the catalogue, run from any surface, reaches
// the same executor method with the same arguments: the surface changes
// nothing but where "Join with a link…" asks for the link (the pane's own
// field, I5). With shared sections off no section action reaches the
// executor. A section key a surface hands over (full, or the Resource
// alone for a section whose model is not read yet) names one Resource.

import { toBase64url } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import { ACTION_IDS, type ActionId } from "../../../src/core/actions/catalog";
import {
  ActionDispatcher,
  type ActionRequest,
  type CollabEntry,
  coreHandlers,
  type HostEntry,
  type Surface,
} from "../../../src/core/actions/dispatcher";
import type { SectionActions } from "../../../src/core/sections/actions";
import type { TargetCapture } from "../../../src/core/sections/target";

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const KEY = `${R0}#019a2f85-7b31-7c42-b85a-fc843e2f4001`;
const SURFACES: readonly Surface[] = ["palette", "card", "menu", "pane"];

const target: TargetCapture = {
  path: "Plan.md",
  text: "# Plan\n",
  mode: "source",
  cursorLine: 0,
  selections: [],
  composing: false,
};

/** The requests a surface may hand an action: each field a surface may fill. */
const REQUESTS: readonly ActionRequest[] = [
  {},
  { target },
  { section: { key: KEY, title: "Launch" } },
  { target, section: { key: KEY, title: "Launch" } },
  { flow: 3 },
  { join: 4 },
  { at: { path: "Plan.md", line: 2 } },
  { problem: { kind: "conflict", key: "c1" }, section: { key: KEY, title: "Launch" } },
  { problem: { kind: "repair", path: "Plan.md", key: "k", line: 2, revision: "r" } },
];

/** A value as the record keeps it: a function as "fn", a Resource as its base64url. */
const plain = (v: unknown): unknown =>
  typeof v === "function" ? "fn" : v instanceof Uint8Array ? toBase64url(v) : v;

/** Every call the executor, the collaboration entry and the host receive, in order. */
function recorder() {
  const calls: string[] = [];
  const record =
    (owner: string) =>
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${owner}.${name}(${JSON.stringify(args.map(plain))})`);
      // goToHeld: no held copy, so the handler goes on to the host's next problem.
      return name === "goToHeld" ? Promise.resolve(false) : Promise.resolve();
    };
  const proxy = <T extends object>(owner: string): T =>
    new Proxy({} as T, { get: (_t, name) => record(owner)(String(name)) });
  return {
    calls,
    sections: proxy<SectionActions>("sections"),
    collab: proxy<Required<CollabEntry>>("collab"),
    host: proxy<HostEntry>("host"),
  };
}

/** What running `id` with `request` from `surface` reaches. */
async function reach(
  id: ActionId,
  request: ActionRequest,
  surface: Surface,
  sectionsOn = true,
): Promise<string[]> {
  const r = recorder();
  const d = new ActionDispatcher(
    coreHandlers({
      sections: () => (sectionsOn ? r.sections : null),
      collab: r.collab,
      host: r.host,
    }),
  );
  await d.run(id, request, surface);
  return r.calls;
}

describe("the action seam (LFCP-03-023, U03-07)", () => {
  it("every action, from any surface, reaches the same executor call with the same arguments", async () => {
    const differs: string[] = [];
    for (const id of ACTION_IDS)
      for (const request of REQUESTS) {
        const palette = await reach(id, request, "palette");
        for (const surface of SURFACES) {
          const got = await reach(id, request, surface);
          if (JSON.stringify(got) !== JSON.stringify(palette))
            differs.push(`${id} ${surface} ${JSON.stringify(got)} vs ${JSON.stringify(palette)}`);
        }
      }
    // I5: the pane joins in its own field; the palette, the card and the menu in the masked dialog.
    const join = `join-with-link pane ["collab.openJoin([])"] vs ["collab.joinCollaboration([])"]`;
    expect(differs).toEqual(REQUESTS.map(() => join));
  });

  it("every action that applies reaches something: no surface's button is dead", async () => {
    const dead: ActionId[] = [];
    for (const id of ACTION_IDS) {
      let reached = false;
      for (const request of REQUESTS)
        if ((await reach(id, request, "pane")).length > 0) reached = true;
      if (!reached) dead.push(id);
    }
    expect(dead).toEqual([]);
  });

  it("A6: with shared sections off no section action reaches the executor; joining still runs", async () => {
    const reached = new Map<ActionId, Set<string>>();
    for (const id of ACTION_IDS)
      for (const request of REQUESTS)
        for (const call of await reach(id, request, "palette", false)) {
          expect(call, id).not.toMatch(/^sections\./);
          const set = reached.get(id) ?? new Set<string>();
          set.add(call.replace(/\(.*$/, ""));
          reached.set(id, set);
        }
    // What still runs: the collaboration commands (0.1 Resources too) and the host's own,
    // none of which changes a shared section. The pane shows the rest disabled (host-facts).
    expect(Object.fromEntries([...reached].map(([id, s]) => [id, [...s].sort()]))).toEqual({
      "join-with-link": ["collab.joinCollaboration"],
      invite: ["collab.inviteCollaborator", "collab.inviteTo"],
      "resource-status": ["collab.resourceStatus"],
      "check-result": ["collab.checkJoin"],
      "open-for-editing": ["host.openForEditing"],
      "open-settings": ["host.openSettings"],
      "copy-readable": ["host.copyReadable"],
      "copy-shared-section": ["host.copySharedSection"],
    });
  });

  it("UX-02: invite with a note's cursor goes to the section at it; with nothing, to the legacy picker", async () => {
    expect(await reach("invite", { target }, "palette")).toEqual([
      'sections.inviteAt([{"path":"Plan.md","text":"# Plan\\n","mode":"source","cursorLine":0,"selections":[],"composing":false},"fn"])',
    ]);
    expect(await reach("invite", {}, "palette")).toEqual(["collab.inviteCollaborator([])"]);
  });

  it("obsidian#30: a key from a surface names one Resource, full or by its Resource alone", async () => {
    for (const key of [KEY, R0]) {
      const calls = await reach("invite", { section: { key, title: "Launch" } }, "pane");
      expect(calls).toEqual([`collab.inviteTo(${JSON.stringify([R0])})`]);
    }
  });
});
