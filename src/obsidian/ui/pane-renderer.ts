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
// - Narrow panes: everything wraps; colours and spacing are Obsidian's CSS variables.

import type { ActionId } from "../../core/actions/catalog";
import type { PaneAction, PaneModel } from "../../core/pane/model";
import { contentHash } from "../../core/projection/guard";

export interface PaneHandlers {
  readonly action: (id: ActionId) => void;
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
}

/** The attribute that names a focusable control across redraws. */
const KEY = "data-pane-key";

function el<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = parent.ownerDocument.createElement(tag);
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

let ids = 0;

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
): HTMLElement {
  const wrap = el(parent, "div", "openlfcp-pane-action");
  const b = el(wrap, "button", cls, a.label);
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

function section(parent: HTMLElement, cls: string, label: string): HTMLElement {
  const s = el(parent, "section", `openlfcp-pane-block ${cls}`);
  s.setAttribute("aria-label", label);
  return s;
}

/** Draws `model` into `root`, replacing what was there. */
export function renderPane(root: HTMLElement, model: PaneModel, h: PaneHandlers): void {
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  const hadFocus = active !== null && active !== doc.body && root.contains(active);
  const focusKey = hadFocus ? (active as HTMLElement).closest(`[${KEY}]`)?.getAttribute(KEY) : null;
  // The menu stays as the user left it: a redraw does not close it under them.
  const menuOpen =
    root.querySelector<HTMLDetailsElement>("details.openlfcp-pane-menu")?.open === true;
  const joinDraft =
    root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input")?.value ?? "";
  const nameDraft =
    root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-name")?.value ?? "";
  // The field appears for the user's own "Join with a link…": the caret goes into it.
  const fieldNew = model.joinField && root.querySelector("form.openlfcp-pane-join-form") === null;

  root.replaceChildren();
  root.classList.add("openlfcp-pane");

  const header = el(root, "div", "openlfcp-pane-header");
  const title = el(header, "h2", "openlfcp-pane-title", model.title);
  title.tabIndex = -1;
  title.setAttribute(KEY, "title");
  button(header, model.join, h, "openlfcp-pane-join");

  if (model.joinField && h.join !== undefined) {
    const join = h.join;
    const form = el(root, "form", "openlfcp-pane-join-form");
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
    input.value = joinDraft;
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
    name.value = nameDraft;
    name.setAttribute(KEY, "join-name");
    const go = el(form, "button", "mod-cta", "Join");
    go.type = "submit";
    go.setAttribute(KEY, "join-submit");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const link = input.value;
      // Out of the page before anything else runs: a redraw keeps no copy of it.
      input.value = "";
      join(link, name.value);
    });
  }

  const ctx = section(root, "openlfcp-pane-context", "Current context");
  el(ctx, "h3", "openlfcp-pane-heading", model.context.heading);
  for (const line of model.context.lines) el(ctx, "div", "openlfcp-pane-line", line);

  const flow = model.flow;
  if (flow !== null) {
    const f = section(root, "openlfcp-pane-flow", flow.title);
    el(f, "h3", "openlfcp-pane-heading", flow.title);
    if (flow.target !== null) el(f, "div", "openlfcp-pane-line", `Target: ${flow.target}`);
    const ol = el(f, "ol", "openlfcp-pane-steps");
    for (const s of flow.steps) {
      const li = el(ol, "li", `openlfcp-pane-step is-${s.state}`, s.label);
      if (s.state === "current") li.setAttribute("aria-current", "step");
    }
    for (const line of flow.lines) el(f, "div", "openlfcp-pane-line", line);
    const dismiss = h.dismiss;
    if (flow.dismiss !== null && dismiss !== undefined) {
      const b = el(f, "button", "openlfcp-pane-secondary", flow.dismiss);
      b.type = "button";
      b.setAttribute(KEY, "flow-dismiss");
      b.addEventListener("click", () => dismiss());
    }
  }

  if (model.status.length > 0) {
    const ul = el(root, "ul", "openlfcp-pane-status");
    ul.setAttribute("aria-label", "Status");
    for (const l of model.status) el(ul, "li", `openlfcp-pane-fact is-${l.tone}`, l.text);
  }

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

  if (model.preview.length > 0) {
    const p = section(root, "openlfcp-pane-preview", "What is shared");
    for (const line of model.preview) el(p, "div", "openlfcp-pane-line", line);
  }

  const primary = el(root, "div", "openlfcp-pane-primary");
  if (model.primary !== null) button(primary, model.primary, h, "mod-cta");
  else if (model.primaryNone !== null) el(primary, "div", "openlfcp-pane-none", model.primaryNone);

  if (model.notice !== null) {
    const n = el(root, "div", "openlfcp-pane-notice", model.notice);
    n.setAttribute("role", "status");
  }

  if (model.secondary.length > 0) {
    const s = el(root, "div", "openlfcp-pane-actions");
    for (const a of model.secondary) button(s, a, h, "openlfcp-pane-secondary");
  }

  if (model.menu.length > 0) {
    const d = el(root, "details", "openlfcp-pane-menu");
    d.open = menuOpen;
    const summary = el(d, "summary", undefined, "More actions");
    summary.setAttribute(KEY, "menu");
    for (const a of model.menu) button(d, a, h, "openlfcp-pane-secondary");
  }

  // C6, N-05: what deleting, removing the copy and detaching do, before the user acts.
  if (model.effects.length > 0) {
    const e = section(root, "openlfcp-pane-effects", "What changes do here");
    for (const line of model.effects) el(e, "div", "openlfcp-pane-line", line);
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
      if (pick === undefined) el(li, "div", "openlfcp-pane-row-label", r.label);
      else {
        // D9: a row is chosen by the user, never by the pane on its own; a native button.
        const b = el(li, "button", "openlfcp-pane-row-label", r.label);
        b.type = "button";
        b.setAttribute(KEY, `row:${r.key}`);
        b.dataset.row = r.key;
        b.setAttribute("aria-pressed", h.chosen === r.key ? "true" : "false");
        if (h.chosen === r.key) li.classList.add("is-chosen");
        b.addEventListener("click", () => pick(r.key));
      }
      if (r.alias !== null) el(li, "div", "openlfcp-pane-row-alias", r.alias);
      el(li, "div", "openlfcp-pane-row-meta", `${r.status} · ${r.places}`);
    }
  }

  if (model.unfinished.length > 0) {
    const u = section(root, "openlfcp-pane-unfinished", "Unfinished");
    el(u, "h3", "openlfcp-pane-heading", "Unfinished");
    const ul = el(u, "ul", "openlfcp-pane-rows");
    for (const x of model.unfinished) el(ul, "li", "openlfcp-pane-row", `${x.title}: ${x.detail}`);
  }

  if (fieldNew && hadFocus && focusKey === "action:join-with-link") {
    root.querySelector<HTMLInputElement>("input.openlfcp-pane-join-input")?.focus();
  } else if (hadFocus) {
    const again =
      focusKey === null || focusKey === undefined
        ? null
        : root.querySelector<HTMLElement>(`[${KEY}="${focusKey}"]`);
    (again ?? title).focus();
  }
}
