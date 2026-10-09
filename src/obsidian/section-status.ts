// Section status in the editor (LFCP-02-058, OBSIDIAN-SYNC-INDICATORS-01
// §6–§9, decision M8): after each shared section's heading, the project's
// double tick (shared) and, when not quiet, a separate sync icon; inside
// the section, a cue only on rows with pending work or a problem, carried
// by a folded row for what it hides. The same badge in Reading view.
//
// UI only: widgets and DOM, never the note's text or its history. The
// statuses come from the host (SectionsHost) as an effect; this file only
// lays them out.

import { foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { toBase64url } from "@openlfcp/core";
import { displayTooltip, type MarkdownPostProcessorContext } from "obsidian";
import type { SectionRef } from "../core/sections/grammar";
import { type ParsedSection, parseSections, type SectionNode } from "../core/sections/parser";
import { sectionPresentation } from "../core/sections/presentation";
import { blockingSignature, nextProblem, type ProblemAt } from "../core/status/a11y";
import {
  type HeadingBadge,
  headingBadge,
  type RowCue,
  type RowNode,
  rowCues,
  type SyncIcon,
} from "../core/status/badge";
import type { StatusView } from "../core/status/reducer";

/** A section's key: its Resource (base64url) and section ID. */
export const sectionKey = (ref: SectionRef): string =>
  `${toBase64url(ref.resourceId)}#${ref.sectionId}`;

/** The statuses of every known section, by key (replaces the previous ones). */
export const setSectionStatuses = StateEffect.define<ReadonlyMap<string, StatusView>>();

const SVG = "http://www.w3.org/2000/svg";

/** The project mark's two ticks (marketing/brand/logo, 64 × 64), in the text color. */
const MARK = ["M14 34 L22 42 L38 22", "M26 34 L34 42 L50 22"];

/** Each sync icon, a distinct shape (§7: never color alone), 16 × 16. */
const ICONS: Readonly<Record<SyncIcon, readonly string[]>> = {
  loading: ["M8 2 A6 6 0 1 1 2 8"],
  editing: ["M8 8 m-2.5 0 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0"],
  pending: ["M8 2 A6 6 0 1 0 8 14 A6 6 0 1 0 8 2", "M8 5 L8 8 L10.5 9.5"],
  receiving: ["M8 2 L8 12", "M4 8.5 L8 12.5 L12 8.5"],
  offline: ["M3 11 A4 4 0 0 1 5 4.5 A5 5 0 0 1 13 6 A3 3 0 0 1 12 11 Z", "M2 2 L14 14"],
  unknown: ["M5.5 6 A2.5 2.5 0 1 1 8 8.5 L8 10", "M8 12.5 L8 13"],
  attention: ["M8 2 L14.5 13.5 L1.5 13.5 Z", "M8 6.5 L8 9.5", "M8 11.5 L8 12"],
  error: ["M5 2 L11 2 L14 5 L14 11 L11 14 L5 14 L2 11 L2 5 Z", "M6 6 L10 10", "M10 6 L6 10"],
};

function svg(doc: Document, viewBox: string, paths: readonly string[], width: string): SVGElement {
  const el = doc.createElementNS(SVG, "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("focusable", "false");
  paths.forEach((d, i) => {
    const p = doc.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", width);
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    // The mark's first tick is the lighter echo (the logo's darker/lighter pair).
    if (paths === MARK && i === 0) p.setAttribute("stroke-opacity", "0.55");
    el.appendChild(p);
  });
  return el;
}

/** Fills `el` as the badge: the shared mark, then the sync icon when there is one. */
export function renderBadge(el: HTMLElement, badge: HeadingBadge): void {
  const doc = el.ownerDocument;
  el.replaceChildren();
  el.className = "openlfcp-status";
  el.dataset.lfcpUi = "status";
  el.dataset.state = badge.state;
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", badge.accessibleName);
  el.dataset.tooltip = badge.tooltip;
  el.setAttribute("contenteditable", "false");
  const mark = svg(doc, "0 0 64 64", MARK, "7");
  mark.classList.add("openlfcp-status-mark");
  el.appendChild(mark);
  const slot = doc.createElement("span");
  slot.className = "openlfcp-status-icon";
  if (badge.icon !== null) {
    slot.dataset.icon = badge.icon;
    slot.appendChild(svg(doc, "0 0 16 16", ICONS[badge.icon], "1.6"));
  }
  el.appendChild(slot);
}

/** Opens a section's details card (LFCP-02-059): its key and its title as the note shows it. */
export type OpenCard = (key: string, title: string) => void;

/**
 * Makes a badge interactive, once: the short tooltip on hover and focus,
 * the details card on click, Enter or Space. It reads the badge's data at
 * event time, so a redraw in place keeps it working.
 */
export function attachBadge(el: HTMLElement, open: OpenCard): void {
  const show = () => {
    const tip = el.dataset.tooltip;
    if (tip !== undefined && tip !== "") displayTooltip(el, tip, { placement: "top" });
  };
  const activate = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    open(el.dataset.section ?? "", el.dataset.title ?? "");
  };
  el.addEventListener("mouseenter", show);
  el.addEventListener("focus", show);
  // A press on the badge must not move the editor's cursor.
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", activate);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") activate(e);
  });
}

const CUE_LABEL: Readonly<Record<RowCue, string>> = {
  pending: "Local update waiting",
  attention: "Needs attention",
};

function renderCue(el: HTMLElement, cue: RowCue): void {
  el.className = "openlfcp-row-cue";
  el.dataset.lfcpUi = "row-cue";
  el.dataset.cue = cue;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", CUE_LABEL[cue]);
  el.setAttribute("contenteditable", "false");
  el.appendChild(
    svg(el.ownerDocument, "0 0 16 16", ICONS[cue === "pending" ? "pending" : "attention"], "1.6"),
  );
}

/** Before the host has a status: loading, never current (SI01). */
const LOADING = (title: string): HeadingBadge => ({
  state: "LOADING",
  icon: "loading",
  tooltip: "Loading shared section",
  accessibleName: `Shared section ${title}, loading shared section, open details`,
});

export const badgeOf = (title: string, view: StatusView | undefined): HeadingBadge =>
  view === undefined ? LOADING(title) : headingBadge(title, view);

class BadgeWidget extends WidgetType {
  constructor(
    readonly badge: HeadingBadge,
    readonly key: string,
    readonly title: string,
    readonly open: OpenCard,
  ) {
    super();
  }
  override eq(other: BadgeWidget): boolean {
    return (
      other.key === this.key &&
      other.title === this.title &&
      JSON.stringify(other.badge) === JSON.stringify(this.badge)
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const el = view.dom.ownerDocument.createElement("span");
    renderBadge(el, this.badge);
    el.dataset.section = this.key;
    el.dataset.title = this.title;
    attachBadge(el, this.open);
    return el;
  }
  /** The badge handles its own events; the editor leaves them alone. */
  override ignoreEvent(): boolean {
    return true;
  }
}

class CueWidget extends WidgetType {
  constructor(readonly cue: RowCue) {
    super();
  }
  override eq(other: CueWidget): boolean {
    return other.cue === this.cue;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = view.dom.ownerDocument.createElement("span");
    renderCue(el, this.cue);
    return el;
  }
}

/** A section's rows: each node on its first line that is not a binding line. */
function rows(nodes: readonly SectionNode[], binding: ReadonlySet<number>): RowNode[] {
  return nodes.map((n) => {
    let line = n.lines.from;
    while (binding.has(line) && line < n.lines.to) line++;
    return { id: n.id ?? "", line, children: rows(n.children, binding) };
  });
}

function build(
  state: EditorState,
  statuses: ReadonlyMap<string, StatusView>,
  open: OpenCard,
): DecorationSet {
  const text = state.doc.toString();
  if (!text.includes("lfcp-section")) return Decoration.none;
  const scan = parseSections(text);
  const sections: readonly ParsedSection[] = scan.sections;
  if (sections.length === 0 && scan.damaged.length === 0) return Decoration.none;
  const binding = new Set(sectionPresentation(text).bindingLines);
  const folds: { header: number; from: number; to: number }[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    folds.push({ header: state.doc.lineAt(from).number - 1, from, to });
  });
  const foldedAt = (line: number): number | null => {
    if (line + 1 > state.doc.lines) return null;
    const at = state.doc.line(line + 1).from;
    return folds.find((f) => at > f.from && at <= f.to)?.header ?? null;
  };
  const out = [];
  for (const s of sections) {
    const view = statuses.get(sectionKey(s.ref));
    const heading = state.doc.line(s.heading.line + 1);
    out.push(
      Decoration.widget({
        widget: new BadgeWidget(
          badgeOf(s.heading.title, view),
          sectionKey(s.ref),
          s.heading.title,
          open,
        ),
        side: 1,
      }).range(heading.to),
    );
    if (view === undefined) continue;
    for (const [line, cue] of rowCues(view, rows(s.nodes, binding), foldedAt)) {
      if (line + 1 > state.doc.lines) continue;
      out.push(
        Decoration.widget({ widget: new CueWidget(cue), side: 1 }).range(
          state.doc.line(line + 1).to,
        ),
      );
    }
  }
  // C17: a copy with a damaged boundary keeps its badge on its heading (its status says why).
  for (const d of scan.damaged) {
    if (d.heading === null) continue;
    out.push(
      Decoration.widget({
        widget: new BadgeWidget(
          badgeOf(d.heading.title, statuses.get(sectionKey(d.ref))),
          sectionKey(d.ref),
          d.heading.title,
          open,
        ),
        side: 1,
      }).range(state.doc.line(d.heading.line + 1).to),
    );
  }
  return Decoration.set(out, true);
}

interface Value {
  readonly statuses: ReadonlyMap<string, StatusView>;
  readonly deco: DecorationSet;
}

/**
 * The editor extension and its live editors (to send them new statuses);
 * `initial` gives the statuses known when an editor opens.
 */
export function sectionStatusExtension(
  initial: () => ReadonlyMap<string, StatusView>,
  open: OpenCard,
): {
  readonly extension: Extension;
  readonly views: ReadonlySet<EditorView>;
} {
  const views = new Set<EditorView>();
  const field = StateField.define<Value>({
    create: (state) => {
      const statuses = initial();
      return { statuses, deco: build(state, statuses, open) };
    },
    update(value, tr) {
      let statuses = value.statuses;
      let changed = tr.docChanged;
      for (const e of tr.effects) {
        if (e.is(setSectionStatuses)) {
          statuses = e.value;
          changed = true;
        } else if (e.is(foldEffect) || e.is(unfoldEffect)) changed = true;
      }
      return changed ? { statuses, deco: build(tr.state, statuses, open) } : value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
  const registry = ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        views.add(view);
      }
      destroy(): void {
        views.delete(this.view);
      }
    },
  );
  return { extension: [field, registry], views };
}

/**
 * Reading view: the same badge after a section's heading. The rendered
 * badges are kept by section key so a status change updates them in place.
 */
export class ReadingBadges {
  readonly #rendered = new Map<string, Set<HTMLElement>>();

  constructor(
    private readonly status: (key: string) => StatusView | undefined,
    private readonly open: OpenCard,
  ) {}

  render(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
    if (heading === null) return;
    const info = ctx.getSectionInfo(el);
    if (info === null || !info.text.includes("lfcp-section")) return;
    const scan = parseSections(info.text);
    // C17: a copy with a damaged boundary keeps its badge too.
    const section =
      scan.sections
        .map((x) => ({ ref: x.ref, line: x.heading.line, title: x.heading.title }))
        .find((x) => x.line === info.lineStart) ??
      scan.damaged
        .map((x) => ({ ref: x.ref, line: x.heading?.line, title: x.heading?.title ?? "" }))
        .find((x) => x.line === info.lineStart);
    if (section === undefined) return;
    const key = sectionKey(section.ref);
    const badge = heading.ownerDocument.createElement("span");
    renderBadge(badge, badgeOf(section.title, this.status(key)));
    badge.dataset.title = section.title;
    badge.dataset.section = key;
    attachBadge(badge, this.open);
    heading.appendChild(badge);
    this.#rendered.set(key, (this.#rendered.get(key) ?? new Set()).add(badge));
  }

  /** New statuses: every rendered badge still in a document is redrawn. */
  update(): void {
    for (const [key, badges] of this.#rendered)
      for (const badge of [...badges]) {
        if (!badge.isConnected) {
          badges.delete(badge);
          continue;
        }
        renderBadge(badge, badgeOf(badge.dataset.title ?? "", this.status(key)));
      }
  }
}

/**
 * The shared section a line is in (heading to end marker): its key and
 * title. A copy with a damaged boundary runs from its heading (or start
 * marker) to the end of the note, as the parser claims it (C17, 064).
 */
export function sectionAtLine(
  text: string,
  line: number,
): { readonly key: string; readonly title: string } | null {
  const scan = parseSections(text);
  const s = scan.sections.find((x) => line >= x.heading.line && line <= x.endLine);
  if (s !== undefined) return { key: sectionKey(s.ref), title: s.heading.title };
  const d = [...scan.damaged].reverse().find((x) => line >= (x.heading?.line ?? x.startLine));
  return d === undefined ? null : { key: sectionKey(d.ref), title: d.heading?.title ?? "" };
}

/**
 * The note's problems, one line each (LFCP-02-064): every row needing
 * attention, folded or not, and the heading of a section needing attention
 * that no row explains. Reached one at a time by a command, never as Tab stops.
 */
export function sectionProblems(
  text: string,
  statuses: ReadonlyMap<string, StatusView>,
): ProblemAt[] {
  if (!text.includes("lfcp-section")) return [];
  const binding = new Set(sectionPresentation(text).bindingLines);
  const out: ProblemAt[] = [];
  for (const s of parseSections(text).sections) {
    const view = statuses.get(sectionKey(s.ref));
    if (view === undefined) continue;
    const lines = [...rowCues(view, rows(s.nodes, binding))]
      .filter(([, cue]) => cue === "attention")
      .map(([line]) => line);
    if (lines.length === 0 && blockingSignature(view) !== null) lines.push(s.heading.line);
    for (const line of lines) out.push({ line, title: s.heading.title });
  }
  // A copy with a damaged boundary is a problem whatever its section's status (C17).
  for (const d of parseSections(text).damaged)
    out.push({ line: d.heading?.line ?? d.startLine, title: d.heading?.title ?? "" });
  return out.sort((a, b) => a.line - b.line);
}

/** Moves the cursor to a line, unfolding what hides it, and scrolls it into view. */
export function revealLine(view: EditorView, line: number): void {
  const pos = view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from;
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    if (pos > from && pos <= to) effects.push(unfoldEffect.of({ from, to }));
  });
  view.dispatch({ effects, selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

/**
 * "Go to next shared section problem" in an editor (LFCP-02-064, UX09): the
 * next problem after the cursor, unfolded if a fold hides it. Returns what
 * to say once, and how many problems there are.
 */
export function goToNextProblem(
  view: EditorView | undefined,
  statuses: ReadonlyMap<string, StatusView>,
): { readonly text: string; readonly found: number } {
  const found =
    view === undefined
      ? null
      : nextProblem(
          sectionProblems(view.state.doc.toString(), statuses),
          view.state.doc.lineAt(view.state.selection.main.head).number - 1,
        );
  if (view === undefined || found === null)
    return { text: "No shared section problems in this note.", found: 0 };
  revealLine(view, found.at.line);
  return {
    text: `Problem ${found.index} of ${found.total}, in shared section ${found.at.title}, line ${found.at.line + 1}. Open its details to resolve it.`,
    found: found.total,
  };
}
