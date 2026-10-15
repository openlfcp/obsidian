// LFCP-03-019 (U03-15, U03-17), live: a section with three members, one
// device each. B detaches its copy through the executor the pane runs
// (SectionActions.detachSectionAt, after its confirmation): B's note keeps
// the text unbound and stops updating, C's copy keeps syncing, and nobody's
// access changes (A's access list, B's and C's own access). Then A removes
// C's access through the card's "Remove access…" (its confirmation, then
// the SDK's revocation): C is told it is removed and keeps its copy, B keeps
// its access and keeps receiving, and C receives nothing new. Reference
// server at LFCP_SERVER_BIN; skipped without one.

import type { ResourceId } from "@openlfcp/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  CardRowActions,
  SectionNotes,
  SectionPrompter,
  SectionServices,
} from "../../../src/core/sections/action-ports";
import { DETACH_CONFIRMATION, SectionActions } from "../../../src/core/sections/actions";
import { applyChanges } from "../../../src/core/sections/engine";
import { KeyValueSectionBaseStore } from "../../../src/core/sections/stores";
import type { TargetCapture } from "../../../src/core/sections/target";
import { accessView } from "../../../src/core/status/access";
import { sectionCard } from "../../../src/core/status/card";
import { statusView } from "../../../src/core/status/reducer";
import { type Peer, peer, waitFor } from "../../native/peer/main";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

const skip = liveSkipReason();
let server: LiveServer;
beforeAll(async () => {
  if (skip === null) server = await startLiveServer();
}, 30_000);
afterAll(async () => {
  await server?.stop();
});
const stopping: Peer[] = [];
afterEach(async () => {
  for (const p of stopping.splice(0)) await p.stop();
});

const NOTE = ["## Plan", "", "- [ ] Alpha", "- [ ] Beta", ""].join("\n");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** What the executor asked and said, with every confirmation answered yes. */
interface Asked {
  readonly confirms: { title: string; message: string; action: string }[];
  readonly notices: string[];
  rows: CardRowActions | null;
}

/** The section actions of peer `p`, on its notes and runtime: the executor the pane and the card run. */
function actionsOf(p: Peer, url: string): { actions: SectionActions; asked: Asked } {
  const asked: Asked = { confirms: [], notices: [], rows: null };
  const no = (name: string) => () => {
    throw new Error(`unexpected ${name}`);
  };
  const prompter = {
    notice: (m: string) => void asked.notices.push(m),
    announce: () => undefined,
    confirm: (o: { title: string; message: string; action: string }) => {
      asked.confirms.push({ title: o.title, message: o.message, action: o.action });
      return { result: Promise.resolve(true), bringForward: () => undefined };
    },
    card: (_content: unknown, _actions: unknown, _closed: unknown, rows: CardRowActions) => {
      asked.rows = rows;
      return { update: () => undefined, close: () => undefined };
    },
  } as unknown as SectionPrompter;
  const capture = (path: string): TargetCapture | null => {
    const text = p.files.get(path);
    return text === undefined
      ? null
      : { path, text, mode: "source", cursorLine: 0, selections: [], composing: false };
  };
  const notes: SectionNotes = {
    capture,
    read: async (path) => p.files.get(path) ?? null,
    edit: async (path, fn) => {
      const current = p.files.get(path);
      if (current === undefined) return;
      const changes = fn(current);
      if (changes !== null) p.files.set(path, applyChanges(current, changes));
    },
    goToLine: async () => null,
  };
  const bases = new KeyValueSectionBaseStore(p.runtime.localState);
  const services = {
    creation: () => null,
    insertion: () => null,
    bases: () => bases,
    candidates: () => null,
    model: () => ({
      snapshot: (r: string, s: string) => p.port.snapshot(r, s),
      task: (r: string, id: string) => p.port.task(r, id),
    }),
    readOnly: () => false,
    server: () => url,
    refPlacement: () => "child-line",
    indexed: () => undefined,
    pass: () => undefined,
    forget: () => undefined,
    registryChanged: () => undefined,
    scheduleStatus: () => undefined,
    unavailable: () => null,
    known: () => true,
    held: () => [],
    recoveryItems: () => [],
    commands: () => null,
    aliases: async () => ({}),
    setAlias: async () => true,
    // The card's content as the host reads it: the access list from the validated Control state.
    cardContent: async (key: string, title: string) => {
      const R = await resourceOf(p, key);
      const status = await p.collab.status(R);
      const mine = await p.runtime.sectionAccessState(R);
      return sectionCard({
        title,
        view: statusView({
          session: "s",
          revision: 1,
          replica: "loaded",
          access: "writer",
          accessVerifiedAt: mine.verifiedAt,
          accessCurrent: mine.current,
          pendingControl: [],
          connection: "connected",
          catchUp: "current-at-checkpoint",
          problems: [],
          batches: [],
          acceptanceEvidence: "available",
          projections: [],
        }),
        resource: key.slice(0, key.indexOf("#")),
        sectionId: key.slice(key.indexOf("#") + 1),
        access: accessView({
          participants: status.participants,
          mine:
            mine.verifiedAt === null
              ? null
              : {
                  allowed: mine.allowed,
                  ...(mine.reason === null ? {} : { reason: mine.reason }),
                  current: mine.current,
                  verifiedAt: mine.verifiedAt,
                  abilities: mine.abilities,
                  owner: mine.owner,
                  pendingControl: mine.pendingControl.map((x) => x.type),
                },
          aliases: {},
          connected: p.runtime.phase(R) === "LIVE",
          time: () => "now",
        }),
      });
    },
    // As the host maps the SDK's revocation (sections-host.ts).
    revokeAccess: async (R: ResourceId, principal: string) => {
      const r = await p.runtime.revokeSectionAccess(
        R,
        Uint8Array.from(Buffer.from(principal, "hex")) as never,
      );
      return r.kind === "refused"
        ? { kind: "refused" as const, reason: r.reason }
        : { kind: "queued" as const, rotated: r.epoch !== null, remainingPaths: [] };
    },
    sectionChoices: no("sectionChoices"),
    legacySource: no("legacySource"),
    watch: no("watch"),
    resolveRecovery: no("resolveRecovery"),
  } as unknown as SectionServices;
  return { actions: new SectionActions({ prompter, notes, services }), asked };
}

/** The Resource of section key `key` among `p`'s Resources. */
async function resourceOf(p: Peer, key: string): Promise<ResourceId> {
  const b64 = key.slice(0, key.indexOf("#"));
  const e = (await p.runtime.registry()).find((x) => p.b64(x.resourceId) === b64);
  if (e === undefined) throw new Error(`no Resource ${b64}`);
  return e.resourceId;
}

/** The note of `p` at `path`, after a pass. */
const passed = async (p: Peer, path: string) => (await p.pass(path)).text;

/** Whether `p`'s model of `R` has a Task titled `t` (whatever its notes show). */
async function holds(p: Peer, R: ResourceId, t: string): Promise<boolean> {
  const r = p.b64(R);
  const snap = p.port.snapshot(r, await sectionIdOf(p, R));
  return Object.entries(snap?.nodes ?? {}).some(
    ([id, n]) => n.kind === "task" && p.port.task(r, id)?.title === t,
  );
}

describe.skipIf(skip !== null)("detach and remove access, live, with three members", () => {
  it("detach changes one copy and nobody's access; removing C changes only C's", async () => {
    const a = await peer(server.url);
    const b = await peer(server.url);
    const c = await peer(server.url);
    stopping.push(a, b, c);
    a.files.set("Plan.md", NOTE);
    const { resource: R } = await a.share("Plan.md", "## Plan");
    // A's first pass seeds its copy's base (as the plugin's pass after a share).
    await a.pass("Plan.md");
    for (const [p, file] of [
      [b, "B.md"],
      [c, "C.md"],
    ] as const) {
      p.files.set(file, ["# Notes", "", "Insert below.", ""].join("\n"));
      await p.joinAndInsert((await a.collab.invite(R, "read-write")).link.reveal(), file, 3);
    }
    for (const [p, file] of [
      [b, "B.md"],
      [c, "C.md"],
    ] as const)
      await waitFor(async () =>
        (await passed(p, file)).includes("- [ ] Beta") ? true : undefined,
      );
    const members = async () =>
      (await a.collab.status(R)).participants
        .filter((x) => x.invitation === undefined)
        .map((x) => x.principal)
        .sort();
    const everyone = [hex(a.principal), hex(b.principal), hex(c.principal)].sort();
    await waitFor(async () =>
      JSON.stringify(await members()) === JSON.stringify(everyone) ? true : undefined,
    );
    const accessOf = async (p: Peer) => {
      const s = await p.runtime.sectionAccessState(R);
      return { allowed: s.allowed, abilities: [...s.abilities].sort() };
    };
    const bAccess = await accessOf(b);
    const cAccess = await accessOf(c);
    expect(bAccess.allowed).toBe(true);
    expect(bAccess.abilities).toContain("data/write");

    // B detaches its copy, with the cursor in it, through the executor (the pane's handler).
    const bNote = b.files.get("B.md") as string;
    const B = actionsOf(b, server.url);
    await B.actions.detachSectionAt({
      path: "B.md",
      text: bNote,
      mode: "source",
      cursorLine: bNote.split("\n").findIndex((l) => l.includes("- [ ] Alpha")),
      selections: [],
      composing: false,
    });
    expect(B.asked.confirms).toEqual([
      { title: 'Detach "Plan" in this note', message: DETACH_CONFIRMATION, action: "Detach" },
    ]);
    const detached = b.files.get("B.md") as string;
    expect(detached).not.toContain("lfcp-");
    expect(detached).toContain("- [ ] Alpha");
    expect(await new KeyValueSectionBaseStore(b.runtime.localState).projectionsOf("B.md")).toEqual(
      [],
    );
    // Nobody's access changed: A's list, B's and C's own.
    expect(await members()).toEqual(everyone);
    expect(await accessOf(b)).toEqual(bAccess);
    expect(await accessOf(c)).toEqual(cAccess);

    // A edits: C's copy updates; B's detached note does not, though B still receives (a member).
    a.files.set(
      "Plan.md",
      (a.files.get("Plan.md") as string).replace("Alpha", "Alpha after detach"),
    );
    await a.pass("Plan.md");
    await waitFor(async () =>
      (await passed(c, "C.md")).includes("Alpha after detach") ? true : undefined,
    );
    await waitFor(async () => ((await holds(b, R, "Alpha after detach")) ? true : undefined));
    expect(await passed(b, "B.md")).toBe(detached);

    // A removes C's access through the card: its confirmation, then the revocation.
    const A = actionsOf(a, server.url);
    await A.actions.openCard(`${a.b64(R)}#${await sectionIdOf(a, R)}`, "Plan");
    expect(A.asked.rows?.remove).toBeDefined();
    A.asked.rows?.remove?.(hex(c.principal), "Member c");
    await waitFor(async () => (A.asked.notices.length > 0 ? true : undefined));
    expect(A.asked.confirms.at(-1)?.title).toBe("Remove access: Member c");
    expect(A.asked.notices[0]).toMatch(
      /^Shared Tasks: Removing access: waiting for the server\. It is not done yet\./,
    );
    await waitFor(async () => ((await accessOf(c)).allowed ? undefined : true), 30_000);
    await waitFor(async () =>
      JSON.stringify(await members()) ===
      JSON.stringify([hex(a.principal), hex(b.principal)].sort())
        ? true
        : undefined,
    );
    // B keeps its access; C keeps its copy.
    expect(await accessOf(b)).toEqual(bAccess);
    const cNote = await passed(c, "C.md");
    expect(cNote).toContain("Alpha after detach");

    // A edits again: B receives it, C does not.
    a.files.set(
      "Plan.md",
      (a.files.get("Plan.md") as string).replace("Beta", "Beta after removal"),
    );
    await a.pass("Plan.md");
    await waitFor(async () => ((await holds(b, R, "Beta after removal")) ? true : undefined));
    await new Promise((r) => setTimeout(r, 1500));
    expect(await holds(c, R, "Beta after removal")).toBe(false);
    expect(await passed(c, "C.md")).not.toContain("Beta after removal");
  }, 180_000);
});

/** The section ID of `R` as `p`'s replica holds it. */
async function sectionIdOf(p: Peer, R: ResourceId): Promise<string> {
  return waitFor(async () => {
    const doc = p.runtime.sectionProfile(R)?.replica.toJSON() as
      | { section?: { id?: unknown } }
      | undefined;
    return typeof doc?.section?.id === "string" ? doc.section.id : undefined;
  });
}
