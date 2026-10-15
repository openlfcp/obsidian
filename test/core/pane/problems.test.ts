// LFCP-03-018 (U03-06, U03-16, U03-25; F-04, F-05): the pane's problem hub.
// Each problem category is one row with its reason, its source and the one
// action that leads to its resolver: a conflict by its RecoveryItem.key, a
// repair by its line key with the note's revision, held edits by their
// place. No row offers a destructive action or a "fix all", and a row is
// gone only when the facts no longer have it.

import { describe, expect, it } from "vitest";
import { ACTIONS } from "../../../src/core/actions/catalog";
import { hostPane } from "../../../src/core/pane/host-facts";
import { paneModel, paneTexts } from "../../../src/core/pane/model";
import { paneProblems } from "../../../src/core/pane/problems";
import { contentHash } from "../../../src/core/projection/guard";
import {
  formatBoundary,
  parseSectionRef,
  type SectionRef,
} from "../../../src/core/sections/grammar";
import type { RecoveryItem } from "../../../src/core/sections/recovery";
import { keyedRepairs } from "../../../src/core/sections/repair";
import type { TargetCapture } from "../../../src/core/sections/target";
import type { HeldEdits } from "../../../src/core/status/held";
import { type StatusFacts, type StatusView, statusView } from "../../../src/core/status/reducer";

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const SID = "019a2f85-7b31-7c42-b85a-fc843e2f4001";
const S = parseSectionRef(`lfcp1:${R0}#section:${SID}`) as SectionRef;
const KEY = `${R0}#${SID}`;
const S2 = parseSectionRef(
  `lfcp1:${R0}#section:019a2f85-7b31-7c42-b85a-fc843e2f4002`,
) as SectionRef;
const HEALTHY = [
  "# Plan",
  "## Launch",
  formatBoundary("start", S),
  "- [ ] Alpha",
  formatBoundary("end", S),
  "",
].join("\n");
/** The end marker lost: the section has a start and no end. */
const NO_END = [
  "# Plan",
  "## Launch",
  formatBoundary("start", S),
  "- [ ] Alpha",
  "",
  "## Other",
  "",
].join("\n");
/** A heading inside the section: content it cannot share. */
const HEADING_INSIDE = [
  "# Plan",
  "## Launch",
  formatBoundary("start", S),
  "- [ ] Alpha",
  "### Inside",
  formatBoundary("end", S),
  "",
].join("\n");

const base: StatusFacts = {
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
const view = (over: Partial<StatusFacts> = {}): StatusView => statusView({ ...base, ...over });

const held = (over: Partial<HeldEdits> & Pick<HeldEdits, "cause">): HeldEdits => ({
  path: "Other.md",
  projectionId: "p1",
  count: 2,
  line: 4,
  nodeIds: [],
  ...over,
});
/** A section whose one copy holds edits for `h.cause`. */
const heldView = (h: HeldEdits, over: Partial<StatusFacts> = {}): StatusView =>
  view({
    projections: [
      {
        id: h.projectionId,
        source:
          h.cause === "boundary" || h.cause === "binding"
            ? "binding-error"
            : h.cause === "unsupported"
              ? "unsupported"
              : h.cause === "base-unknown"
                ? "base-unknown"
                : "clean",
        application: "blocked",
        held: h,
      },
    ],
    ...over,
  });

const repairsOf = (path: string, text: string) => ({
  path,
  revision: contentHash(text),
  items: keyedRepairs(text),
});

const CONFLICTS: RecoveryItem[] = [
  {
    kind: "field",
    key: "field:n1:status",
    nodeId: "n1",
    label: 'Task "Alpha"',
    field: "status",
    values: ["todo", "done"],
  },
  { kind: "stale-work", key: "stale:op-1", operationId: "op-1", label: 'Task "Beta"' },
];

describe("problem hub rows (LFCP-03-018)", () => {
  it("a conflict: one row per RecoveryItem, keyed by its key, to the review on that item", () => {
    const rows = paneProblems({ view: view(), recovery: CONFLICTS, repairs: null });
    expect(rows).toEqual([
      {
        id: "conflict:field:n1:status",
        category: "conflict",
        text: 'The status of Task "Alpha" was changed in two ways.',
        source: "The shared section",
        action: "review-conflicts",
        ref: { kind: "conflict", key: "field:n1:status" },
      },
      {
        id: "conflict:stale:op-1",
        category: "conflict",
        text: 'An offline edit could not be sent after an access change: Task "Beta".',
        source: "Kept on this device",
        action: "review-conflicts",
        ref: { kind: "conflict", key: "stale:op-1" },
      },
    ]);
  });

  it("a damaged boundary in the note in view: its line key and revision, to the repair", () => {
    const rows = paneProblems({ view: null, recovery: [], repairs: repairsOf("Plan.md", NO_END) });
    expect(rows).toEqual([
      {
        id: `repair:Plan.md:missing-end:${KEY}:2`,
        category: "boundary",
        text: "A shared section has a start marker and no end.",
        source: "Plan.md, line 3",
        action: "repair-sections",
        ref: {
          kind: "repair",
          path: "Plan.md",
          key: `missing-end:${KEY}`,
          line: 2,
          revision: contentHash(NO_END),
        },
      },
    ]);
  });

  it("unsupported content in the note in view: its reason and line, to the line (never a write)", () => {
    const rows = paneProblems({
      view: null,
      recovery: [],
      repairs: repairsOf("Plan.md", HEADING_INSIDE),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: "unsupported",
      text: "This content cannot be shared by this version yet: edit it, or end the section before it.",
      source: "Plan.md, line 5",
      action: "go-to-problem",
      ref: { kind: "repair", path: "Plan.md", line: 4, revision: contentHash(HEADING_INSIDE) },
    });
  });

  it("held edits in another note: the count, the cause and the source, to their resolver", () => {
    const cases: [HeldEdits["cause"], string, string][] = [
      ["boundary", "boundary", "repair-sections"],
      ["binding", "binding", "repair-sections"],
      ["base-unknown", "base", "repair-sections"],
      ["unsupported", "unsupported", "go-to-problem"],
      ["read-only", "read-only", "review-local-changes"],
      ["revoked", "access", "review-local-changes"],
      ["refused", "access", "review-local-changes"],
      ["rejected", "held", "review-local-changes"],
    ];
    for (const [cause, category, action] of cases) {
      const h = held({ cause });
      const rows = paneProblems({ view: heldView(h), recovery: [], repairs: null });
      const row = rows.find((r) => r.id.startsWith("held:"));
      expect(row, cause).toMatchObject({
        category,
        source: "Other.md, line 5",
        action,
        ref: { kind: "at", path: "Other.md", line: 4 },
      });
      expect(row?.text, cause).toMatch(/^2 edits not sent: /);
    }
  });

  it("uncounted held edits say so without a number (U03-25)", () => {
    const h = held({ cause: "base-unknown", count: null });
    const [row] = paneProblems({ view: heldView(h), recovery: [], repairs: null });
    expect(row?.text).toBe(
      "Edits not sent: this copy has to be compared with the shared version first.",
    );
  });

  it("a held copy in the note in view is shown by that note's repair rows, line by line, not twice", () => {
    const h = held({ cause: "boundary", path: "Plan.md", line: 2 });
    const rows = paneProblems({
      view: heldView(h),
      recovery: [],
      repairs: repairsOf("Plan.md", NO_END),
    });
    expect(rows.map((r) => r.id)).toEqual([`repair:Plan.md:missing-end:${KEY}:2`]);
    // Held in another note, the row for that copy stays, beside this note's.
    const other = paneProblems({
      view: heldView({ ...h, path: "Other.md" }),
      recovery: [],
      repairs: repairsOf("Plan.md", NO_END),
    });
    expect(other.map((r) => r.id)).toEqual([
      "held:p1:boundary",
      `repair:Plan.md:missing-end:${KEY}:2`,
    ]);
  });

  it("F3: revoked, not-member, refused and the server's refusal are distinct rows with their source", () => {
    const text = (over: Partial<StatusFacts>) =>
      paneProblems({ view: view(over), recovery: [], repairs: null }).map((r) => [
        r.text,
        r.source,
        r.action,
      ]);
    expect(text({ access: "revoked", accessCurrent: false })).toEqual([
      [
        "Your access to this section was removed. Your local copy stays.",
        "This vault's access, as this device last verified it",
        "open-details",
      ],
    ]);
    expect(text({ access: "not-member", accessCurrent: false })).toEqual([
      [
        "This vault is not a member of this section.",
        "This vault's access, as this device last verified it",
        "open-details",
      ],
    ]);
    expect(text({ access: "refused" })).toEqual([
      [
        "The sync server no longer accepts changes from this vault for this section.",
        "The sync server",
        "open-details",
      ],
    ]);
    expect(text({ refusal: "RESOURCE_NOT_HOSTED" })[0]?.[1]).toBe("The sync server");
  });

  it("held edits this vault may not send lead to its local changes, not to a repair", () => {
    const h = held({ cause: "revoked" });
    const rows = paneProblems({
      view: heldView(h, { access: "revoked", accessCurrent: false }),
      recovery: [],
      repairs: null,
    });
    expect(rows.map((r) => [r.category, r.action])).toEqual([
      ["access", "review-local-changes"],
      ["access", "review-local-changes"],
    ]);
  });

  it("a stable order: access, held, repairs, unsupported, then conflicts", () => {
    const h = held({ cause: "read-only" });
    // A section with a heading inside, then one without its end.
    const TWO = `${HEADING_INSIDE}${NO_END.replace("# Plan\n", "").replaceAll(
      formatBoundary("start", S),
      formatBoundary("start", S2),
    )}`;
    const rows = paneProblems({
      view: heldView(h, { access: "refused" }),
      recovery: CONFLICTS,
      repairs: repairsOf("Plan.md", TWO),
    });
    expect(rows.map((r) => r.category)).toEqual([
      "access",
      "read-only",
      ...rows.slice(2, -2).map((r) => r.category),
      "conflict",
      "conflict",
    ]);
    const local = rows.slice(2, -2).map((r) => r.category);
    // The section without its end comes later in the note, its boundary row first all the same.
    expect(local).toEqual(["boundary", "unsupported"]);
    // The same facts give the same rows, in the same order.
    expect(
      paneProblems({
        view: heldView(h, { access: "refused" }),
        recovery: CONFLICTS,
        repairs: repairsOf("Plan.md", TWO),
      }),
    ).toEqual(rows);
  });

  it("no destructive action and no fix-all: every row has at most one resolver of its own", () => {
    const h = held({ cause: "refused" });
    const rows = paneProblems({
      view: heldView(h, { access: "refused" }),
      recovery: CONFLICTS,
      repairs: repairsOf("Plan.md", NO_END),
    });
    for (const r of rows) {
      expect(r.action === null || !ACTIONS[r.action].destructive, r.id).toBe(true);
      expect(r.action).not.toBe("discard-local-copy");
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("a healthy section in a healthy note has no problem row", () => {
    expect(
      paneProblems({ view: view(), recovery: [], repairs: repairsOf("Plan.md", HEALTHY) }),
    ).toEqual([]);
  });
});

describe("problem hub in the pane (LFCP-03-018)", () => {
  const note = (text: string, over: Partial<TargetCapture> = {}): TargetCapture => ({
    path: "Plan.md",
    text,
    mode: "source",
    cursorLine: 3,
    selections: [],
    composing: false,
    ...over,
  });

  it("the pane lists the rows with their source and resolver, and hands each its own request", () => {
    const d = hostPane({
      note: note(HEALTHY),
      registry: null,
      status: (k) => (k === KEY ? view() : undefined),
      recovery: (k) => (k === KEY ? CONFLICTS : []),
    });
    const m = paneModel(d.facts);
    expect(m.problems.map((p) => [p.text, p.source, p.action?.label, p.action?.enabled])).toEqual([
      [
        'The status of Task "Alpha" was changed in two ways.',
        "The shared section",
        "Review conflicts…",
        true,
      ],
      [
        'An offline edit could not be sent after an access change: Task "Beta".',
        "Kept on this device",
        "Review conflicts…",
        true,
      ],
    ]);
    expect(paneTexts(m)).toContain("The shared section");
    expect(d.problemRequest("conflict:stale:op-1")).toEqual({
      section: { key: KEY, title: "Launch" },
      problem: { kind: "conflict", key: "stale:op-1" },
    });
    expect(d.problemRequest("conflict:gone")).toBeNull();
  });

  it("a repair row hands its line key and the revision the pane read", () => {
    const d = hostPane({ note: note(NO_END), registry: null, status: () => undefined });
    const [p] = d.facts.problems ?? [];
    expect(p).toBeDefined();
    expect(d.problemRequest(p?.id ?? "")).toEqual({
      problem: {
        kind: "repair",
        path: "Plan.md",
        key: `missing-end:${KEY}`,
        line: 2,
        revision: contentHash(NO_END),
      },
      section: { key: KEY, title: "Launch" },
    });
  });

  it("held edits hand their place; a section not computed yet claims no problem", () => {
    const h = held({ cause: "unsupported" });
    const d = hostPane({
      note: note(HEALTHY),
      registry: null,
      status: (k) => (k === KEY ? heldView(h) : undefined),
    });
    expect(d.problemRequest("held:p1:unsupported")).toEqual({
      section: { key: KEY, title: "Launch" },
      at: { path: "Other.md", line: 4 },
    });
    const unknown = hostPane({ note: note(HEALTHY), registry: null, status: () => undefined });
    expect(unknown.facts.problems).toBeUndefined();
  });

  it("T4: in Reading view a repair of that note is disabled with its reason; elsewhere it is not", () => {
    const reading = paneModel(
      hostPane({ note: note(NO_END, { mode: "reading" }), registry: null, status: () => undefined })
        .facts,
    );
    expect(reading.problems[0]?.action).toMatchObject({
      id: "repair-sections",
      enabled: false,
      reason: "Open the note for editing to repair it.",
    });
  });

  it("the host guard disables every row's action, with its reason", () => {
    const d = hostPane({
      note: note(NO_END),
      registry: null,
      status: () => undefined,
      host: { unavailable: null, starting: true, readOnly: false, server: true },
    });
    expect(paneModel(d.facts).problems[0]?.action).toMatchObject({
      enabled: false,
      reason: "Shared Tasks is still starting.",
    });
  });

  it("a row stays until the facts drop it: the same facts after a click draw the same rows", () => {
    let items = CONFLICTS;
    const draw = () =>
      paneModel(
        hostPane({
          note: note(HEALTHY),
          registry: null,
          status: (k) => (k === KEY ? view() : undefined),
          recovery: () => items,
        }).facts,
      ).problems.map((p) => p.id);
    const before = draw();
    // Nothing in the model hides a row on its own: only new facts do.
    expect(draw()).toEqual(before);
    items = CONFLICTS.slice(1);
    expect(draw()).toEqual(["conflict:stale:op-1"]);
  });
});
