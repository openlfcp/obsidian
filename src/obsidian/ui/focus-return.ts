// Focus after a dialog (U03-18, LFCP-03-022; OBSIDIAN-CONTEXTUAL-UX-03 §8:
// "Escape returns focus to the initiator or a safe fallback"). A dialog
// opened from a control outside the editor (a pane button, a card's button)
// gives focus back to that control when it closes, by Escape or by its own
// buttons. When the pane drew that control again while the dialog was open,
// focus goes to the control with the same pane key, else to the pane's
// heading. A dialog opened from the editor leaves focus to Obsidian, which
// gives the editor back its selection. Nothing is taken when the next
// dialog of the flow is already open, or when focus went elsewhere on
// purpose (another control than the editor and the page).

import type { Modal } from "obsidian";

/** The attribute that names a pane control across redraws (pane-renderer.ts). */
const PANE_KEY = "data-pane-key";

/** Where focus was when a dialog opened; restore() gives it back. */
export interface FocusOrigin {
  restore(): void;
}

/** The focus now in `doc`, to give back later; null: nothing to give back (the page, the editor). */
export function focusOrigin(doc: Document): FocusOrigin | null {
  const win = doc.defaultView;
  const origin = doc.activeElement;
  // The window's own HTMLElement: a popout's elements are not the main window's.
  if (win === null || !(origin instanceof win.HTMLElement) || origin === doc.body) return null;
  if (origin.closest(".cm-editor, .markdown-reading-view") !== null) return null;
  const pane = origin.closest<HTMLElement>(".openlfcp-pane");
  const key = origin.closest(`[${PANE_KEY}]`)?.getAttribute(PANE_KEY) ?? null;
  const target = (): HTMLElement | null => {
    if (origin.isConnected) return origin;
    if (pane === null || !pane.isConnected) return null;
    const named = (k: string) =>
      Array.from(pane.querySelectorAll<HTMLElement>(`[${PANE_KEY}]`)).find(
        (e) => e.getAttribute(PANE_KEY) === k,
      ) ?? null;
    return (key === null ? null : named(key)) ?? named("title");
  };
  return {
    restore() {
      // The flow's next dialog is open: it holds the focus now.
      if (doc.querySelector(".modal-container") !== null) return;
      const to = target();
      if (to === null) return;
      const now = doc.activeElement;
      const free =
        now === null ||
        now === doc.body ||
        !now.isConnected ||
        now.closest(".cm-editor, .markdown-reading-view") !== null;
      if (now !== to && free) to.focus();
    },
  };
}

/** The origin of each open dialog, by its container: a dialog opened from it takes it over. */
const origins = new WeakMap<Element, FocusOrigin>();
/** A dialog's origin, just closed and not given back yet: the flow's next dialog takes it over. */
let handing: FocusOrigin | null = null;

/**
 * `modal`, which gives focus back where it was when it opened (call it just
 * before open). The focus is given back once Obsidian has closed the dialog.
 * A flow's next dialog (an invitation after its role) gives it back to the
 * same place: it takes over the origin of the dialog it was opened from.
 */
export function returnsFocus<M extends Modal>(modal: M): M {
  const doc = typeof activeDocument === "undefined" ? undefined : activeDocument;
  const win = doc?.defaultView;
  if (doc === undefined || win === null || win === undefined) return modal;
  const from = doc.activeElement?.closest(".modal-container");
  const origin =
    (from === null || from === undefined ? null : (origins.get(from) ?? null)) ??
    focusOrigin(doc) ??
    handing;
  if (origin === null) return modal;
  handing = null;
  const container = (modal as { containerEl?: Element }).containerEl;
  if (container !== undefined) origins.set(container, origin);
  const onClose = modal.onClose.bind(modal);
  modal.onClose = () => {
    onClose();
    handing = origin;
    win.setTimeout(() => {
      if (handing === origin) handing = null;
      origin.restore();
    }, 0);
  };
  return modal;
}
