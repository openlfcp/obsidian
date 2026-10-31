// @vitest-environment happy-dom
// The pane's DOM (LFCP-03-007): every UX fixture drawn from its view model,
// and keyboard focus across redraws. These are mock facts, not sync evidence.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type FixtureFacts, paneFactsOf } from "../../src/core/pane/mock-facts";
import { type PaneAction, type PaneFlow, paneModel } from "../../src/core/pane/model";
import { MENU_EMPTY, type PaneChrome, renderPane } from "../../src/obsidian/ui/pane-renderer";

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/ux-0.3/states.json"), "utf8"),
) as {
  states: { id: string; facts: FixtureFacts; expected: { primaryCta: string | null } }[];
};

/** A fixture's model, optionally with a flow running (the join field is part of the join flow). */
const modelOf = (id: string, flow: PaneFlow | null = null) => {
  const s = doc.states.find((x) => x.id === id);
  if (s === undefined) throw new Error(`fixture ${id} missing`);
  const facts = paneFactsOf(s.facts);
  return paneModel(flow === null ? facts : { ...facts, context: { ...facts.context, flow } });
};
const JOIN_FLOW: PaneFlow = { kind: "join", stage: "link", outcome: "running" };

let root: HTMLElement;
/** The host's icons, tooltips and menu, as stand-ins that record what the pane asked of them. */
let chrome: PaneChrome;
let icons: [string, string][];
let tips: [string, string][];
let menus: { anchor: HTMLElement; items: readonly PaneAction[] }[];

beforeEach(() => {
  icons = [];
  tips = [];
  menus = [];
  chrome = {
    icon: (el, name) => {
      icons.push([el.parentElement?.getAttribute("data-pane-key") ?? "", name]);
    },
    tooltip: (el, text) => {
      tips.push([el.textContent ?? "", text]);
    },
    menu: (anchor, items) => {
      menus.push({ anchor, items });
    },
  };
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
/** The header's icon buttons, in order: Share, Insert, Join, then "More actions". */
const headerButtons = () =>
  Array.from(root.querySelectorAll<HTMLButtonElement>(".openlfcp-pane-header button"));
const primary = () => root.querySelector<HTMLButtonElement>(".openlfcp-pane-primary button");
const text = () => root.textContent ?? "";

describe("pane renderer on the UX fixtures", () => {
  for (const s of doc.states)
    it(`${s.id}: one primary button, disabled reasons in words, destructive in the menu`, () => {
      const model = paneModel(paneFactsOf(s.facts));
      renderPane(root, model, { chrome, action: () => undefined });
      expect(primary()?.dataset.action ?? null).toBe(s.expected.primaryCta);
      expect(root.querySelectorAll(".openlfcp-pane-primary button").length).toBeLessThanOrEqual(1);
      // A2, A8: the same three icon buttons and "More actions", in every state.
      expect(headerButtons().map((b) => b.textContent)).toEqual([
        "Share section…",
        "Insert into a note…",
        "Join with a link…",
        "More actions",
      ]);
      expect(headerButtons().every((b) => b.classList.contains("clickable-icon"))).toBe(true);
      expect(headerButtons().map((b) => b.dataset.action ?? null)).toEqual([
        "share-section",
        "insert-into-note",
        "join-with-link",
        null,
      ]);
      // No `title` attribute: the tooltip is the host's.
      expect(headerButtons().every((b) => !b.hasAttribute("title"))).toBe(true);
      for (const b of buttons().filter((x) => x.getAttribute("aria-disabled") === "true")) {
        const reason = document.getElementById(b.getAttribute("aria-describedby") ?? "");
        expect(reason?.textContent, b.textContent ?? "").toBeTruthy();
        // Still reachable by keyboard: not the disabled attribute.
        expect(b.disabled).toBe(false);
      }
      // Destructive actions are never buttons in the pane: they go to the host's menu (A1, A8).
      expect(buttons().filter((x) => x.classList.contains("mod-warning"))).toEqual([]);
      for (const a of model.menu)
        expect(buttons().some((x) => x.dataset.action === a.id)).toBe(false);
      expect(root.querySelector("details")).toBeNull();
      expect(menus).toEqual([]);
      const more = headerButtons()[3];
      if (more === undefined) throw new Error("no More actions button");
      more.click();
      if (model.menu.length === 0) {
        expect(more.getAttribute("aria-disabled")).toBe("true");
        expect(menus).toEqual([]);
        expect(tips.at(-1)).toEqual(["More actions", `More actions — ${MENU_EMPTY}`]);
      } else {
        expect(menus.length).toBe(1);
        expect(menus[0]?.anchor).toBe(more);
        expect(menus[0]?.items).toEqual(model.menu);
        expect(menus[0]?.items.every((a) => a.destructive)).toBe(true);
      }
    });

  it("sets every string as text, never as markup", () => {
    const s = doc.states.find((x) => x.id === "healthy-can-invite");
    if (s?.facts.section == null) throw new Error("fixture missing");
    const facts = paneFactsOf({
      ...s.facts,
      section: { ...s.facts.section, sharedTitle: "<img src=x onerror=alert(1)>" },
    });
    renderPane(root, paneModel(facts), { chrome, action: () => undefined });
    expect(root.querySelector("img")).toBeNull();
    expect(text()).toContain("<img src=x onerror=alert(1)>");
  });

  it("a disabled action does nothing when clicked", () => {
    const s = doc.states.find((x) => x.id === "offline-queued");
    if (s === undefined) throw new Error("fixture missing");
    const clicked: string[] = [];
    renderPane(root, paneModel(paneFactsOf(s.facts)), { chrome, action: (id) => clicked.push(id) });
    byText("Invite collaborator…").click();
    expect(clicked).toEqual([]);
    byText("Sync details").click();
    expect(clicked).toEqual(["sync-details"]);
  });
});

describe("the pane header (UXD-11, A8)", () => {
  it("draws an icon and a host tooltip per button; the label is the button's text", () => {
    renderPane(root, modelOf("healthy-can-invite"), { chrome, action: () => undefined });
    expect(icons).toEqual([
      ["header:share-section", "share-2"],
      ["header:insert-into-note", "file-input"],
      ["header:join-with-link", "link"],
      ["menu", "more-horizontal"],
    ]);
    expect(tips.map(([, t]) => t.split(" — ")[0])).toEqual([
      "Share section…",
      "Insert into a note…",
      "Join with a link…",
      "More actions",
    ]);
    // The icon sits in its own hidden-from-readers span: the button's text is the label alone.
    const join = headerButtons()[2];
    expect(join?.querySelector(".openlfcp-pane-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(join?.querySelector(".openlfcp-visually-hidden")?.textContent).toBe("Join with a link…");
    expect(join?.tagName).toBe("BUTTON");
    expect(join?.getAttribute("type")).toBe("button");
  });

  it("keeps the title in the DOM, hidden from the eye, as the focus target", () => {
    renderPane(root, modelOf("healthy-can-invite"), { chrome, action: () => undefined });
    const title = root.querySelector<HTMLElement>("h2.openlfcp-pane-title");
    expect(title?.textContent).toBe("Shared Tasks");
    expect(title?.classList.contains("openlfcp-visually-hidden")).toBe(true);
    expect(title?.getAttribute("data-pane-key")).toBe("title");
  });

  it("A5: a blocked entry is disabled with its reason in the tooltip and as its description", () => {
    // A selection and no shared section: Insert is not offered; the header still draws it, blocked.
    const model = modelOf("selection-exact");
    const insert = model.header.find((a) => a.id === "insert-into-note");
    if (insert === undefined || insert.reason === null) throw new Error("fixture changed");
    const clicked: string[] = [];
    renderPane(root, model, { chrome, action: (id) => clicked.push(id) });
    const b = headerButtons()[1];
    expect(b?.textContent).toBe("Insert into a note…");
    expect(b?.getAttribute("aria-disabled")).toBe("true");
    expect(b?.classList.contains("is-disabled")).toBe(true);
    expect(tips.find(([t]) => t === "Insert into a note…")?.[1]).toBe(
      `Insert into a note… — ${insert.reason}`,
    );
    expect(document.getElementById(b?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      insert.reason,
    );
    b?.click();
    expect(clicked).toEqual([]);
    // An enabled entry runs its action.
    headerButtons()[2]?.click();
    expect(clicked).toEqual(["join-with-link"]);
  });

  it("hands the menu its destructive items; a blocked one keeps its reason", () => {
    const model = modelOf("loading");
    renderPane(root, model, { chrome, action: () => undefined });
    headerButtons()[3]?.click();
    const items = menus[0]?.items ?? [];
    expect(items.map((a) => a.id)).toEqual(model.menu.map((a) => a.id));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((a) => a.destructive)).toBe(true);
    const detach = items.find((a) => a.id === "detach-section");
    expect(detach?.enabled).toBe(false);
    expect(detach?.reason).toBeTruthy();
  });

  // The menu used to be a <details> that a redraw had to keep open. It is now the host's
  // menu, outside the pane's DOM: a redraw cannot close it, so nothing is kept here.

  it("keeps focus on a header button across a redraw", () => {
    const draw = () =>
      renderPane(root, modelOf("healthy-can-invite"), { chrome, action: () => undefined });
    draw();
    headerButtons()[0]?.focus();
    draw();
    expect(document.activeElement?.textContent).toBe("Share section…");
    headerButtons()[3]?.focus();
    draw();
    expect(document.activeElement?.textContent).toBe("More actions");
  });
});

describe("pane focus", () => {
  it("keeps focus on the same control across a redraw, and falls back to the heading", () => {
    let flow: PaneFlow | null = null;
    const draw = () =>
      renderPane(root, modelOf("healthy-can-invite", flow), {
        chrome,
        action: (id) => {
          if (id === "invite") flow = { kind: "invite", stage: "role", outcome: "running" };
          draw();
        },
      });
    draw();
    byText("Join with a link…").focus();
    draw();
    expect(document.activeElement?.textContent).toBe("Join with a link…");
    // The primary changes to the flow's own step: focus stays inside the pane.
    primary()?.focus();
    primary()?.click();
    expect(root.contains(document.activeElement)).toBe(true);
  });

  it("LFCP-03-019: says what deleting, removing the copy and detaching do, beside the menu", () => {
    const s = doc.states.find((x) => x.id === "healthy-can-invite");
    if (s === undefined) throw new Error("no state");
    const model = paneModel(paneFactsOf(s.facts));
    renderPane(root, model, { chrome, action: () => undefined });
    const block = root.querySelector(".openlfcp-pane-effects");
    expect(block?.getAttribute("aria-label")).toBe("What changes do here");
    expect(
      Array.from(block?.querySelectorAll(".openlfcp-pane-line") ?? []).map((x) => x.textContent),
    ).toEqual([...model.effects]);
    // Shown with the menu closed: the user reads it before opening "More actions".
    expect(menus).toEqual([]);
  });

  it("LFCP-03-022: a redraw keeps the join field itself: its text, caret and focus", () => {
    let flow: PaneFlow | null = null;
    const joined: string[] = [];
    const draw = () =>
      renderPane(root, modelOf("no-editor", flow), {
        chrome,
        action: (id) => {
          if (id === "join-with-link") flow = JOIN_FLOW;
          draw();
        },
        join: (link, name) => joined.push(`${link}|${name}`),
      });
    draw();
    byText("Join with a link…").click();
    const name = root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-name");
    const form = root.querySelector("form");
    if (name === null || form === null) throw new Error("no join field");
    name.value = "Sprint plan";
    name.focus();
    name.setSelectionRange(3, 3);
    // A status or a flow step redraws the pane while the user types.
    draw();
    draw();
    expect(root.querySelector("input.openlfcp-pane-join-name")).toBe(name);
    expect(root.querySelector("form")).toBe(form);
    expect(document.activeElement).toBe(name);
    expect([name.value, name.selectionStart]).toEqual(["Sprint plan", 3]);
    // The header stays first, the field right after it, one of each.
    expect(root.firstElementChild?.classList.contains("openlfcp-pane-header")).toBe(true);
    expect(root.firstElementChild?.nextElementSibling).toBe(form);
    expect(root.querySelectorAll("form").length).toBe(1);
    expect(root.querySelectorAll(".openlfcp-pane-header").length).toBe(1);
    // The submit runs the latest drawing's handler, once.
    const link = root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input");
    if (link === null) throw new Error("no link field");
    link.value = "lfcp://join/synthetic-link";
    form.requestSubmit();
    expect(joined).toEqual(["lfcp://join/synthetic-link|Sprint plan"]);
    expect(link.value).toBe("");
  });

  it("LFCP-03-022: Enter that ends an IME composition joins nothing", () => {
    let flow: PaneFlow | null = null;
    const joined: string[] = [];
    const draw = () =>
      renderPane(root, modelOf("no-editor", flow), {
        chrome,
        action: (id) => {
          if (id === "join-with-link") flow = JOIN_FLOW;
          draw();
        },
        join: (link) => joined.push(link),
      });
    draw();
    byText("Join with a link…").click();
    const name = root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-name");
    const link = root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input");
    const form = root.querySelector("form");
    if (name === null || link === null || form === null) throw new Error("no join field");
    link.value = "lfcp://join/synthetic-link";
    name.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    draw();
    form.requestSubmit();
    expect(joined).toEqual([]);
    expect(link.value).toBe("lfcp://join/synthetic-link");
    name.dispatchEvent(new Event("compositionend", { bubbles: true }));
    form.requestSubmit();
    expect(joined).toEqual(["lfcp://join/synthetic-link"]);
  });

  it("LFCP-03-022: Escape in the join field is its Cancel; focus goes back to Join with a link…", () => {
    let flow: PaneFlow | null = null;
    const draw = () =>
      renderPane(root, modelOf("no-editor", flow), {
        chrome,
        action: (id) => {
          if (id === "join-with-link") flow = JOIN_FLOW;
          draw();
        },
        join: () => undefined,
        dismiss: () => {
          flow = null;
          draw();
        },
      });
    draw();
    byText("Join with a link…").focus();
    byText("Join with a link…").click();
    const link = root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input");
    if (link === null) throw new Error("no join field");
    expect(document.activeElement).toBe(link);
    link.value = "lfcp://join/half-pasted";
    // Escape that ends a composition is the IME's.
    link.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }),
    );
    expect(root.querySelector("form")).not.toBeNull();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    link.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(link.value).toBe("");
    expect(root.querySelector("form")).toBeNull();
    expect(document.activeElement?.textContent).toBe("Join with a link…");
  });

  it("never takes focus from outside the pane on an update", () => {
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    renderPane(root, modelOf("healthy-can-invite"), { chrome, action: () => undefined });
    renderPane(root, modelOf("healthy-can-invite"), { chrome, action: () => undefined });
    expect(document.activeElement).toBe(outside);
  });
});

describe("the pane's tip (LFCP-03-021)", () => {
  const healthy = () => {
    const s = doc.states.find((x) => x.id === "healthy-can-invite");
    if (s === undefined) throw new Error("fixture missing");
    return paneFactsOf(s.facts);
  };

  it("draws one tip with Hide tip, as text; Hide tip hands its ID and runs no action", () => {
    const hidden: string[] = [];
    const ran: string[] = [];
    renderPane(root, paneModel({ ...healthy(), hints: { hidden: [] } }), {
      chrome,
      action: (id) => ran.push(id),
      hideHint: (id) => hidden.push(id),
      showHints: () => undefined,
    });
    const tips = root.querySelectorAll<HTMLElement>(".openlfcp-pane-hint");
    expect(tips.length).toBe(1);
    expect(tips[0]?.dataset.hint).toBe("invite-link");
    expect(tips[0]?.getAttribute("aria-label")).toBe("Tip");
    // A tip is not an alert: no live region takes the reader's attention.
    expect(tips[0]?.getAttribute("role")).toBeNull();
    byText("Hide tip").click();
    expect(hidden).toEqual(["invite-link"]);
    expect(ran).toEqual([]);
    expect(root.querySelector(".openlfcp-pane-help")).toBeNull();
  });

  it("offers Show tips again when some are hidden; focus falls back to the heading after Hide tip", () => {
    let shown = 0;
    const draw = (hidden: string[]) =>
      renderPane(root, paneModel({ ...healthy(), hints: { hidden } }), {
        chrome,
        action: () => undefined,
        hideHint: () => undefined,
        showHints: () => shown++,
      });
    draw([]);
    byText("Hide tip").focus();
    draw(["invite-link", "section-copy"]);
    expect(root.querySelector(".openlfcp-pane-hint")).toBeNull();
    expect(document.activeElement?.classList.contains("openlfcp-pane-title")).toBe(true);
    byText("Show tips again").click();
    expect(shown).toBe(1);
  });

  it("without the handlers, the tip shows with no button", () => {
    renderPane(root, paneModel({ ...healthy(), hints: { hidden: ["section-copy"] } }), {
      chrome,
      action: () => undefined,
    });
    expect(root.querySelector(".openlfcp-pane-hint")?.textContent).toContain("one-time link");
    expect(
      buttons().some((b) => b.textContent === "Hide tip" || b.textContent === "Show tips again"),
    ).toBe(false);
  });
});
