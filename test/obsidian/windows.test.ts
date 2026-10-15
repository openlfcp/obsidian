// @vitest-environment happy-dom
// LFCP-03-022 (U03-19, U03-20): a popout window has a document of its own.
// What the plugin listens to in a document (the copy filter: no plugin UI in
// a copy of rendered content) is on in each window's document, once.

import { afterEach, describe, expect, it } from "vitest";
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
    inEveryWindow(
      ws as never,
      document,
      (r) => refs.push(r),
      (d) => docs.push(d),
    );
    expect(docs).toEqual([document, early]);
    const later = popout().doc;
    ws.trigger("window-open", {}, { document: later });
    // The same window again: nothing twice.
    ws.trigger("window-open", {}, { document: later });
    ws.trigger("window-open", {}, { document });
    expect(docs).toEqual([document, early, later]);
    // The one workspace subscription is the caller's to give back.
    expect(refs.length).toBe(1);
    expect(ws.listeners("window-open")).toBe(1);
  });
});
