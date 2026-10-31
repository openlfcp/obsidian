// The Shared Tasks pane's DOM, built from a PaneModel (LFCP-03-007; UX
// contract §3, §5; OBSIDIAN-CONTEXTUAL-UX-03 §2, §8). It lays the model out
// and reports clicks; it decides nothing. Plain DOM, so the pane host
// (012/013) and the developer prototype share it, and a test can run it
// without Obsidian.
//
// - Every string goes in as text, never as markup.
// - Native buttons: Enter and Space work; no focus trap (a pane is not a modal).
// - A disabled action stays focusable (aria-disabled) and says why in words
//   next to it, so the reason is reachable by keyboard; a click on it does nothing.
// - A redraw keeps focus on the same control when focus was in the pane,
//   else on the pane's heading; an update never takes focus from elsewhere.
// - The join field is kept, not drawn again, while it is offered: a redraw
//   (a status, a flow step) leaves its text, caret and an IME composition
//   as they are (U03-18, LFCP-03-022). A submit during a composition (Enter
//   that ends it) joins nothing; only Join, or Enter outside one, does.
//   Escape in the field is its Cancel; focus then goes back to "Join with a
//   link…", the control that opened it.
// - The header (UXD-11, A8) is Obsidian's own nav-header pattern: a row of
//   clickable icon buttons, Share, Insert, Join, then "More actions" at the
//   far end. It never changes shape; an action that is blocked or does not
//   apply is drawn disabled (aria-disabled, with its reason in the tooltip,
//   which the host also makes the button's accessible name: "label — reason").
//   Each icon button keeps its label as
//   visually hidden text, so its text is the catalogue's label, as for every
//   other button. Icons, tooltips and the menu come from Obsidian: the
//   renderer takes them as `chrome` and imports nothing from `obsidian`.
// - The body (UXD-11, UX-08) is one card for what the cursor is on: the
//   section's name, a status word with its icon, ONE line of fact, the
//   primary button (`mod-cta`, icon and label) and, beside it, Details. A
//   running flow owns the card (P2): its steps are drawn in it, in the same
//   place. Caveats, times, the server and what a change does are in Details,
//   not here; every action the card and the header do not draw is in the
//   "More actions" menu. Problems the card is not about are listed below it.
// - The title "Shared Tasks" stays in the DOM, visually hidden: it is the
//   focus target when the pane opens (U03-18) and the pane's heading for a
//   screen reader. The tab already shows the name, and at 330 px the room is
//   worth more to the four buttons than to a second copy of it.
// - Narrow panes: everything wraps; colours and spacing are Obsidian's CSS variables.

import type { ActionId } from "../../core/actions/catalog";
import type { HintId } from "../../core/pane/hints";
import { ACTION_ICONS, MORE_ICON } from "../../core/pane/icons";
import type { PaneAction, PaneModel } from "../../core/pane/model";
import { contentHash } from "../../core/projection/guard";

/**
 * What the pane borrows from the host's UI toolkit (Obsidian): icons,
 * tooltips and the actions menu. Tests pass recording stand-ins.
 */
export interface PaneChrome {
  /** Draws the icon `name` (a Lucide name) into `el`. */
  readonly icon: (el: HTMLElement, name: string) => void;
  /** Gives `el` a tooltip with `text`. */
  readonly tooltip: (el: HTMLElement, text: string) => void;
  /**
   * Opens a menu of `items` under `anchor`. Choosing an item runs its action
   * as the pane's own button would (the host checks it again, L2).
   */
  readonly menu: (anchor: HTMLElement, items: readonly PaneAction[]) => void;
}

export interface PaneHandlers {
  readonly action: (id: ActionId) => void;
  readonly chrome: PaneChrome;
  /**
   * A link pasted in the join field and Join chosen (I5), with the optional
   * name on this device (N5); absent: the field is not offered.
   */
  readonly join?: (link: string, name: string) => void;
  /** The flow's own way out (PaneFlowView.dismiss: Cancel, Later, Give up); absent: not offered. */
  readonly dismiss?: () => void;
  /** A row of the section list chosen (its key, D9); absent: rows are not choosable. */
  readonly row?: (key: string) => void;
  /** The key of the row chosen now, marked as such. */
  readonly chosen?: string | null;
  /** A problem row's action (its problem ID, LFCP-03-018); absent: its action runs as `action`. */
  readonly problem?: (problemId: string) => void;
  /** "Hide tip" chosen for the tip shown (LFCP-03-021); absent: the tip has no such button. */
  readonly hideHint?: (id: HintId) => void;
  /** "Show tips again" chosen; absent: not offered. */
  readonly showHints?: () => void;
}

/** The attribute that names a focusable control across redraws. */
const KEY = "data-pane-key";
/** A header button's key prefix: its action may also be drawn below, with words. */
const HEADER_KEY = "header:";

function el<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  return parent.createEl(tag, {
    ...(cls === undefined ? {} : { cls }),
    ...(text === undefined ? {} : { text }),
  });
}

let ids = 0;

/** The join field's form, drawn once while offered: what its submit and Escape run now. */
interface FormHandlers {
  readonly join: (link: string, name: string) => void;
  /** The flow's Cancel; null: none now. */
  readonly cancel: (() => void) | null;
}
const forms = new WeakMap<HTMLFormElement, FormHandlers>();

/**
 * A problem's ID as the DOM carries it: a hash, never the ID itself, which
 * holds a line of the note (a repair's line key). The click handler keeps
 * the ID in its closure; the attribute only names the control across redraws.
 */
export const domKey = (problemId: string): string => contentHash(problemId).slice(0, 16);

function button(
  parent: HTMLElement,
  a: PaneAction,
  h: PaneHandlers,
  cls: string,
  problem?: string,
  /** Draws the action's icon before its label (the card's buttons). */
  withIcon = false,
): HTMLElement {
  const wrap = el(parent, "div", "openlfcp-pane-action");
  const b = el(wrap, "button", cls);
  if (withIcon) {
    const glyph = el(b, "span", "openlfcp-pane-icon");
    glyph.setAttribute("aria-hidden", "true");
    h.chrome.icon(glyph, ACTION_ICONS[a.id]);
  }
  // The label is the button's text (an icon holds none).
  el(b, "span", "openlfcp-pane-button-label", a.label);
  b.type = "button";
  b.setAttribute(KEY, problem === undefined ? `action:${a.id}` : `problem:${domKey(problem)}`);
  b.dataset.action = a.id;
  if (problem !== undefined) b.dataset.problem = domKey(problem);
  if (a.destructive) b.classList.add("mod-warning");
  const run =
    problem !== undefined && h.problem !== undefined
      ? () => h.problem?.(problem)
      : () => h.action(a.id);
  if (a.enabled) b.addEventListener("click", run);
  else {
    b.setAttribute("aria-disabled", "true");
    b.classList.add("is-disabled");
    if (a.reason !== null) {
      const id = `openlfcp-pane-reason-${++ids}`;
      el(wrap, "div", "openlfcp-pane-reason", a.reason).id = id;
      b.setAttribute("aria-describedby", id);
    }
  }
  return b;
}

/** The "…" button's reason when the model offers no menu action. */
export const MENU_EMPTY = "No more actions here.";
export const MORE_LABEL = "More actions";

/**
 * A header icon button (A8): a native button holding the icon and the label
 * as hidden text, so its text is the label. Blocked (A5): aria-disabled and
 * `is-disabled`, still focusable, a click does nothing; the reason is in the
 * tooltip, which the host also gives the button as its accessible name
 * ("label — reason"): no separate description, that would say it twice. The
 * tooltip is the host's, not a `title` attribute.
 */
function iconButton(
  parent: HTMLElement,
  c: PaneChrome,
  o: {
    readonly label: string;
    readonly icon: string;
    readonly key: string;
    readonly enabled: boolean;
    readonly reason: string | null;
    readonly run: (b: HTMLElement) => void;
    readonly action?: ActionId;
    /** The button opens a menu. */
    readonly menu?: boolean;
  },
): HTMLElement {
  const b = el(parent, "button", "clickable-icon nav-action-button openlfcp-pane-icon-button");
  b.type = "button";
  b.setAttribute(KEY, o.key);
  if (o.action !== undefined) b.dataset.action = o.action;
  if (o.menu === true) b.setAttribute("aria-haspopup", "menu");
  const glyph = el(b, "span", "openlfcp-pane-icon");
  glyph.setAttribute("aria-hidden", "true");
  c.icon(glyph, o.icon);
  el(b, "span", "openlfcp-visually-hidden", o.label);
  if (o.enabled) {
    c.tooltip(b, o.label);
    b.addEventListener("click", () => o.run(b));
    return b;
  }
  b.setAttribute("aria-disabled", "true");
  b.classList.add("is-disabled");
  c.tooltip(b, o.reason === null ? o.label : `${o.label} — ${o.reason}`);
  return b;
}

function section(parent: HTMLElement, cls: string, label: string): HTMLElement {
  const s = el(parent, "section", `openlfcp-pane-block ${cls}`);
  s.setAttribute("aria-label", label);
  return s;
}

/**
 * The card (UXD-11): the name of what the cursor is on and its status word
 * with icon, one line of fact, and the actions row: the primary (a `mod-cta`
 * with its icon and label, or in its place why there is none), and beside it
 * Details. A running flow (P2) is drawn in the same card: its target, steps
 * and lines between the fact and the actions, its own way out beside the
 * primary. The share preview, when there is one, is read before the primary.
 */
function drawCard(root: HTMLElement, model: PaneModel, h: PaneHandlers): void {
  const card = model.card;
  const flow = model.flow;
  const c = el(root, "section", "openlfcp-pane-block openlfcp-pane-card");
  c.classList.add(`is-${card.status.tone}`);
  if (card.problem) c.classList.add("is-problem");
  if (flow !== null) c.classList.add("openlfcp-pane-flow");
  c.setAttribute("aria-label", card.title);
  const head = el(c, "div", "openlfcp-pane-card-head");
  el(head, "h3", "openlfcp-pane-heading openlfcp-pane-card-title", card.title);
  const status = el(head, "span", "openlfcp-pane-status-word");
  const glyph = el(status, "span", "openlfcp-pane-icon");
  glyph.setAttribute("aria-hidden", "true");
  h.chrome.icon(glyph, card.status.icon);
  el(status, "span", "openlfcp-pane-status-text", card.status.word);
  if (card.fact !== null) el(c, "div", "openlfcp-pane-fact", card.fact);

  if (flow !== null) {
    if (flow.target !== null) el(c, "div", "openlfcp-pane-line", `Target: ${flow.target}`);
    const ol = el(c, "ol", "openlfcp-pane-steps");
    for (const s of flow.steps) {
      const li = el(ol, "li", `openlfcp-pane-step is-${s.state}`, s.label);
      if (s.state === "current") li.setAttribute("aria-current", "step");
    }
    for (const line of flow.lines) el(c, "div", "openlfcp-pane-line", line);
  }

  if (model.preview.length > 0) {
    const p = section(c, "openlfcp-pane-preview", "What is shared");
    for (const line of model.preview) el(p, "div", "openlfcp-pane-line", line);
  }

  const actions = el(c, "div", "openlfcp-pane-card-actions");
  const primary = el(actions, "div", "openlfcp-pane-primary");
  if (model.primary !== null) button(primary, model.primary, h, "mod-cta", undefined, true);
  else if (model.primaryNone !== null) el(primary, "div", "openlfcp-pane-none", model.primaryNone);
  if (card.secondary !== null)
    button(actions, card.secondary, h, "openlfcp-pane-secondary", undefined, true);
  const dismiss = h.dismiss;
  if (flow !== null && flow.dismiss !== null && dismiss !== undefined) {
    const b = el(actions, "button", "openlfcp-pane-secondary", flow.dismiss);
    b.type = "button";
    b.setAttribute(KEY, "flow-dismiss");
    b.addEventListener("click", () => dismiss());
  }
}

/** Draws `model` into `root`, replacing what was there. */
export function renderPane(root: HTMLElement, model: PaneModel, h: PaneHandlers): void {
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  const hadFocus = active !== null && active !== doc.body && root.contains(active);
  const focusKey = hadFocus ? (active as HTMLElement).closest(`[${KEY}]`)?.getAttribute(KEY) : null;
  // The join field as drawn before, kept in place while it is still offered.
  const kept =
    model.joinField && h.join !== undefined
      ? root.querySelector<HTMLFormElement>(":scope > form.openlfcp-pane-join-form")
      : null;
  // The field appears for the user's own "Join with a link…": the caret goes into it.
  const fieldNew = model.joinField && kept === null;

  for (const child of Array.from(root.childNodes)) if (child !== kept) child.remove();
  root.classList.add("openlfcp-pane");

  const header = el(root, "div", "openlfcp-pane-header nav-header");
  // Before the kept field: moving the header, never the field, keeps its focus.
  if (kept !== null) root.insertBefore(header, kept);
  const title = el(header, "h2", "openlfcp-pane-title openlfcp-visually-hidden", model.title);
  title.tabIndex = -1;
  title.setAttribute(KEY, "title");
  const bar = el(header, "div", "nav-buttons-container openlfcp-pane-toolbar");
  for (const a of model.header)
    iconButton(bar, h.chrome, {
      label: a.label,
      icon: ACTION_ICONS[a.id],
      key: `${HEADER_KEY}${a.id}`,
      enabled: a.enabled,
      reason: a.reason,
      run: () => h.action(a.id),
      action: a.id,
    });
  el(bar, "span", "openlfcp-pane-toolbar-spacer");
  // Everything the header and the card do not draw, destructive actions among it: the host's menu (A1, A8).
  const items = model.menu;
  iconButton(bar, h.chrome, {
    label: MORE_LABEL,
    icon: MORE_ICON,
    key: "menu",
    enabled: items.length > 0,
    reason: items.length > 0 ? null : MENU_EMPTY,
    run: (b) => h.chrome.menu(b, items),
    menu: true,
  });

  const handlers = (join: (link: string, name: string) => void): FormHandlers => ({
    join,
    cancel: model.flow?.dismiss === "Cancel" ? (h.dismiss ?? null) : null,
  });
  if (kept !== null && h.join !== undefined) forms.set(kept, handlers(h.join));
  else if (model.joinField && h.join !== undefined) {
    const form = el(root, "form", "openlfcp-pane-join-form");
    forms.set(form, handlers(h.join));
    const id = `openlfcp-pane-join-${++ids}`;
    const label = el(form, "label", "openlfcp-pane-label", "Paste the invitation link");
    label.htmlFor = id;
    // Masked (I3): the link is a secret; it is pasted, never shown, never kept after Join.
    const input = el(form, "input", "openlfcp-pane-join-input");
    input.id = id;
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "lfcp://join/…";
    input.setAttribute(KEY, "join-input");
    // N5: optional, never a step of its own.
    const nameId = `openlfcp-pane-join-name-${++ids}`;
    const nameLabel = el(form, "label", "openlfcp-pane-label", "Name on this device (optional)");
    nameLabel.htmlFor = nameId;
    const name = el(form, "input", "openlfcp-pane-join-name");
    name.id = nameId;
    name.type = "text";
    name.autocomplete = "off";
    name.placeholder = "The section's own title";
    name.setAttribute(KEY, "join-name");
    const go = el(form, "button", "mod-cta", "Join");
    go.type = "submit";
    go.setAttribute(KEY, "join-submit");
    // IME: Enter that ends a composition is the IME's, not a Join.
    let composing = false;
    form.addEventListener("compositionstart", () => {
      composing = true;
    });
    form.addEventListener("compositionend", () => {
      composing = false;
    });
    form.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.isComposing || composing) return;
      const cancel = forms.get(form)?.cancel ?? null;
      if (cancel === null) return;
      e.preventDefault();
      e.stopPropagation();
      input.value = "";
      cancel();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (composing) return;
      const link = input.value;
      // Out of the page before anything else runs: a redraw keeps no copy of it.
      input.value = "";
      forms.get(form)?.join(link, name.value);
    });
  }

  drawCard(root, model, h);

  // The problem hub (LFCP-03-018): each problem, where it comes from, and its resolver.
  if (model.problems.length > 0) {
    const p = section(root, "openlfcp-pane-problems", "Problems");
    el(p, "h3", "openlfcp-pane-heading", "Problems");
    const ul = el(p, "ul", "openlfcp-pane-rows");
    for (const x of model.problems) {
      const li = el(ul, "li", `openlfcp-pane-problem is-${x.category}`);
      li.dataset.problem = domKey(x.id);
      el(li, "div", "openlfcp-pane-problem-text", x.text);
      el(li, "div", "openlfcp-pane-row-meta", `Where: ${x.source}`);
      if (x.action !== null) button(li, x.action, h, "openlfcp-pane-secondary", x.id);
    }
  }

  if (model.notice !== null) {
    const n = el(root, "div", "openlfcp-pane-notice", model.notice);
    n.setAttribute("role", "status");
  }

  // LFCP-03-021: one short tip for what is offered now; a note, not an alert (no live region).
  const hint = model.hint;
  if (hint !== null) {
    const t = section(root, "openlfcp-pane-hint", "Tip");
    t.dataset.hint = hint.id;
    el(t, "div", "openlfcp-pane-line", hint.text);
    const hide = h.hideHint;
    if (hide !== undefined) {
      const b = el(t, "button", "openlfcp-pane-secondary openlfcp-pane-hint-hide", hint.hide);
      b.type = "button";
      b.setAttribute(KEY, "hint-hide");
      b.addEventListener("click", () => hide(hint.id));
    }
  }

  const list = section(root, "openlfcp-pane-sections", "Shared sections");
  el(list, "h3", "openlfcp-pane-heading", "Shared sections");
  if (model.sections.summary !== null)
    el(list, "div", "openlfcp-pane-line", model.sections.summary);
  for (const g of model.sections.groups) {
    el(list, "h4", "openlfcp-pane-group", g.title);
    const ul = el(list, "ul", "openlfcp-pane-rows");
    for (const r of g.rows) {
      const li = el(ul, "li", "openlfcp-pane-row");
      const pick = h.row;
      // One line: the status icon, the name, and where it is and how it stands on the right.
      const line = <T extends "button" | "div">(parent: HTMLElement, tag: T) => {
        const row = el(parent, tag, "openlfcp-pane-row-label");
        const glyph = el(row, "span", `openlfcp-pane-icon is-${r.tone}`);
        glyph.setAttribute("aria-hidden", "true");
        h.chrome.icon(glyph, r.icon);
        el(row, "span", "openlfcp-pane-row-name", r.label);
        el(row, "span", "openlfcp-pane-row-meta", r.meta);
        return row;
      };
      if (pick === undefined) line(li, "div");
      else {
        // D9: a row is chosen by the user, never by the pane on its own; a native button.
        const b = line(li, "button");
        b.type = "button";
        b.setAttribute(KEY, `row:${r.key}`);
        b.dataset.row = r.key;
        b.setAttribute("aria-pressed", h.chosen === r.key ? "true" : "false");
        if (h.chosen === r.key) li.classList.add("is-chosen");
        b.addEventListener("click", () => pick(r.key));
      }
      if (r.alias !== null) el(li, "div", "openlfcp-pane-row-alias", r.alias);
    }
  }

  if (model.unfinished.length > 0) {
    const u = section(root, "openlfcp-pane-unfinished", "Unfinished");
    el(u, "h3", "openlfcp-pane-heading", "Unfinished");
    const ul = el(u, "ul", "openlfcp-pane-rows");
    for (const x of model.unfinished) el(ul, "li", "openlfcp-pane-row", `${x.title}: ${x.detail}`);
  }

  const show = h.showHints;
  if (model.showHints !== null && show !== undefined) {
    const help = section(root, "openlfcp-pane-help", "Help");
    const b = el(help, "button", "openlfcp-pane-secondary", model.showHints);
    b.type = "button";
    b.setAttribute(KEY, "hints-show");
    b.addEventListener("click", () => show());
  }

  if (fieldNew && hadFocus && focusKey === `${HEADER_KEY}join-with-link`) {
    root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input")?.focus();
  } else if (hadFocus && !(kept?.contains(active) ?? false)) {
    const named = (key: string | null | undefined) =>
      key === null || key === undefined
        ? null
        : root.querySelector<HTMLElement>(`[${KEY}="${key}"]`);
    // The join field gone (Cancel, Escape, Join): back to the control that opened it.
    const opener =
      focusKey?.startsWith("join-") === true ? named(`${HEADER_KEY}join-with-link`) : null;
    (named(focusKey) ?? opener ?? title).focus();
  }
}
