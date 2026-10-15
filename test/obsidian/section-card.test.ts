// @vitest-environment happy-dom
// LFCP-03-013 (A5, A7, D10): the section card draws an action that applies
// but is blocked as a disabled button with its reason next to it, reachable
// by keyboard (aria-disabled, aria-describedby); a click on it runs nothing
// and keeps the card open. An enabled one closes the card and runs.

import { describe, expect, it } from "vitest";
import type { SectionCard } from "../../src/core/status/card";
import { SectionCardModal } from "../../src/obsidian/ui/section-card";
import * as mock from "../mocks/obsidian";

const content = {
  heading: 'Shared section "Launch"',
  status: "Current",
  facts: [],
  problems: [],
  shared: [],
  technical: [],
  held: [],
} as unknown as SectionCard;

// Obsidian's global for the focused window's document: where focus returns on close.
(globalThis as { activeDocument?: unknown }).activeDocument ??= { activeElement: null };

describe("the section card's buttons (LFCP-03-013)", () => {
  it("a blocked action is shown disabled with its reason; a click runs nothing", () => {
    const ran: string[] = [];
    const modal = new SectionCardModal(new mock.App() as never, content, [
      {
        label: "Invite collaborator…",
        disabled: "Inviting waits until this device has checked access with the server.",
        run: () => void ran.push("invite"),
      },
      { label: "Resource status", run: () => void ran.push("status") },
    ]);
    modal.open();
    const el = modal.contentEl as unknown as mock.FakeElement;
    const [invite, status] = el.findAll("button");
    expect(invite?.text).toBe("Invite collaborator…");
    expect(invite?.getAttribute("aria-disabled")).toBe("true");
    const reason = el
      .findAll("p")
      .find((p) => p.getAttribute("id") === invite?.getAttribute("aria-describedby"));
    expect(reason?.text).toBe(
      "Invite collaborator: Inviting waits until this device has checked access with the server.",
    );
    invite?.click();
    expect(ran).toEqual([]);
    expect((modal as unknown as mock.Modal).isOpen).toBe(true);
    expect(status?.getAttribute("aria-disabled")).toBeNull();
    status?.click();
    expect(ran).toEqual(["status"]);
    expect((modal as unknown as mock.Modal).isOpen).toBe(false);
  });
});
