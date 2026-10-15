// The Shared Tasks pane (LFCP-03-012, F-01, F-02; U03-01, U03-20): one
// native ItemView per workspace. Its entries (the ribbon icon, the "Open
// Shared Tasks pane" command, the section card's link and the editor
// menu) all reveal the same leaf (openSharedTasksPane); none opens a second.
//
// It draws the pane's view model (core/pane/model.ts) with the shared
// renderer (pane-renderer.ts) from the host's facts (core/pane/host-facts.ts)
// and runs every button through the action dispatcher (surface "pane").
// It decides nothing itself. It keeps only the pane's own state: the flow
// it holds (P2: a running flow keeps the current area until it ends) and
// the section chosen in the list (D9).
//
// L2: a click is checked against the facts as they are at the click. The
// action must still be enabled and act on the same note, section and flow
// as the button that was drawn; otherwise the pane redraws and runs
// nothing (P3: a revocation, offline or a changed target disables at once).
// A change of a section's status or of a flow redraws at once, not
// coalesced. L1: while the pane is not shown (a collapsed sidebar, another
// tab), it neither reads nor draws; it draws once it is shown again.
//
// Lifecycle: every subscription (workspace and vault events, the registry
// view, the section statuses, the editors' cursor) is taken in onOpen and
// given back in onClose, and again on the Component's unload, whichever
// comes first; giving back twice is harmless. A redraw is coalesced, and a
// callback that arrives after close (a timer, a late event, a button of a
// closed pane) is dropped by its generation. Closing the pane cancels no
// operation: the flows it started keep their own journals.
//
// T1: an idle pane follows the last active Markdown note; focus moving into
// the pane does not change it.
//
// U03-18 (LFCP-03-022): its entries are the user's own (a command, the
// ribbon, a menu, the card's link), so opening the pane puts focus on its
// heading, from where Tab reaches every control; a redraw never takes focus.

import {
  type EventRef,
  type Events,
  ItemView,
  MarkdownView,
  type Workspace,
  type WorkspaceLeaf,
} from "obsidian";
import type { ActionId } from "../../core/actions/catalog";
import type { ActionRequest } from "../../core/actions/dispatcher";
import type { HintId } from "../../core/pane/hints";
import type { PaneModel } from "../../core/pane/model";
import { renderPane } from "./pane-renderer";

export const PANE_VIEW = "shared-tasks-pane";
export const PANE_TITLE = "Shared Tasks";
/** The ribbon's and the tab's icon (Lucide). */
export const PANE_ICON = "list-checks";
export const OPEN_PANE = "Open Shared Tasks pane";

/**
 * A source of change: subscribes, and returns how to unsubscribe. `urgent`:
 * a fact that may disable an action shown now (P3), drawn at once.
 */
export type PaneSource = (changed: (urgent?: boolean) => void) => () => void;

/** The pane's own state: the flow it holds and the section chosen in its list. */
export interface PaneUi {
  readonly pinned: number | null;
  readonly chosen: string | null;
}

/** One drawing of the pane, from one reading of the host's facts. */
export interface PaneSnapshot {
  readonly model: PaneModel;
  /** What a click of `id` hands the dispatcher. */
  request(id: ActionId): ActionRequest;
  /** What `id` acts on: a click compares the drawn one with the one now (L2). */
  identity(id: ActionId): string;
  /** What a problem row's action hands the dispatcher (LFCP-03-018); null: no such row. */
  problemRequest?(problemId: string): ActionRequest | null;
  /** The flow this drawing holds. */
  readonly pinned: number | null;
  /** The join flow this drawing shows (its generation), or null (LFCP-03-015). */
  readonly join?: number | null;
}

/** The pane's join field and the join flow's way out (LFCP-03-015). */
export interface PaneJoinPort {
  /** Join chosen with a pasted link (I5) and an optional name (N5). */
  submit(link: string, name: string): void;
  /** Cancel, Later or Give up, for the join flow `generation` as it was drawn. */
  dismiss(generation: number): void;
}

/** The pane's tips (LFCP-03-021): hidden and shown again in this vault's settings. */
export interface PaneHintsPort {
  /** "Hide tip": this tip stays hidden in this vault until "Show tips again". */
  hide(id: HintId): void;
  /** "Show tips again": every hidden tip may show again. */
  reset(): void;
}

/** What the pane reads and runs, from the plugin. */
export interface PaneHostPort {
  /** The pane for the note in `target` (null: no Markdown note open), read now. */
  snapshot(target: MarkdownView | null, ui: PaneUi): PaneSnapshot;
  /** Runs an action through the dispatcher, from the pane. */
  run(id: ActionId, request: ActionRequest): Promise<void>;
  /** The host's change sources: the registry view, the statuses, the flows, the editors' cursor. */
  readonly sources: readonly PaneSource[];
  /** The join field's port; absent: no field is offered. */
  readonly join?: PaneJoinPort;
  /** The tips' port; absent: tips show without "Hide tip" and "Show tips again". */
  readonly hints?: PaneHintsPort;
}

/** Every action a drawing shows, enabled or not. */
function actionsOf(m: PaneModel): PaneModel["secondary"] {
  return [m.join, ...(m.primary === null ? [] : [m.primary]), ...m.secondary, ...m.menu];
}

/** Redraws are coalesced over this many milliseconds (a caret event is not a redraw). */
const COALESCE_MS = 100;

export class SharedTasksView extends ItemView {
  /** Bumped on every open and close: a callback of an earlier one does nothing. */
  #generation = 0;
  #off: (() => void)[] = [];
  #timer: number | null = null;
  #root: HTMLElement | null = null;
  /** The last active Markdown view (T1). */
  #target: MarkdownView | null = null;
  /** The flow the pane holds (P2) and the section chosen in its list (D9). */
  #pinned: number | null = null;
  #chosen: string | null = null;
  /** A change came while the pane was not shown: it draws once shown (L1). */
  #stale = false;
  /** How many drawings this pane made (tests: none while hidden). */
  drawings = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly port: PaneHostPort,
  ) {
    super(leaf);
    // Unload without a close (the plugin goes away) gives everything back too.
    this.register(() => this.#release());
  }

  override getViewType(): string {
    return PANE_VIEW;
  }

  override getDisplayText(): string {
    return PANE_TITLE;
  }

  override getIcon(): string {
    return PANE_ICON;
  }

  /** How many subscriptions this pane holds now (tests: none after close). */
  get subscriptions(): number {
    return this.#off.length;
  }

  override async onOpen(): Promise<void> {
    this.#release();
    const generation = ++this.#generation;
    const ws = this.app.workspace;
    this.#target = currentMarkdown(ws);
    const vault = this.app.vault;
    const changed = (urgent = false) =>
      urgent ? this.#now(generation) : this.#schedule(generation);
    const take = (from: Events, ref: EventRef) => this.#off.push(() => from.offref(ref));
    take(
      ws,
      ws.on("active-leaf-change", (leaf) => {
        // Focus in the pane (or any other view) keeps the last note (T1).
        if (leaf?.view instanceof MarkdownView) this.#target = leaf.view;
        changed();
      }),
    );
    // A note opened, a mode switched or a leaf closed (a sidebar shown again); an edit;
    // a note renamed or deleted: the target may be another one, at once (P3).
    take(
      ws,
      ws.on("file-open", () => changed()),
    );
    take(
      ws,
      ws.on("layout-change", () => changed()),
    );
    take(
      ws,
      ws.on("editor-change", () => changed()),
    );
    take(
      vault,
      vault.on("rename", () => changed(true)),
    );
    take(
      vault,
      vault.on("delete", () => changed(true)),
    );
    for (const subscribe of this.port.sources) this.#off.push(subscribe(changed));
    const root = this.contentEl;
    root.replaceChildren();
    this.#root = root.ownerDocument.createElement("div");
    root.appendChild(this.#root);
    // Not shown yet (restored in a collapsed sidebar): drawn once it is (L1).
    this.render();
  }

  /** Shown again or resized (a sidebar expanded): what changed while hidden is drawn now (L1). */
  override onResize(): void {
    if (this.#stale) this.render();
  }

  override async onClose(): Promise<void> {
    this.#release();
    this.contentEl.replaceChildren();
    this.#root = null;
    this.#target = null;
    this.#pinned = null;
    this.#chosen = null;
  }

  /** Focus on the pane's heading (an entry opened it); drawn first if a change waits (L1). */
  focusHeading(): void {
    if (this.#stale) this.render();
    this.#root?.querySelector<HTMLElement>('[data-pane-key="title"]')?.focus();
  }

  /** Draws the pane now from the host's facts; while it is not shown, only notes that it must (L1). */
  render(): void {
    if (this.#root === null) return;
    if (!this.#visible()) {
      this.#stale = true;
      return;
    }
    this.#draw();
  }

  #draw(): void {
    const root = this.#root;
    if (root === null) return;
    this.#stale = false;
    this.drawings++;
    const generation = this.#generation;
    const drawn = this.port.snapshot(this.#liveTarget(), this.#ui());
    this.#pinned = drawn.pinned;
    const join = this.port.join;
    const joinGeneration = drawn.join ?? null;
    const hints = this.port.hints;
    renderPane(root, drawn.model, {
      action: (id) => this.#click(generation, drawn, id),
      ...(join === undefined
        ? {}
        : {
            // The link goes straight to the join flow; the pane keeps no copy of it.
            join: (link: string, name: string) => {
              if (generation === this.#generation) join.submit(link, name);
            },
            dismiss: () => {
              if (generation === this.#generation && joinGeneration !== null)
                join.dismiss(joinGeneration);
            },
          }),
      row: (key) => {
        if (generation !== this.#generation) return;
        this.#chosen = key;
        this.render();
      },
      chosen: this.#chosen,
      problem: (problemId) => this.#clickProblem(generation, drawn, problemId),
      ...(hints === undefined
        ? {}
        : {
            hideHint: (id: HintId) => {
              if (generation === this.#generation) hints.hide(id);
            },
            showHints: () => {
              if (generation === this.#generation) hints.reset();
            },
          }),
    });
  }

  /**
   * A click on a problem row's action (LFCP-03-018, L2): run only when the
   * facts now still have that problem with the same action, enabled; else
   * draw what is true now and run nothing. The request is the drawn one: a
   * repair carries the revision the user saw, and the executor parses the
   * note again before anything.
   */
  #clickProblem(generation: number, drawn: PaneSnapshot, problemId: string): void {
    if (generation !== this.#generation) return;
    const now = this.port.snapshot(this.#liveTarget(), this.#ui());
    const was = drawn.model.problems.find((p) => p.id === problemId);
    const is = now.model.problems.find((p) => p.id === problemId);
    const request = drawn.problemRequest?.(problemId) ?? null;
    if (
      was === undefined ||
      was.action === null ||
      is?.action?.enabled !== true ||
      is.action.id !== was.action.id ||
      request === null
    ) {
      this.render();
      return;
    }
    void this.port.run(is.action.id, request);
  }

  #ui(): PaneUi {
    return { pinned: this.#pinned, chosen: this.#chosen };
  }

  /**
   * A click on action `id` of drawing `drawn` (L2): run only when the facts
   * now still offer it, enabled, on the same note, section and flow; else
   * draw what is true now and run nothing.
   */
  #click(generation: number, drawn: PaneSnapshot, id: ActionId): void {
    // A button of a pane drawn before a close does nothing.
    if (generation !== this.#generation) return;
    const now = this.port.snapshot(this.#liveTarget(), this.#ui());
    const offered = actionsOf(now.model).find((a) => a.id === id);
    if (offered?.enabled !== true || now.identity(id) !== drawn.identity(id)) {
      this.render();
      return;
    }
    void this.port.run(id, now.request(id));
  }

  /** Draws now, for a change that may disable what is shown (P3). */
  #now(generation: number): void {
    if (generation !== this.#generation) return;
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
    this.render();
  }

  #schedule(generation: number): void {
    if (generation !== this.#generation || this.#timer !== null) return;
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      if (generation === this.#generation) this.render();
    }, COALESCE_MS);
  }

  /** Whether the pane is on screen: not in a collapsed sidebar, not behind another tab. */
  #visible(): boolean {
    const root = (this.leaf as { getRoot?: () => unknown }).getRoot?.() as
      | { collapsed?: boolean }
      | undefined;
    if (root?.collapsed === true) return false;
    const el = (this as { containerEl?: HTMLElement & { isShown?: () => boolean } }).containerEl;
    return typeof el?.isShown !== "function" || el.isShown();
  }

  /** The target, if its leaf still shows a note; else the workspace's current one. */
  #liveTarget(): MarkdownView | null {
    const t = this.#target;
    if (t !== null && t.file !== null && isOpen(this.app.workspace, t)) return t;
    this.#target = currentMarkdown(this.app.workspace);
    return this.#target;
  }

  #release(): void {
    this.#generation++;
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
    const off = this.#off;
    this.#off = [];
    for (const f of off) f();
  }
}

const isOpen = (ws: Workspace, view: MarkdownView): boolean =>
  ws.getLeavesOfType("markdown").some((l) => l.view === view);

/** The active Markdown view, else the most recent leaf's when it shows a note, else null. */
function currentMarkdown(ws: Workspace): MarkdownView | null {
  const active = ws.getActiveViewOfType(MarkdownView);
  if (active !== null) return active;
  const recent = ws.getMostRecentLeaf()?.view;
  return recent instanceof MarkdownView ? recent : null;
}

/**
 * Reveals the one Shared Tasks pane, opening it in the right sidebar when
 * there is none, with focus on its heading (U03-18). Leaves of it beyond the first (a restored or split layout)
 * are closed, so the workspace keeps one. Calls while one is opening share it.
 */
export function paneOpener(ws: () => Workspace): () => Promise<WorkspaceLeaf | null> {
  let opening: Promise<WorkspaceLeaf | null> | null = null;
  const open = async (): Promise<WorkspaceLeaf | null> => {
    const workspace = ws();
    let leaf = keepOne(workspace);
    if (leaf === null) {
      leaf = workspace.getRightLeaf(false);
      if (leaf === null) return null;
      await leaf.setViewState({ type: PANE_VIEW, active: true });
    }
    await workspace.revealLeaf(leaf);
    if (leaf.view instanceof SharedTasksView) leaf.view.focusHeading();
    return leaf;
  };
  return () => {
    if (opening === null)
      opening = open().finally(() => {
        opening = null;
      });
    return opening;
  };
}

/** Closes every Shared Tasks leaf but the first; returns the one kept, or null. */
export function keepOne(ws: Workspace): WorkspaceLeaf | null {
  const [first, ...extra] = ws.getLeavesOfType(PANE_VIEW);
  for (const leaf of extra) leaf.detach();
  return first ?? null;
}
