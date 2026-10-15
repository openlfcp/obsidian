// @vitest-environment happy-dom
// LFCP-03-022 (U03-18): a dialog opened from the pane gives focus back to
// the control that opened it, or to the same control drawn again, or to the
// pane's heading; a dialog opened from the editor leaves focus to Obsidian;
// a flow's next dialog gives it back to the same place.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { returnsFocus } from "../../src/obsidian/ui/focus-return";

/** A dialog as Obsidian shows one: a .modal-container while open, onClose on close. */
class FakeModal {
  readonly containerEl = document.createElement("div");
  readonly modalEl = document.createElement("div");
  readonly input = document.createElement("input");
  readonly cancel = document.createElement("button");
  readonly share = document.createElement("button");
  closed = 0;
  constructor() {
    this.containerEl.className = "modal-container";
    this.containerEl.appendChild(this.modalEl);
    this.modalEl.append(this.input, this.cancel, this.share);
  }
  onClose(): void {
    this.closed++;
  }
  open(): void {
    document.body.appendChild(this.containerEl);
    this.input.focus();
  }
  close(): void {
    this.containerEl.remove();
    this.onClose();
  }
}

let pane: HTMLElement;

/** The pane drawn anew: a heading and the given controls, by key. */
function drawPane(keys: readonly string[]): Record<string, HTMLButtonElement> {
  pane.replaceChildren();
  const title = document.createElement("h2");
  title.tabIndex = -1;
  title.setAttribute("data-pane-key", "title");
  pane.appendChild(title);
  const out: Record<string, HTMLButtonElement> = {};
  for (const k of keys) {
    const b = document.createElement("button");
    b.setAttribute("data-pane-key", k);
    b.textContent = k;
    pane.appendChild(b);
    out[k] = b;
  }
  return out;
}

const open = () => returnsFocus(new FakeModal() as never) as unknown as FakeModal;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  pane = document.createElement("div");
  pane.className = "openlfcp-pane";
  document.body.appendChild(pane);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("focus after a dialog (LFCP-03-022)", () => {
  it("goes back to the pane button that opened it, once Obsidian closed it", () => {
    const b = drawPane(["action:share-section"]);
    b["action:share-section"]?.focus();
    const m = open();
    m.open();
    expect(document.activeElement).toBe(m.input);
    m.close();
    expect(m.closed).toBe(1);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(b["action:share-section"]);
  });

  it("the pane drawn again meanwhile: the same control, else the pane's heading", () => {
    drawPane(["action:share-section"])["action:share-section"]?.focus();
    const m = open();
    m.open();
    const again = drawPane(["action:share-section", "action:join-with-link"]);
    m.close();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(again["action:share-section"]);

    drawPane(["action:detach"])["action:detach"]?.focus();
    const n = open();
    n.open();
    drawPane(["action:invite"]);
    n.close();
    vi.runOnlyPendingTimers();
    expect(document.activeElement?.getAttribute("data-pane-key")).toBe("title");
  });

  it("from the editor: focus is Obsidian's to give back", () => {
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const content = document.createElement("div");
    content.tabIndex = 0;
    editor.appendChild(content);
    document.body.appendChild(editor);
    content.focus();
    const m = open();
    m.open();
    m.close();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(document.body);
  });

  it("a flow's next dialog gives focus back to where the first one was opened", () => {
    const b = drawPane(["action:invite"]);
    b["action:invite"]?.focus();
    // The role, then the invitation opened as the role closes (focus on the page).
    const role = open();
    role.open();
    role.close();
    const invitation = open();
    invitation.open();
    vi.runOnlyPendingTimers();
    // The invitation is open: the role's close takes no focus from it.
    expect(document.activeElement).toBe(invitation.input);
    invitation.close();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(b["action:invite"]);
  });

  it("a next dialog opened from inside the first takes over its origin", () => {
    const b = drawPane(["action:repair"]);
    b["action:repair"]?.focus();
    const first = open();
    first.open();
    const second = open();
    second.open();
    first.close();
    second.close();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(b["action:repair"]);
  });

  it("focus that went elsewhere on purpose stays there", () => {
    const b = drawPane(["action:share-section"]);
    b["action:share-section"]?.focus();
    const m = open();
    m.open();
    m.close();
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(other);
  });

  it("Tab and Shift+Tab cycle in the dialog and never leave it", () => {
    drawPane(["action:share-section"])["action:share-section"]?.focus();
    const m = open();
    m.open();
    const tab = (shiftKey = false, handled = false) => {
      const e = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      if (handled) e.preventDefault();
      (document.activeElement ?? document.body).dispatchEvent(e);
      return e;
    };
    expect(document.activeElement).toBe(m.input);
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(m.cancel);
    tab();
    expect(document.activeElement).toBe(m.share);
    tab();
    expect(document.activeElement).toBe(m.input);
    tab(true);
    expect(document.activeElement).toBe(m.share);
    tab(true);
    tab(true);
    expect(document.activeElement).toBe(m.input);
    // Obsidian already took the key: the dialog leaves it alone.
    tab(false, true);
    expect(document.activeElement).toBe(m.input);
    m.close();
  });
});
