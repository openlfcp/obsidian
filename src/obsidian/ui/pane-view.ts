// The Shared Tasks pane (LFCP-03-012, F-01, F-02; U03-01, U03-20): one
// native ItemView per workspace. Its entries (the ribbon icon, the "Open
// Shared Tasks pane" command, the section card's link and the editor
// menu) all reveal the same leaf (openSharedTasksPane); none opens a second.
//
// It draws the pane's view model (core/pane/model.ts) with the shared
// renderer (pane-renderer.ts) from the host's facts (core/pane/host-facts.ts)
// and runs every button through the action dispatcher (surface "pane").
// It decides nothing itself.
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
import type { PaneModel } from "../../core/pane/model";
import { renderPane } from "./pane-renderer";

export const PANE_VIEW = "shared-tasks-pane";
export const PANE_TITLE = "Shared Tasks";
/** The ribbon's and the tab's icon (Lucide). */
export const PANE_ICON = "list-checks";
export const OPEN_PANE = "Open Shared Tasks pane";

/** A source of change: subscribes, and returns how to unsubscribe. */
export type PaneSource = (changed: () => void) => () => void;

/** What the pane reads and runs, from the plugin. */
export interface PaneHostPort {
  /** The pane's model for the note in `target` (null: no Markdown note open), read now. */
  model(target: MarkdownView | null): PaneModel;
  /** What a button hands the dispatcher for `target`, read at the click. */
  request(target: MarkdownView | null): ActionRequest;
  /** Runs an action through the dispatcher, from the pane. */
  run(id: ActionId, request: ActionRequest): Promise<void>;
  /** The host's change sources: the registry view, the statuses, the editors' cursor. */
  readonly sources: readonly PaneSource[];
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
    const changed = () => this.#schedule(generation);
    const take = (from: Events, ref: EventRef) => this.#off.push(() => from.offref(ref));
    take(
      ws,
      ws.on("active-leaf-change", (leaf) => {
        // Focus in the pane (or any other view) keeps the last note (T1).
        if (leaf?.view instanceof MarkdownView) this.#target = leaf.view;
        changed();
      }),
    );
    // A note opened, a mode switched or a leaf closed; an edit; a note renamed or deleted.
    take(ws, ws.on("file-open", changed));
    take(ws, ws.on("layout-change", changed));
    take(ws, ws.on("editor-change", changed));
    take(vault, vault.on("rename", changed));
    take(vault, vault.on("delete", changed));
    for (const subscribe of this.port.sources) this.#off.push(subscribe(changed));
    const root = this.contentEl;
    root.replaceChildren();
    this.#root = root.ownerDocument.createElement("div");
    root.appendChild(this.#root);
    this.render();
  }

  override async onClose(): Promise<void> {
    this.#release();
    this.contentEl.replaceChildren();
    this.#root = null;
    this.#target = null;
  }

  /** Draws the pane now from the host's facts. */
  render(): void {
    const root = this.#root;
    if (root === null) return;
    const generation = this.#generation;
    const target = this.#liveTarget();
    renderPane(root, this.port.model(target), {
      action: (id) => {
        // A button of a pane drawn before a close does nothing.
        if (generation !== this.#generation) return;
        void this.port.run(id, this.port.request(this.#liveTarget()));
      },
    });
  }

  #schedule(generation: number): void {
    if (generation !== this.#generation || this.#timer !== null) return;
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      if (generation === this.#generation) this.render();
    }, COALESCE_MS);
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
 * there is none. Leaves of it beyond the first (a restored or split layout)
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
