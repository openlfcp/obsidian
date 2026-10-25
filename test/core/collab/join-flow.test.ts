// LFCP-03-015 (U03-10, U03-11): the join flow the pane follows, over a
// scripted collaboration. The explicit Join, the stages confirmed by their
// facts (claim, access, model loaded), a section already held reached
// without a new claim, each error by its real cause, a lost claim checked
// from its journal and never sent again, the one lock shared with the
// palette, and no link or secret anywhere in the state.

import { fromBase64url, type ResourceId, toHex } from "@openlfcp/core";
import { PROFILE_ID } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { describe, expect, it } from "vitest";
import {
  JOIN_TEXT,
  type JoinCollab,
  JoinFlow,
  type JoinFlowState,
} from "../../../src/core/collab/join-flow";
import {
  ALREADY_HELD,
  ALREADY_HELD_LEGACY,
  LEGACY_LINK_FOR_SECTION,
  REMOVED_REJOIN,
} from "../../../src/core/collab/messages";
import type { JoinOutcome, JoinStage } from "../../../src/core/collab/service";

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const R = fromBase64url(R0) as ResourceId;
/** A §18.2 invite-secret's shape (CBOR {0: 1, 1: 32 bytes, 2: 32 bytes}); no real key. */
const SECRET = Buffer.from([
  0xa3,
  0x00,
  0x01,
  0x01,
  0x58,
  0x20,
  ...new Array(32).fill(7),
  0x02,
  0x58,
  0x20,
  ...new Array(32).fill(9),
]).toString("base64url");
/** A syntactically whole bearer link (parseInviteUri accepts it); never a real grant. */
const LINK = `lfcp://join/${R0}?endpoint=ws%3A%2F%2F127.0.0.1%3A9&grant=${R0}#secret=${SECRET}`;

type Step = { stages: JoinStage[]; outcome: JoinOutcome } | { throws: Error };

/** A collaboration whose join answers as scripted, and records what it was asked. */
function scripted(steps: Step[], resume: Awaited<ReturnType<JoinCollab["resumeJoin"]>>[] = []) {
  const calls = {
    join: [] as { link: string; name: string; accept?: string }[],
    resume: 0,
    abandon: 0,
  };
  let profile: string | null = null;
  const collab: JoinCollab = {
    join: async (link, o) => {
      calls.join.push({
        link,
        name: o.name,
        ...(o.accept === undefined ? {} : { accept: o.accept }),
      });
      const step = steps.shift();
      if (step === undefined) throw new Error("no scripted join");
      if ("throws" in step) throw step.throws;
      for (const s of step.stages) o.onStage?.(s);
      return step.outcome;
    },
    list: async () =>
      profile === null
        ? []
        : [
            {
              resourceId: R,
              localName: null,
              profile,
              routes: [],
              lastKnownControlHead: null,
              state: "available",
              refusal: null,
            },
          ],
    resumeJoin: async () => {
      calls.resume++;
      const r = resume.shift();
      if (r === undefined) throw new Error("no scripted resume");
      return r;
    },
    abandonJoin: async () => {
      calls.abandon++;
    },
  };
  return {
    collab,
    calls,
    held: (p: string) => {
      profile = p;
    },
  };
}

function flow(c: JoinCollab | null) {
  const notices: string[] = [];
  const joined: string[] = [];
  const seen: (JoinFlowState | null)[] = [];
  const f = new JoinFlow({
    collab: () => c,
    notice: (t) => notices.push(t),
    joined: (r) => joined.push(toHex(r)),
  });
  f.onChange(() => seen.push(f.state()));
  return { f, notices, joined, seen };
}

const CLAIM: JoinStage[] = [
  "connecting",
  "validating invitation",
  "retrieving key",
  "claiming capability",
];
const joinedSection = (loaded = true): Step => ({
  stages: [...CLAIM, "synchronizing", "loading section"],
  outcome: {
    kind: "joined",
    resourceId: R,
    abilities: ["data/read", "data/write"],
    section: { loaded },
  },
});

describe("the join flow (LFCP-03-015)", () => {
  it("opens a field and sends nothing; Join claims; claim → access → load → choose a place, each confirmed", async () => {
    const s = scripted([joinedSection()]);
    const { f, joined, seen } = flow(s.collab);
    f.open();
    expect(f.state()).toMatchObject({ stage: "link", outcome: "running", problem: null });
    expect(s.calls.join).toHaveLength(0);
    await f.submit(LINK);
    expect(s.calls.join).toEqual([{ link: LINK, name: "", accept: "sections" }]);
    const stages = seen.map((x) => x?.stage);
    expect(stages).toContain("claiming capability");
    expect(stages.indexOf("access")).toBeGreaterThan(stages.indexOf("claiming capability"));
    expect(stages.indexOf("loading")).toBeGreaterThan(stages.indexOf("access"));
    // The access stage starts only on the claim's acknowledgement: its fact comes with it.
    expect(seen.find((x) => x?.stage === "access")?.facts).toEqual([JOIN_TEXT.claimed]);
    expect(f.state()).toMatchObject({
      stage: "choose-place",
      outcome: "running",
      resource: R,
      facts: [JOIN_TEXT.claimed, "Access: read and write.", JOIN_TEXT.loaded],
    });
    // D9: the pane is about the section joined.
    expect(joined).toEqual([toHex(R)]);
    // The lock is free again: the claim is done.
    expect(f.busy()).toBe(false);
  });

  it("a section still loading says so; read-only access is told apart", async () => {
    const s = scripted([
      {
        stages: [...CLAIM, "synchronizing", "loading section"],
        outcome: {
          kind: "joined",
          resourceId: R,
          abilities: ["data/read"],
          section: { loaded: false },
        },
      },
    ]);
    const { f } = flow(s.collab);
    f.open();
    await f.submit(LINK, "Ours");
    expect(s.calls.join[0]?.name).toBe("Ours");
    expect(f.state()?.facts).toEqual([JOIN_TEXT.claimed, "Access: read only.", JOIN_TEXT.loading]);
  });

  it("already joined: leads to the section without a new claim", async () => {
    const s = scripted([{ stages: [], outcome: { kind: "already-member", resourceId: R } }]);
    s.held(SECTIONS_PROFILE_ID);
    const { f, joined } = flow(s.collab);
    f.open();
    await f.submit(LINK);
    expect(f.state()).toMatchObject({ stage: "choose-place", facts: [JOIN_TEXT.already] });
    expect(joined).toEqual([toHex(R)]);
    expect(s.calls.resume).toBe(0);
  });

  it("already joined, profile unreadable: neutral words, not the 0.1 ones (LFCP-03-042)", async () => {
    const s = scripted([{ stages: [], outcome: { kind: "already-member", resourceId: R } }]);
    s.collab.list = async () => {
      throw new Error("registry unavailable");
    };
    const { f, notices } = flow(s.collab);
    f.open();
    await f.submit(LINK);
    expect(notices.at(-1)).toBe(`Shared Tasks: ${ALREADY_HELD}`);
  });

  it("already joined, a 0.1 Resource: says what it is and what to ask for (UX-04)", async () => {
    const s = scripted([{ stages: [], outcome: { kind: "already-member", resourceId: R } }]);
    s.held(PROFILE_ID);
    const { f, notices } = flow(s.collab);
    f.open();
    await f.submit(LINK);
    expect(notices.at(-1)).toBe(`Shared Tasks: ${ALREADY_HELD_LEGACY}`);
    expect(ALREADY_HELD_LEGACY).toBe(
      'This device already joined this link, but it is an older task collaboration, not a shared section. Ask the sender for a link from the section\'s "Invite collaborator…".',
    );
  });

  it("a 0.1 link in the pane: refused before the claim, in words, kept in the field (UX-03)", async () => {
    const s = scripted([
      { stages: [], outcome: { kind: "other-profile", resourceId: R, profile: PROFILE_ID } },
    ]);
    const { f } = flow(s.collab);
    f.open();
    await f.submit(LINK);
    expect(s.calls.join[0]?.accept).toBe("sections");
    expect(f.state()).toMatchObject({
      stage: "link",
      outcome: "running",
      problemKind: "other-profile",
      problem: LEGACY_LINK_FOR_SECTION,
    });
    expect(LEGACY_LINK_FOR_SECTION).toBe(
      'This link is for an older task collaboration, not a shared section. Ask the sender for a new link from the section\'s "Invite collaborator…".',
    );
  });

  it("the palette's join takes either kind unless told otherwise", async () => {
    const s = scripted([joinedSection()]);
    const { f } = flow(s.collab);
    await f.run(LINK, { name: "", from: "palette" });
    expect(s.calls.join[0]?.accept).toBe("any");
  });

  it("errors by their real cause, kept in the field until the next Join", async () => {
    const cases: [JoinOutcome, string, string][] = [
      [{ kind: "refused", code: "AUTHORIZATION_FAILED", message: "" }, "used", JOIN_TEXT.used],
      [{ kind: "removed", resourceId: R }, "removed", REMOVED_REJOIN],
      [
        {
          kind: "unavailable",
          message: "Joining needs a connection; try again when online.",
          resourceId: R,
        },
        "offline",
        "Joining needs a connection; try again when online.",
      ],
      [
        { kind: "needs-newer-version", resourceId: R },
        "needs-newer-version",
        "it has not been used",
      ],
      [{ kind: "refused", code: "RATE_LIMITED", message: "" }, "refused", "slow down"],
    ];
    for (const [outcome, kind, text] of cases) {
      const s = scripted([{ stages: CLAIM, outcome }]);
      const { f } = flow(s.collab);
      f.open();
      await f.submit(LINK);
      const st = f.state();
      expect(st, kind).toMatchObject({ stage: "link", outcome: "running", problemKind: kind });
      expect(st?.problem, kind).toContain(text);
      expect(st?.problem ?? "", kind).not.toMatch(/expire/i);
    }
  });

  it("a malformed link is told apart before anything is sent", async () => {
    const s = scripted([]);
    const { f } = flow(s.collab);
    f.open();
    await f.submit("https://example.org/not-a-link");
    expect(f.state()).toMatchObject({
      stage: "link",
      problemKind: "malformed",
      problem: JOIN_TEXT.malformed,
    });
    expect(s.calls.join).toHaveLength(0);
  });

  it("a lost claim stays unknown and is checked from its journal, never sent again", async () => {
    const s = scripted(
      [
        {
          stages: CLAIM,
          outcome: { kind: "unavailable", message: "kept", claimSent: true, resourceId: R },
        },
      ],
      [
        { kind: "unavailable", message: "still unreachable", claimSent: true, resourceId: R },
        {
          kind: "joined",
          resourceId: R,
          abilities: ["data/read", "data/write"],
          section: { loaded: true },
        },
      ],
    );
    const { f, joined } = flow(s.collab);
    f.open();
    await f.submit(LINK);
    const st = f.state() as JoinFlowState;
    expect(st).toMatchObject({ stage: "claiming capability", outcome: "unknown", resource: R });
    // No second join meanwhile, from any surface.
    expect(f.busy()).toBe(true);
    expect(f.hold()).toBeNull();
    f.open();
    expect(f.state()?.outcome).toBe("unknown");
    // A late click drawn for another flow does nothing.
    await f.checkResult(st.generation + 1);
    expect(s.calls.resume).toBe(0);
    await f.checkResult(st.generation);
    expect(f.state()).toMatchObject({ outcome: "unknown", problem: "still unreachable" });
    await f.checkResult(st.generation);
    expect(f.state()).toMatchObject({ stage: "choose-place", outcome: "running" });
    expect(s.calls.join).toHaveLength(1);
    expect(s.calls.resume).toBe(2);
    expect(joined).toEqual([toHex(R)]);
  });

  it("a lost claim that never landed: back to the field, the link still unused", async () => {
    const s = scripted(
      [
        {
          stages: CLAIM,
          outcome: { kind: "unavailable", message: "", claimSent: true, resourceId: R },
        },
      ],
      [{ kind: "not-claimed" }],
    );
    const { f } = flow(s.collab);
    f.open();
    await f.submit(LINK);
    await f.checkResult(f.state()?.generation ?? -1);
    expect(f.state()).toMatchObject({
      stage: "link",
      problemKind: "not-claimed",
      problem: JOIN_TEXT.notClaimed,
    });
  });

  it("Cancel, Later and Give up; an insert started ends a joined flow", async () => {
    const s = scripted([
      joinedSection(),
      {
        stages: CLAIM,
        outcome: { kind: "unavailable", message: "", claimSent: true, resourceId: R },
      },
      joinedSection(),
    ]);
    const { f, notices } = flow(s.collab);
    f.open();
    await f.dismiss(f.state()?.generation ?? -1);
    expect(f.state()).toBeNull();

    f.open();
    await f.submit(LINK);
    await f.dismiss(f.state()?.generation ?? -1);
    expect(f.state()).toBeNull();

    f.open();
    await f.submit(LINK);
    await f.dismiss(f.state()?.generation ?? -1);
    expect(s.calls.abandon).toBe(1);
    expect(f.state()).toBeNull();
    expect(notices.at(-1)).toBe(JOIN_TEXT.stopped);

    f.open();
    await f.submit(LINK);
    expect(f.state()?.stage).toBe("choose-place");
    f.placed();
    expect(f.state()).toBeNull();
  });

  it("one lock with the palette: its open dialog keeps the pane's Join from claiming", async () => {
    const s = scripted([joinedSection()]);
    const { f } = flow(s.collab);
    // The pane's field is open; the palette's dialog takes the lock meanwhile.
    f.open();
    const release = f.hold();
    expect(release).not.toBeNull();
    await f.submit(LINK);
    expect(f.state()).toMatchObject({ problemKind: "busy", problem: JOIN_TEXT.busy });
    expect(s.calls.join).toHaveLength(0);
    release?.();
    await f.submit(LINK);
    expect(f.state()?.stage).toBe("choose-place");
  });

  it("not started yet: says so, claims nothing", async () => {
    const { f } = flow(null);
    f.open();
    await f.submit(LINK);
    expect(f.state()).toMatchObject({ problemKind: "not-ready" });
  });

  it("never holds the link or its secret", async () => {
    const s = scripted([
      { stages: CLAIM, outcome: { kind: "refused", code: "AUTHORIZATION_FAILED", message: "" } },
      { throws: Object.assign(new Error("bad"), { code: "INVALID_INVITATION" }) },
      joinedSection(),
    ]);
    const { f, seen, notices } = flow(s.collab);
    f.open();
    await f.submit(LINK);
    await f.submit(LINK);
    expect(f.state()?.problemKind).toBe("malformed");
    await f.submit(LINK);
    const all = JSON.stringify([seen, notices], (_k, v) =>
      v instanceof Uint8Array ? toHex(v) : v,
    );
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(LINK.slice(0, 40));
  });

  it("a claim a restart left unknown is shown again; Check the result settles it without the link (LFCP-03-017)", async () => {
    const s = scripted(
      [],
      [
        {
          kind: "unavailable",
          message: "The server could not be reached (offline).",
          resourceId: R,
          claimSent: true,
        },
        {
          kind: "joined",
          resourceId: R,
          abilities: ["data/read", "data/write"],
          section: { loaded: true },
        },
      ],
    );
    const { f, joined } = flow(s.collab);
    const generation = f.restore(R, "The server could not be reached.");
    expect(generation).not.toBeNull();
    expect(f.state()).toMatchObject({
      stage: "claiming capability",
      outcome: "unknown",
      problem: "The server could not be reached.",
    });
    // The one join lock is held: no second join starts meanwhile, and no second restore.
    expect(f.busy()).toBe(true);
    expect(f.hold()).toBeNull();
    expect(f.restore(R, "again")).toBeNull();
    // Still unreachable: unknown, with why.
    await f.checkResult(generation ?? -1);
    expect(f.state()).toMatchObject({ outcome: "unknown", checking: false });
    // Reached: the same claim settles; no join was sent.
    await f.checkResult(generation ?? -1);
    expect(f.state()).toMatchObject({ stage: "choose-place", outcome: "running" });
    expect(s.calls.join).toEqual([]);
    expect(s.calls.resume).toBe(2);
    expect(joined).toEqual([toHex(R)]);
  });

  it("a restored claim given up drops its journal and says so", async () => {
    const s = scripted([]);
    const { f, notices } = flow(s.collab);
    const generation = f.restore(R, "offline");
    await f.dismiss(generation ?? -1);
    expect(s.calls.abandon).toBe(1);
    expect(f.state()).toBeNull();
    expect(notices).toEqual([JOIN_TEXT.stopped]);
  });

  it("an insert of another section does not end the join waiting for its place", async () => {
    const s = scripted([joinedSection()]);
    const { f } = flow(s.collab);
    f.open();
    await f.submit(LINK);
    expect(f.state()?.stage).toBe("choose-place");
    f.placed(new Uint8Array(32).fill(1) as ResourceId);
    expect(f.state()?.stage).toBe("choose-place");
    f.placed(R);
    expect(f.state()).toBeNull();
  });
});
