// @vitest-environment happy-dom
// The pane's DOM (LFCP-03-007): every UX fixture drawn from its view model,
// keyboard focus across redraws, and the three prototype flows walked with
// the pane's own buttons only (no command palette). The prototype runs no
// operation: these are mock facts, not sync evidence.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { paneFactsOf } from "../../src/core/pane/mock-facts";
import { paneModel } from "../../src/core/pane/model";
import { PanePrototype, type PrototypeFixture } from "../../src/core/pane/prototype";
import { renderPane } from "../../src/obsidian/ui/pane-renderer";

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/ux-0.3/states.json"), "utf8"),
) as { states: (PrototypeFixture & { expected: { primaryCta: string | null } })[] };

let root: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("div");
  root.className = "is-narrow";
  document.body.appendChild(root);
});

const buttons = () => Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
const byText = (label: string) => {
  const b = buttons().find((x) => x.textContent === label);
  if (b === undefined)
    throw new Error(
      `no button "${label}" in: ${buttons()
        .map((x) => x.textContent)
        .join(" | ")}`,
    );
  return b;
};
const primary = () => root.querySelector<HTMLButtonElement>(".openlfcp-pane-primary button");
const text = () => root.textContent ?? "";

describe("pane renderer on the UX fixtures", () => {
  for (const s of doc.states)
    it(`${s.id}: one primary button, disabled reasons in words, destructive in the menu`, () => {
      const model = paneModel(paneFactsOf(s.facts));
      renderPane(root, model, { action: () => undefined });
      expect(primary()?.dataset.action ?? null).toBe(s.expected.primaryCta);
      expect(root.querySelectorAll(".openlfcp-pane-primary button").length).toBeLessThanOrEqual(1);
      // A2: join in the header in every state.
      expect(root.querySelector(".openlfcp-pane-header button")?.textContent).toBe(
        "Join with a link…",
      );
      for (const b of buttons().filter((x) => x.getAttribute("aria-disabled") === "true")) {
        const reason = document.getElementById(b.getAttribute("aria-describedby") ?? "");
        expect(reason?.textContent, b.textContent ?? "").toBeTruthy();
        // Still reachable by keyboard: not the disabled attribute.
        expect(b.disabled).toBe(false);
      }
      for (const b of buttons().filter((x) => x.classList.contains("mod-warning")))
        expect(b.closest("details.openlfcp-pane-menu")).not.toBeNull();
    });

  it("sets every string as text, never as markup", () => {
    const s = doc.states.find((x) => x.id === "healthy-can-invite");
    if (s?.facts.section == null) throw new Error("fixture missing");
    const facts = paneFactsOf({
      ...s.facts,
      section: { ...s.facts.section, sharedTitle: "<img src=x onerror=alert(1)>" },
    });
    renderPane(root, paneModel(facts), { action: () => undefined });
    expect(root.querySelector("img")).toBeNull();
    expect(text()).toContain("<img src=x onerror=alert(1)>");
  });

  it("a disabled action does nothing when clicked", () => {
    const s = doc.states.find((x) => x.id === "offline-queued");
    if (s === undefined) throw new Error("fixture missing");
    const clicked: string[] = [];
    renderPane(root, paneModel(paneFactsOf(s.facts)), { action: (id) => clicked.push(id) });
    byText("Invite collaborator…").click();
    expect(clicked).toEqual([]);
    byText("Sync details").click();
    expect(clicked).toEqual(["sync-details"]);
  });
});

describe("pane focus", () => {
  it("keeps focus on the same control across a redraw, and falls back to the heading", () => {
    const proto = new PanePrototype(doc.states, "first-use");
    const draw = () =>
      renderPane(root, proto.model(), {
        action: (id) => {
          proto.act(id);
          draw();
        },
      });
    draw();
    byText("Join with a link…").focus();
    draw();
    expect(document.activeElement?.textContent).toBe("Join with a link…");
    // The primary changes from Share to the flow's own step: focus goes to the heading.
    primary()?.focus();
    primary()?.click();
    expect(root.contains(document.activeElement)).toBe(true);
  });

  it("never takes focus from outside the pane on an update", () => {
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    const proto = new PanePrototype(doc.states, "healthy");
    renderPane(root, proto.model(), { action: () => undefined });
    renderPane(root, proto.model(), { action: () => undefined });
    expect(document.activeElement).toBe(outside);
  });
});

describe("prototype flows, walked with the pane's buttons only", () => {
  let proto: PanePrototype;
  const draw = () =>
    renderPane(root, proto.model(), {
      action: (id) => {
        proto.act(id);
        draw();
      },
      join: (link) => {
        proto.join(link);
        draw();
      },
    });
  const control = (label: RegExp) => {
    const c = proto.controls().find((x) => label.test(x.label));
    if (c === undefined)
      throw new Error(`no control ${label}: ${proto.controls().map((x) => x.label)}`);
    proto.control(c.id);
    draw();
  };

  it("share → invite, the flow keeping its note when the active note changes", () => {
    proto = new PanePrototype(doc.states, "first-use");
    draw();
    expect(primary()?.textContent).toBe("Share section…");
    primary()?.click();
    expect(text()).toContain("Target: Plan.md");
    expect(text()).toContain(
      "Everything inside this section, including future additions, will be shared.",
    );
    control(/switch the active note/);
    expect(text()).toContain("The active note is Other.md; this stays on Plan.md.");
    expect(primary()?.textContent).toBe("Share section…");
    primary()?.click();
    // An effect under way: no next step, only progress.
    expect(primary()).toBeNull();
    control(/finish/);
    control(/finish/);
    expect(text()).toContain("Current as last checked with the server.");
    expect(primary()?.textContent).toBe("Invite collaborator…");
    primary()?.click();
    expect(text()).toContain("One-time link, does not expire; whoever opens it first joins.");
    primary()?.click();
    control(/finish/);
    control(/Copy link/);
    expect(text()).toContain("Link copied");
    expect(text().toLowerCase()).not.toContain("invitation sent");
    expect(text().toLowerCase()).not.toContain("invited");
  });

  it("join → insert, a malformed link told apart, the join field explicit", () => {
    proto = new PanePrototype(doc.states, "no-note");
    draw();
    expect(primary()).toBeNull();
    byText("Join with a link…").click();
    const input = root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input");
    const form = root.querySelector("form");
    if (input === null || form === null) throw new Error("no join field");
    input.value = "https://example.org/not-a-link";
    form.requestSubmit();
    expect(text()).toContain("This is not an invitation link.");
    const again = root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input");
    if (again === null) throw new Error("no join field");
    again.value = "lfcp://join/synthetic-link";
    root.querySelector("form")?.requestSubmit();
    // The claim is under way: no next step, only progress.
    expect(primary()).toBeNull();
    expect(text()).toContain("Claim the invitation with the server…");
    control(/finish/);
    control(/finish/);
    expect(text()).toContain("Sprint");
    expect(text()).toContain("Not inserted yet");
    expect(primary()?.textContent).toBe("Insert into a note…");
    primary()?.click();
    expect(text()).toContain("Target: Sprint notes.md");
    primary()?.click();
    primary()?.click();
    control(/finish/);
    control(/finish/);
    expect(text()).toContain("Inserted into Sprint notes.md.");
    expect(text()).toContain("In 1 note");
  });

  it("join, then later: the section stays listed as not inserted, no flow left open", () => {
    proto = new PanePrototype(doc.states, "no-note");
    draw();
    proto.act("join-with-link");
    proto.join("lfcp://join/synthetic-link");
    proto.control("finish-step");
    proto.control("finish-step");
    control(/Continue later/);
    expect(root.querySelector(".openlfcp-pane-flow")).toBeNull();
    expect(text()).toContain("Not inserted yet");
  });

  it("problem: held edits → repair → the real result, no promise beyond it", () => {
    proto = new PanePrototype(doc.states, "held-edits");
    draw();
    expect(text()).toContain("3 edits not sent");
    expect(primary()?.textContent).toBe("Repair shared sections…");
    primary()?.click();
    primary()?.click();
    control(/finish/);
    expect(text()).toContain("3 local updates waiting");
    expect(text()).not.toContain("Current as last checked");
    expect(text().toLowerCase()).not.toContain("will be sent after the repair");
    control(/server accepts/);
    expect(text()).toContain("Current as last checked with the server.");
  });
});
