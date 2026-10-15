// LFCP-03-012 (U03-01): the pane's facts from the real host, before 013
// wires flows and CTAs. No note: the join entry and "Open a note…"; a
// private heading: Share section…; the cursor in a shared section: that
// section, by its key, with its status from the one status path or, before
// its first, the reducer's "no evidence" view (never healthy, never a
// denial); the registry's rows as the list. A pane button hands the
// dispatcher the note captured now and the section it is about. An action
// this host cannot run is off with its reason, never a dead button.

import { describe, expect, it } from "vitest";
import {
  hostPane,
  hostPaneFacts,
  hostPaneRequest,
  type PaneAccess,
  SECTIONS_OFF,
  unknownStatus,
  wiredModel,
} from "../../../src/core/pane/host-facts";
import { paneModel, paneTexts } from "../../../src/core/pane/model";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import type { RegistrySnapshot } from "../../../src/core/sections/registry-view";
import type { TargetCapture } from "../../../src/core/sections/target";
import { headingBadge } from "../../../src/core/status/badge";
import { rightsFact, sectionCard } from "../../../src/core/status/card";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const S = parseSectionRef(`lfcp1:${R0}#section:${SID}`) as SectionRef;
const KEY = `${R0}#${SID}`;
const TEXT = [
  "# Plan",
  "Private text.",
  "## Launch",
  formatBoundary("start", S),
  "- [ ] Alpha",
  formatBoundary("end", S),
  "",
].join("\n");

const note = (cursorLine: number, over: Partial<TargetCapture> = {}): TargetCapture => ({
  path: "Plan.md",
  text: TEXT,
  mode: "source",
  cursorLine,
  selections: [],
  composing: false,
  ...over,
});

const registry = (over: Partial<RegistrySnapshot> = {}): RegistrySnapshot => ({
  version: 1,
  status: "ready",
  error: null,
  placementIndex: "complete",
  rows: [
    {
      resource: R0,
      sectionId: SID,
      key: KEY,
      sharedTitle: "Launch",
      localAlias: "Work launch",
      registryState: "available",
      refusal: null,
      status: {
        watched: true,
        state: "CURRENT",
        label: "No pending local changes; current as last checked",
      },
      placements: [{ path: "Plan.md" } as never],
      placementCount: 1,
      placed: "placed",
    },
  ],
  sections: 1,
  unplaced: 0,
  ...over,
});

const currentFacts: StatusFacts = {
  session: "s",
  revision: 1,
  replica: "loaded",
  access: "writer",
  accessVerifiedAt: 1,
  accessCurrent: true,
  pendingControl: [],
  connection: "connected",
  catchUp: "current-at-checkpoint",
  problems: [],
  batches: [],
  acceptanceEvidence: "available",
  projections: [],
};
const current = statusView(currentFacts);

describe("pane host facts (LFCP-03-012)", () => {
  it("no note open: the join entry, the registry list, and no invented context", () => {
    const m = paneModel(
      hostPaneFacts({ note: null, registry: registry(), status: () => undefined }),
    );
    expect(m.join).toMatchObject({ label: "Join with a link…", enabled: true });
    expect(m.context.heading).toBe("No note open");
    expect(m.primary).toBeNull();
    expect(m.primaryNone).toBe("Open a note to share from it, or join with a link.");
    expect(m.sections.summary).toBe("1 shared section on this device");
    expect(m.sections.groups.map((g) => g.rows.map((r) => r.label))).toEqual([["Launch"]]);
    expect(m.status).toEqual([]);
  });

  it("a private heading under the cursor offers Share section…; private text does not", () => {
    const heading = paneModel(
      hostPaneFacts({ note: note(0), registry: registry(), status: () => undefined }),
    );
    expect(heading.primary?.id).toBe("share-section");
    const text = hostPaneFacts({ note: note(1), registry: registry(), status: () => undefined });
    expect(text.context.cursor).toBe("private-text");
  });

  it("the cursor in a shared section: that section by its key, with its own status", () => {
    const f = hostPaneFacts({
      note: note(4),
      registry: registry(),
      status: (k) => (k === KEY ? current : undefined),
    });
    expect(f.context.cursor).toBe("inside-section");
    expect(f.section).toMatchObject({
      key: KEY,
      sharedTitle: "Launch",
      localAlias: "Work launch",
      placements: 1,
      canInvite: null,
    });
    expect(f.section?.view).toBe(current);
    const m = paneModel(f);
    expect(m.context.lines).toContain("On this device: Work launch");
    // No access list read: inviting waits, it is never granted by default.
    expect(m.secondary.find((a) => a.id === "invite")).toMatchObject({ enabled: false });
  });

  it("canInvite comes from the access list; unknown is neither a grant nor a denial (M3)", () => {
    const invite = (access?: PaneAccess, view = current) =>
      paneModel(
        hostPaneFacts({
          note: note(4),
          registry: registry(),
          status: () => view,
          ...(access === undefined ? {} : { access: () => access }),
        }),
      );
    const allowed = invite({ canInvite: true, hosting: "hosted" });
    expect(allowed.primary).toMatchObject({ id: "invite", enabled: true, reason: null });
    const all = (m: ReturnType<typeof paneModel>) => [
      ...(m.primary === null ? [] : [m.primary]),
      ...m.secondary,
    ];
    const not = all(invite({ canInvite: false, hosting: "hosted" })).find((a) => a.id === "invite");
    expect(not).toMatchObject({
      enabled: false,
      reason: "You can't invite others to this section.",
    });
    const waits = "Inviting waits until this device has checked access with the server.";
    for (const unknown of [undefined, { canInvite: null, hosting: "unknown" } as const])
      expect(all(invite(unknown)).find((a) => a.id === "invite")).toMatchObject({
        enabled: false,
        reason: waits,
      });
    // I4: a local-only share is not an invitation that is ready.
    expect(
      all(invite({ canInvite: true, hosting: "pending" })).find((a) => a.id === "invite"),
    ).toMatchObject({
      enabled: false,
      reason: "Not on its server yet: nobody can join until it is hosted.",
    });
    // The chain may still grant what the server no longer accepts: never invite then.
    const refused = statusView({ ...currentFacts, access: "refused" });
    expect(
      all(invite({ canInvite: true, hosting: "hosted" }, refused)).find((a) => a.id === "invite"),
    ).toMatchObject({ enabled: false });
  });

  it("LFCP-03-019: access freshness, rights and Remove access are the card's, from the access list", () => {
    const facts = (access?: PaneAccess, view = current) =>
      hostPaneFacts({
        note: note(4),
        registry: registry(),
        status: () => view,
        ...(access === undefined ? {} : { access: () => access }),
      });
    const freshness = "Access verified with the server at 14:02:00.";
    const read = facts({
      canInvite: true,
      hosting: "hosted",
      canRemove: true,
      removeNote: null,
      freshness,
    });
    const m = paneModel(read);
    const texts = m.status.map((l) => l.text);
    const card = sectionCard({ title: "Launch", view: current, resource: "R", sectionId: "S" });
    // The rights sentence is the card's, and so is the freshness of the list once read.
    expect(texts).toContain(rightsFact(current));
    expect(card.facts).toContain(rightsFact(current));
    expect(texts).toContain(freshness);
    expect(m.menu.find((a) => a.id === "remove-access")).toMatchObject({ enabled: true });
    // Removing waits as the card says it; nobody to remove: not offered at all.
    const waits =
      "Removing access waits until this device's earlier access change is recorded by the server.";
    const pending = paneModel(
      facts({ canInvite: true, hosting: "hosted", canRemove: true, removeNote: waits }),
    );
    expect(pending.menu.find((a) => a.id === "remove-access")).toMatchObject({
      enabled: false,
      reason: waits,
    });
    const nobody = paneModel(facts({ canInvite: true, hosting: "hosted", canRemove: false }));
    expect(nobody.menu.find((a) => a.id === "remove-access")).toBeUndefined();
    // Not read yet: neither offered as done nor hidden as denied.
    expect(paneModel(facts()).menu.find((a) => a.id === "remove-access")).toMatchObject({
      enabled: false,
      reason: "Removing access waits until this device has checked access with the server.",
    });
    // A reader is told so on both surfaces, in the same words.
    const reader = statusView({ ...currentFacts, access: "reader" });
    expect(paneModel(facts(undefined, reader)).status.map((l) => l.text)).toContain(
      "You can read this section, not edit it.",
    );
  });

  it("N3: before its shared title loads a section is named by its alias, with the qualifier", () => {
    const rows = registry().rows.map((r) => ({ ...r, sharedTitle: null, localAlias: "Work" }));
    const m = paneModel(
      hostPaneFacts({ note: note(4), registry: registry({ rows }), status: () => current }),
    );
    expect(m.context.lines).toContain("Work (name on this device)");
    // No row yet (the registry not read): the heading in this note names it.
    const bare = hostPaneFacts({
      note: note(4),
      registry: registry({ rows: [] }),
      status: () => undefined,
    });
    expect(bare.section?.sharedTitle).toBe("Launch");
  });

  it("P2: other flows are listed with where they stand; Continue goes to the first of them", () => {
    const flow = (generation: number, path: string, outcome: "running" | "unknown") => ({
      generation,
      kind: "insert" as const,
      path,
      stage: "",
      step: "preview",
      outcome,
      checking: false,
    });
    const d = hostPane({
      note: note(1),
      registry: registry(),
      status: () => current,
      flows: [flow(2, "Plan.md", "running"), flow(5, "Other.md", "unknown")],
      pinned: 2,
    });
    expect(d.pinned).toBe(2);
    const m = paneModel(d.facts);
    expect(m.unfinished).toEqual([
      {
        title: "Inserting a shared section",
        detail: "Other.md: its result is not known yet; Continue checks it",
      },
    ]);
    expect(d.request("continue-flow")).toEqual({ flow: 5 });
    // The pinned flow's next step goes back to it.
    expect(d.request("insert-into-note")).toEqual({ flow: 2 });
    expect(d.identity("insert-into-note")).not.toBe(d.identity("open-details"));
  });

  it("a section with no status yet is the reducer's no-evidence view: never healthy or denied", () => {
    const f = hostPaneFacts({
      note: note(4),
      registry: registry({ rows: [] }),
      status: () => undefined,
    });
    const v = f.section?.view;
    expect(v?.state).toBe("LOADING");
    expect(v?.access.access).toBe("unknown");
    expect(v?.sync.current).toBe(false);
    expect(unknownStatus().state).toBe("LOADING");
    // Its heading in the note names it until the model is open here.
    expect(f.section?.sharedTitle).toBe("Launch");
  });

  it("M2: no evidence is said as not checked yet, the same on the pane, the card and the badge", () => {
    const f = hostPaneFacts({
      note: note(4),
      registry: registry({ rows: [] }),
      status: () => undefined,
    });
    const view = f.section?.view ?? unknownStatus();
    const pane = paneTexts(paneModel(f));
    const card = sectionCard({ title: "Launch", view, resource: R0, sectionId: SID });
    const badge = headingBadge("Launch", view);
    const said = "Not checked with the server yet. Local updates wait on this device.";
    expect(pane).toContain(said);
    expect(card.facts).toContain(said);
    for (const t of [...pane, ...card.facts, card.status, badge.tooltip, badge.accessibleName])
      expect(t, t).not.toMatch(/offline/i);
    // Loaded, access known, no session yet: the label says it, not "Offline".
    const quiet = statusView({
      session: "s",
      revision: 1,
      replica: "loaded",
      access: "writer",
      pendingControl: [],
      connection: "offline",
      connectionQualifier: "no-evidence",
      catchUp: "not-started",
      problems: [],
      batches: [],
      acceptanceEvidence: "available",
      projections: [],
    });
    expect(quiet.label).toBe("Not checked with the server yet; local updates will wait");
    expect(headingBadge("Launch", quiet).accessibleName).not.toMatch(/offline/i);
    expect(sectionCard({ title: "L", view: quiet, resource: R0, sectionId: SID }).facts).toContain(
      said,
    );
  });

  it("a selection is the executor's own scope rule: exact or refused, never widened", () => {
    const exact = hostPaneFacts({
      note: note(1, {
        cursorLine: 1,
        selections: [{ anchor: { line: 0, ch: 0 }, head: { line: 1, ch: 13 } }],
      }),
      registry: registry(),
      status: () => undefined,
    });
    expect(exact.context.selection).toMatchObject({ eligibility: "exact", fromLine: 1, toLine: 2 });
    const partial = hostPaneFacts({
      note: note(1, { selections: [{ anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 4 } }] }),
      registry: registry(),
      status: () => undefined,
    });
    expect(partial.context.selection).toMatchObject({ eligibility: "ineligible" });
  });

  it("the registry before its first read and while sections are off claims nothing", () => {
    const loading = paneModel(
      hostPaneFacts({
        note: null,
        registry: registry({ status: "loading", rows: [], sections: null, unplaced: null }),
        status: () => undefined,
      }),
    );
    expect(loading.sections.summary).toBe("Reading the shared sections on this device…");
    const off = paneModel(hostPaneFacts({ note: null, registry: null, status: () => undefined }));
    expect(off.sections).toEqual({ summary: null, groups: [] });
  });

  it("a button hands the dispatcher the note captured now and the section it is about", () => {
    const src = (n: TargetCapture | null) => ({
      note: n,
      registry: registry(),
      status: () => undefined,
    });
    expect(hostPaneRequest(src(null))).toEqual({});
    const n = note(4);
    expect(hostPaneRequest(src(n))).toEqual({
      target: n,
      section: { key: KEY, title: "Launch" },
    });
    expect(hostPaneRequest(src(note(0)))).toEqual({ target: note(0) });
  });

  it("with shared sections off, every button but joining is off with that reason; nothing else changes", () => {
    const m = paneModel(
      hostPaneFacts({ note: note(4), registry: registry(), status: () => current }),
    );
    const wired = wiredModel(m, (id) => id === "join-with-link");
    for (const a of [...wired.secondary, ...wired.menu, ...(wired.primary ? [wired.primary] : [])])
      if (a.id !== "join-with-link")
        expect(a).toMatchObject({ enabled: false, reason: expect.any(String) });
    expect(wired.join.enabled).toBe(true);
    expect(paneTexts(wired)).toContain(SECTIONS_OFF);
    expect(paneTexts(wired).join("\n")).not.toMatch(/not available in the pane/i);
    expect(wiredModel(m, () => true)).toEqual(m);
  });

  it("claims no OS link handler and starts no wizard (U03-01)", () => {
    const texts = [null, note(0), note(4)].flatMap((n) =>
      paneTexts(paneModel(hostPaneFacts({ note: n, registry: registry(), status: () => current }))),
    );
    expect(texts.join("\n")).not.toMatch(
      /protocol|click the link|opens? (the )?link|wizard|setup/i,
    );
  });
});
