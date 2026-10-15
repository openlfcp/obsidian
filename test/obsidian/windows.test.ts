// @vitest-environment happy-dom
// LFCP-03-022 (U03-19, U03-20): a popout window has a document of its own.
// What the plugin listens to in a document (the copy filter: no plugin UI in
// a copy of rendered content) is on in each window's document, once; the
// live region speaks in the window in use.

import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveRegion } from "../../src/obsidian/live-region";
import { inEveryWindow } from "../../src/obsidian/windows";
import * as mock from "../mocks/obsidian";

/** A popout's document, with a window (a closed popout's has none). */
function popout(): { doc: Document; close(): void } {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (doc === null) throw new Error("no frame document");
  return { doc, close: () => frame.remove() };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("popout windows (LFCP-03-022)", () => {
  it("registers once in the main window, in a popout open at load and in each opened later", () => {
    const ws = new mock.Workspace();
    const early = popout().doc;
    // A popout restored with the layout, its leaf already there at load.
    const leaf = new mock.WorkspaceLeaf(ws);
    leaf.view = { containerEl: Object.assign(early.createElement("div"), { doc: early }) } as never;
    ws.leaves.push(leaf);
    const refs: unknown[] = [];
    const docs: Document[] = [];
    const given: Document[] = [];
    const off = inEveryWindow(
      ws as never,
      document,
      (r) => refs.push(r),
      (d) => {
        docs.push(d);
        return () => given.push(d);
      },
    );
    expect(docs).toEqual([document, early]);
    const later = popout().doc;
    ws.trigger("window-open", {}, { document: later });
    // The same window again: nothing twice.
    ws.trigger("window-open", {}, { document: later });
    ws.trigger("window-open", {}, { document });
    expect(docs).toEqual([document, early, later]);
    // The workspace subscriptions (open, close) are the caller's to give back.
    expect(refs.length).toBe(2);
    expect(ws.listeners("window-open")).toBe(1);
    expect(ws.listeners("window-close")).toBe(1);
    // A popout closed: its registration is given back, once; the main one never.
    ws.trigger("window-close", {}, { document: later });
    ws.trigger("window-close", {}, { document: later });
    ws.trigger("window-close", {}, { document });
    expect(given).toEqual([later]);
    // Opened again later: registered anew.
    ws.trigger("window-open", {}, { document: later });
    expect(docs).toEqual([document, early, later, later]);
    // The plugin unloaded: every window still open gives its registration back.
    off();
    expect(new Set(given)).toEqual(new Set([document, early, later]));
    expect(given.length).toBe(4);
  });

  it("a popout's copy listener goes with its window", () => {
    const ws = new mock.Workspace();
    const p = popout();
    const counts = new Map<Document, number>();
    const off = inEveryWindow(
      ws as never,
      document,
      () => undefined,
      (doc) => {
        const copy = () => counts.set(doc, (counts.get(doc) ?? 0) + 1);
        doc.addEventListener("copy", copy);
        return () => doc.removeEventListener("copy", copy);
      },
    );
    ws.trigger("window-open", {}, { document: p.doc });
    p.doc.dispatchEvent(new Event("copy"));
    expect(counts.get(p.doc)).toBe(1);
    ws.trigger("window-close", {}, { document: p.doc });
    p.doc.dispatchEvent(new Event("copy"));
    expect(counts.get(p.doc)).toBe(1);
    document.dispatchEvent(new Event("copy"));
    expect(counts.get(document)).toBe(1);
    off();
    document.dispatchEvent(new Event("copy"));
    expect(counts.get(document)).toBe(1);
  });

  it("the live region speaks in the window in use, and goes away with the plugin", () => {
    vi.useFakeTimers();
    const main = document;
    const other = popout();
    let current: Document = main;
    const live = new LiveRegion(main, () => current);
    const region = (d: Document) => d.querySelector(".openlfcp-live-region");
    expect(region(main)).not.toBeNull();
    expect(region(other.doc)).toBeNull();
    current = other.doc;
    live.announce("A problem in Plan.");
    vi.advanceTimersByTime(150);
    expect(region(other.doc)?.textContent).toBe("A problem in Plan.");
    expect(region(other.doc)?.getAttribute("aria-live")).toBe("polite");
    expect(region(main)?.textContent).toBe("");
    expect(live.text).toBe("A problem in Plan.");
    // Back in the main window: the popout's words are cleared, said here.
    current = main;
    live.announce("Another one.");
    vi.advanceTimersByTime(150);
    expect(region(other.doc)?.textContent).toBe("");
    expect(region(main)?.textContent).toBe("Another one.");
    expect(live.documents).toBe(2);
    // The popout closed: its region is let go at the next announcement.
    other.close();
    live.announce("Once more.");
    expect(live.documents).toBe(1);
    live.detach();
    expect(region(main)).toBeNull();
  });
});
