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
import type { MarkdownPostProcessorContext } from "obsidian";
import type { SectionRef } from "../core/sections/grammar";
import { type ParsedSection, parseSections, type SectionNode } from "../core/sections/parser";
import { sectionPresentation } from "../core/sections/presentation";
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
  constructor(readonly badge: HeadingBadge) {
    super();
  }
  override eq(other: BadgeWidget): boolean {
    return JSON.stringify(other.badge) === JSON.stringify(this.badge);
  }
  toDOM(view: EditorView): HTMLElement {
    const el = view.dom.ownerDocument.createElement("span");
    renderBadge(el, this.badge);
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
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

function build(state: EditorState, statuses: ReadonlyMap<string, StatusView>): DecorationSet {
  const text = state.doc.toString();
  if (!text.includes("lfcp-section")) return Decoration.none;
  const sections: readonly ParsedSection[] = parseSections(text).sections;
  if (sections.length === 0) return Decoration.none;
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
      Decoration.widget({ widget: new BadgeWidget(badgeOf(s.heading.title, view)), side: 1 }).range(
        heading.to,
      ),
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
export function sectionStatusExtension(initial: () => ReadonlyMap<string, StatusView>): {
  readonly extension: Extension;
  readonly views: ReadonlySet<EditorView>;
} {
  const views = new Set<EditorView>();
  const field = StateField.define<Value>({
    create: (state) => {
      const statuses = initial();
      return { statuses, deco: build(state, statuses) };
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
      return changed ? { statuses, deco: build(tr.state, statuses) } : value;
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

  constructor(private readonly status: (key: string) => StatusView | undefined) {}

  render(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
    if (heading === null) return;
    const info = ctx.getSectionInfo(el);
    if (info === null || !info.text.includes("lfcp-section")) return;
    const section = parseSections(info.text).sections.find(
      (s) => s.heading.line === info.lineStart,
    );
    if (section === undefined) return;
    const key = sectionKey(section.ref);
    const badge = heading.ownerDocument.createElement("span");
    renderBadge(badge, badgeOf(section.heading.title, this.status(key)));
    badge.dataset.title = section.heading.title;
    badge.dataset.section = key;
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
