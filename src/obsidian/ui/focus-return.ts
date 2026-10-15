// Focus after a dialog (U03-18, LFCP-03-022; OBSIDIAN-CONTEXTUAL-UX-03 §8:
// "Escape returns focus to the initiator or a safe fallback"). A dialog
// opened from a control outside the editor (a pane button, a card's button)
// gives focus back to that control when it closes, by Escape or by its own
// buttons.
//
// Obsidian's own Modal already gives focus back to the control that opened
// it while that control is still in the page (native pane-keyboard, run
// 38768295636, Linux, macOS and Windows). What it cannot do, and this does:
// - the pane drew that control again while the dialog was open (a status,
//   a flow step): focus goes to the control with the same pane key, else to
//   the pane's heading;
// - a flow's next dialog (the invitation after its role) was opened from
//   the first one: focus goes back to where the first one was opened.
// A dialog opened from the editor leaves focus to Obsidian, which gives the
// editor back its selection. Nothing is taken when the next dialog of the
// flow is already open, or when focus went elsewhere on purpose (another
// control than the editor and the page).
//
// Tab and Shift+Tab stay in the dialog (a modal trap). Obsidian keeps Tab
// in its Modal on macOS and Windows, but Shift+Tab left it for the pane on
// Linux (run 38769145805); the plugin's dialogs keep both, everywhere,
// unless Obsidian already took the key.

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
  trapTab(modal);
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

/** What Tab may reach in a dialog: enabled, shown, in the Tab order. */
const FOCUSABLE =
  'button, [href], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/**
 * The Tab stops of `dialog`, in order. A radio group is one stop, as in the
 * browser: its checked button, else its first (the recovery and repair
 * choices); arrows move within the group.
 */
export function tabStops(dialog: HTMLElement): HTMLElement[] {
  const stops: HTMLElement[] = [];
  const groups = new Map<string, number>();
  for (const x of Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))) {
    if (
      (x as HTMLButtonElement).disabled ||
      x.getAttribute("aria-hidden") === "true" ||
      !(x.checkVisibility?.() ?? true)
    )
      continue;
    const radio = x.tagName === "INPUT" && x.getAttribute("type") === "radio";
    if (!radio || (x as HTMLInputElement).name === "") {
      stops.push(x);
      continue;
    }
    const name = (x as HTMLInputElement).name;
    const at = groups.get(name);
    if (at === undefined) {
      groups.set(name, stops.length);
      stops.push(x);
    } else if ((x as HTMLInputElement).checked) stops[at] = x;
  }
  return stops;
}

/** Tab and Shift+Tab cycle through `modal`'s Tab stops and never leave it. */
function trapTab(modal: Modal): void {
  const box = (modal as { containerEl?: HTMLElement }).containerEl;
  const dialog = (modal as { modalEl?: HTMLElement }).modalEl ?? box;
  if (box === undefined || dialog === undefined || typeof box.addEventListener !== "function")
    return;
  box.addEventListener("keydown", (e) => {
    if (
      e.key !== "Tab" ||
      e.defaultPrevented ||
      e.isComposing ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey
    )
      return;
    const items = tabStops(dialog);
    if (items.length === 0) return;
    const active = dialog.ownerDocument.activeElement as HTMLElement | null;
    // On a radio button: where its group's stop is.
    const name =
      active instanceof HTMLElement && active.getAttribute("type") === "radio"
        ? active.getAttribute("name")
        : null;
    const at = items.findIndex(
      (x) =>
        x === active ||
        (name !== null &&
          name !== "" &&
          x.getAttribute("type") === "radio" &&
          x.getAttribute("name") === name),
    );
    const next = e.shiftKey
      ? at <= 0
        ? items.length - 1
        : at - 1
      : at === -1 || at === items.length - 1
        ? 0
        : at + 1;
    e.preventDefault();
    e.stopPropagation();
    items[next]?.focus();
  });
}
