// Obsidian's popout windows (LFCP-03-022, U03-19, U03-20): each has a
// document of its own, so a listener on the main document misses what
// happens in a popout. This runs a registration once per window's document.

import type { EventRef, Workspace } from "obsidian";

/**
 * Runs `fn` once for each window's document: `main` now, a popout already
 * open once the layout is ready, and a popout opened later. `own` takes the
 * workspace subscription, to give it back with the plugin; what `fn`
 * registers is the caller's to give back.
 */
export function inEveryWindow(
  ws: Workspace,
  main: Document,
  own: (ref: EventRef) => void,
  fn: (doc: Document) => void,
): void {
  const seen = new WeakSet<Document>();
  const add = (doc: Document | undefined) => {
    if (doc === undefined || seen.has(doc)) return;
    seen.add(doc);
    fn(doc);
  };
  add(main);
  own(ws.on("window-open", (_w, win) => add(win.document)));
  ws.onLayoutReady(() =>
    ws.iterateAllLeaves((leaf) => add((leaf.view?.containerEl as Node | undefined)?.doc)),
  );
}
