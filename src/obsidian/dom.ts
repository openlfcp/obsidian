// Detached elements made the Obsidian way (a window's createDiv/createSpan/
// createEl), in the document of the window they will live in: a popout
// window has a document of its own. Obsidian declares these helpers as
// globals, and every window has them, so `doc.win` is typed as having them.

interface ObsidianWindow extends Window {
  createDiv(cls?: string): HTMLDivElement;
  createSpan(cls?: string): HTMLSpanElement;
}

/** A <div> in `doc`'s window, not appended anywhere yet. */
export function divIn(doc: Document, cls?: string): HTMLDivElement {
  return (doc.win as ObsidianWindow).createDiv(cls);
}

/** A <span> in `doc`'s window, not appended anywhere yet. */
export function spanIn(doc: Document, cls?: string): HTMLSpanElement {
  return (doc.win as ObsidianWindow).createSpan(cls);
}
