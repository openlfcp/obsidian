// Obsidian's popout windows (LFCP-03-022, U03-19, U03-20): each has a
// document of its own, so a listener on the main document misses what
// happens in a popout. This runs a registration once per window's document
// and gives it back when that window closes, so that a closed popout's
// document is not held by the plugin.

import type { EventRef, Workspace } from "obsidian";

/**
 * Runs `fn` once for each window's document: `main` now, a popout already
 * open once the layout is ready, and a popout opened later. What `fn`
 * returns gives its registration back: when that popout closes, or for
 * every window still open when the returned function runs (the plugin's
 * unload). `own` takes the workspace subscriptions, to give them back with
 * the plugin.
 */
export function inEveryWindow(
  ws: Workspace,
  main: Document,
  own: (ref: EventRef) => void,
  fn: (doc: Document) => () => void,
): () => void {
  const held = new Map<Document, () => void>();
  const add = (doc: Document | undefined) => {
    if (doc === undefined || held.has(doc)) return;
    held.set(doc, fn(doc));
  };
  const drop = (doc: Document | undefined) => {
    if (doc === undefined || doc === main) return;
    held.get(doc)?.();
    held.delete(doc);
  };
  add(main);
  own(ws.on("window-open", (_w, win) => add(win.document)));
  own(ws.on("window-close", (_w, win) => drop(win.document)));
  ws.onLayoutReady(() =>
    ws.iterateAllLeaves((leaf) => add((leaf.view?.containerEl as Node | undefined)?.doc)),
  );
  return () => {
    for (const off of held.values()) off();
    held.clear();
  };
}
