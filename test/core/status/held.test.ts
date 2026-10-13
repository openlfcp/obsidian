// Edits held in a note, not sent (the MVP 0.3 baseline review, F-04): on the
// real section replica, a pass that holds edits back (content the section
// cannot share, a damaged binding, a read-only copy) is counted against the
// base, with its cause and line; the card then never says "No local changes
// waiting." or "Current as last checked", names the cause and the line, and
// the badge is not CURRENT. Plus F-C05: not-member stays distinct from revoked.

import { describe, expect, it } from "vitest";
import { parseSections } from "../../../src/core/sections/parser";
import { sectionCard } from "../../../src/core/status/card";
import { observedFacts } from "../../../src/core/status/facts";
import { type HeldEdits, heldEdits } from "../../../src/core/status/held";
import { type StatusFacts, statusView } from "../../../src/core/status/reducer";
import { lines, twoVaults, type Vault } from "../../support/section-vaults";

const BODY = ["- [ ] Alpha", "", "A paragraph."];

/** A pass of `md` in `v`, and what it holds back, as the host computes it. */
async function held(v: Vault, md: string): Promise<HeldEdits | null> {
  const r = await v.pass(md);
  if (r === undefined) throw new Error("no section");
  const scan = parseSections(md);
  const section = scan.sections[0];
  if (section === undefined) throw new Error("no parsed section");
  const base = (await v.bases.load(r.projectionId))?.state;
  return heldEdits({ path: "Plan.md", markdown: md, scan, section, result: r, base });
}

const facts: StatusFacts = {
  session: "s",
  revision: 1,
  replica: "loaded",
  access: "writer",
  pendingControl: [],
  connection: "connected",
  catchUp: "current-at-checkpoint",
  problems: [],
  batches: [],
  acceptanceEvidence: "available",
  projections: [],
};

/** The card of a section whose only projection holds `h` (its source as the pass left it). */
function cardOf(h: HeldEdits, source: "unsupported" | "binding-error" | "diverged" | "clean") {
  const view = statusView({
    ...facts,
    projections: [{ id: h.projectionId, source, application: "blocked", held: h }],
  });
  return {
    view,
    card: sectionCard({ title: "Plan", view, resource: "BwcH", sectionId: "s1" }),
  };
}

function expectNeverCurrent(c: ReturnType<typeof cardOf>) {
  expect(c.view.state).toBe("ATTENTION");
  expect(c.card.facts).not.toContain("No local changes waiting.");
  expect(c.card.facts.join(" ")).not.toMatch(/Current as last checked/);
  expect(c.card.facts.join(" ")).toMatch(/^.*Not current: the server has not got the edits/m);
}

describe("held edits (F-04)", () => {
  it("a move in a held copy is counted and named: never lost silently (0.4.0-beta.10, step 6)", async () => {
    const { a } = await twoVaults(["- [ ] Alpha", "- [ ] Beta", "- [ ] Gamma", "", "A paragraph."]);
    const L = lines(a.note());
    // Gamma (with its ref line) one place up, and a heading inside the section: held.
    const g = L.findIndex((l) => l === "- [ ] Gamma");
    const b = L.findIndex((l) => l === "- [ ] Beta");
    const gamma = L.splice(g, 2);
    L.splice(b, 0, ...gamma);
    L.splice(L.indexOf("A paragraph.") + 1, 0, "", "### Inside");
    const h = await held(a, L.join("\n"));
    expect(h).toMatchObject({ cause: "unsupported", count: 2, moved: ["Gamma"] });
    const c = cardOf(h as HeldEdits, "unsupported");
    expect(c.card.facts[0]).toMatch(/^2 edits not sent: .*\. Moved, not sent: “Gamma”\.$/);
  });

  it("a heading inside the section: nothing sent; 2 edits held, cause and line named", async () => {
    const { a } = await twoVaults(BODY);
    const L = lines(a.note());
    const at = L.indexOf("A paragraph.");
    L[at] = "A paragraph, edited.";
    L.splice(at + 1, 0, "", "### Inside");
    const md = L.join("\n");
    const h = await held(a, md);
    expect(h).toMatchObject({ cause: "unsupported", count: 2, line: at + 2, code: "heading" });
    // Nothing reached the model.
    const texts = Object.values(a.model()?.nodes ?? {}).map((n) => n.text);
    expect(texts).toContain("A paragraph.");
    expect(texts).not.toContain("A paragraph, edited.");
    const c = cardOf(h as HeldEdits, "unsupported");
    expectNeverCurrent(c);
    expect(c.card.facts[0]).toBe(
      `2 edits not sent: the section has content it cannot share (Plan.md, line ${at + 3}).`,
    );
    expect(c.card.problems[0]).toBe(
      `A heading inside the shared section (line ${at + 3} of Plan.md) cannot be shared. Remove it, or move it below the section's end marker; until then nothing in this copy is sent.`,
    );
    expect(c.card.held).toEqual([h]);
  });

  it("a damaged binding line: held with its line; the card offers the repair's words", async () => {
    const { a } = await twoVaults(BODY);
    const L = lines(a.note());
    const marker = L.findIndex((l) => l.startsWith("<!-- lfcp-node: paragraph:"));
    L[marker] = "<!-- lfcp-node: paragraph:zz -->";
    const alpha = L.indexOf("- [ ] Alpha");
    L[alpha] = "- [ ] Alpha renamed";
    const h = await held(a, L.join("\n"));
    expect(h).toMatchObject({ cause: "binding", line: marker, code: "NODE_MARKER_MALFORMED" });
    // The renamed Task is the edit held (the paragraph's marker is the cause, not an edit).
    expect(h?.count).toBe(1);
    expect(h?.nodeIds).toHaveLength(1);
    expect(a.note()).toContain("- [ ] Alpha renamed");
    const c = cardOf(h as HeldEdits, "unsupported");
    expectNeverCurrent(c);
    expect(c.card.problems[0]).toMatch(
      new RegExp(
        `^A binding line of the section is damaged \\(line ${marker + 1} of Plan.md\\)\\. Undo the edit, or run "Repair shared sections in this note"`,
      ),
    );
  });

  it("a read-only copy: the edit is kept, not sent; held as read-only on its row", async () => {
    const { a } = await twoVaults(BODY);
    a.setAccess({ allowed: false, reason: "read-only" });
    const L = lines(a.note());
    const alpha = L.indexOf("- [ ] Alpha");
    L[alpha] = "- [ ] Alpha typed";
    const h = await held(a, L.join("\n"));
    expect(h).toMatchObject({ cause: "read-only", count: 1, line: alpha });
    expect(h?.nodeIds).toHaveLength(1);
    const c = cardOf(h as HeldEdits, "diverged");
    expectNeverCurrent(c);
    expect(c.card.facts[0]).toBe(
      `1 edit not sent: you can read this section, not edit it (Plan.md, line ${alpha + 1}).`,
    );
    expect(c.card.problems[0]).toMatch(/^You can read this section, not edit it: your edits/);
  });

  it("a clean pass holds nothing; held edits keep the badge from CURRENT even with a clean source", async () => {
    const { a } = await twoVaults(BODY);
    expect(await held(a, a.note())).toBeNull();
    const h: HeldEdits = {
      path: "Plan.md",
      projectionId: "p",
      cause: "read-only",
      count: 1,
      line: 3,
      nodeIds: ["n"],
    };
    const c = cardOf(h, "clean");
    expectNeverCurrent(c);
  });
});

describe("access freshness and not-member (F-C05)", () => {
  const observed = (reason: string | undefined, allowed = false) =>
    observedFacts({
      session: "s",
      load: { ready: true, loaded: true },
      phase: "LIVE",
      wasLive: true,
      problems: [],
      projections: [],
      sdk: {
        revision: 1,
        batches: [],
        unconfirmed: new Set(),
        access: { allowed, ...(reason === undefined ? {} : { reason }), verifiedAt: 1234 } as never,
        accessCurrent: false,
        pendingControl: [],
        section: "ready",
        catchUp: "current-at-checkpoint",
        needsSnapshot: false,
      },
    });

  it("not-member is its own fact and its own words, never revoked", () => {
    const f = observed("not-member");
    expect(f.access).toBe("not-member");
    expect(observed("revoked").access).toBe("revoked");
    const view = statusView(f);
    expect(view.state).toBe("ATTENTION");
    expect(view.conditions[0]).toEqual({ kind: "access", access: "not-member" });
    // Not a member: nothing is being checked.
    expect(view.conditions.some((c) => c.kind === "access-checking")).toBe(false);
    const card = sectionCard({ title: "Plan", view, resource: "BwcH", sectionId: "s1" });
    expect(card.problems[0]).toMatch(/^This vault is not a member of this section/);
  });

  it("the access answer's freshness is carried: verifiedAt and current", () => {
    const f = observed(undefined, true);
    expect(f.accessVerifiedAt).toBe(1234);
    expect(f.accessCurrent).toBe(false);
    expect(f.accessChecking).toBe(true);
  });
});
