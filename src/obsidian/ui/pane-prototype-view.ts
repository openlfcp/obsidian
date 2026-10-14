// The developer pane prototype (LFCP-03-007): an ItemView that renders the
// pane from mock facts, switches between the UX state fixtures and the
// layouts of UX §3, and walks the share → invite, join → insert and problem
// flows. Its buttons move the mock only: no operation, network, vault or
// clipboard call. It exists only when `developerPanePrototype` is set in
// data.json (no settings tab entry, no ribbon, no menu): the production
// entries of the pane are LFCP-03-012's.

import { ItemView, type Plugin, type WorkspaceLeaf } from "obsidian";
import states from "../../../test/fixtures/ux-0.3/states.json";
import { PanePrototype, type PrototypeFixture } from "../../core/pane/prototype";
import { renderPane } from "./pane-renderer";

export const PANE_PROTOTYPE_VIEW = "shared-tasks-pane-prototype";

/** The frozen UX states (synthetic content; the same file the tests read). */
const FIXTURES = (states as unknown as { states: PrototypeFixture[] }).states;

export class PanePrototypeView extends ItemView {
  readonly prototype = new PanePrototype(FIXTURES);
  #narrow = true;
  #pane: HTMLElement | null = null;
  #controls: HTMLElement | null = null;
  #select: HTMLSelectElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  override getViewType(): string {
    return PANE_PROTOTYPE_VIEW;
  }

  override getDisplayText(): string {
    return "Shared Tasks pane prototype";
  }

  override getIcon(): string {
    return "flask-conical";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add("openlfcp-pane-prototype");
    const doc = root.ownerDocument;
    const banner = doc.createElement("div");
    banner.className = "openlfcp-pane-prototype-banner";
    banner.textContent =
      "Prototype on mock facts: no button runs an operation. Not sync, not evidence.";
    root.appendChild(banner);

    const bar = doc.createElement("div");
    bar.className = "openlfcp-pane-prototype-bar";
    root.appendChild(bar);
    const label = doc.createElement("label");
    label.textContent = "State";
    const select = doc.createElement("select");
    select.className = "dropdown";
    select.id = "openlfcp-pane-prototype-state";
    label.htmlFor = select.id;
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const s of this.prototype.scenarios()) {
      let g = groups.get(s.group);
      if (g === undefined) {
        g = doc.createElement("optgroup");
        g.label =
          s.group === "layout" ? "Layouts (UX §3)" : s.group === "flow" ? "Flows" : "Fixtures";
        select.appendChild(g);
        groups.set(s.group, g);
      }
      const o = doc.createElement("option");
      o.value = s.id;
      o.textContent = s.label;
      g.appendChild(o);
    }
    select.value = this.prototype.scenario;
    select.addEventListener("change", () => this.select(select.value));
    bar.append(label, select);
    this.#select = select;

    const narrow = doc.createElement("label");
    const box = doc.createElement("input");
    box.type = "checkbox";
    box.checked = this.#narrow;
    box.addEventListener("change", () => this.setNarrow(box.checked));
    narrow.append(box, doc.createTextNode(" Narrow (280 px)"));
    bar.appendChild(narrow);

    this.#controls = doc.createElement("div");
    this.#controls.className = "openlfcp-pane-prototype-controls";
    root.appendChild(this.#controls);
    this.#pane = doc.createElement("div");
    root.appendChild(this.#pane);
    this.render();
  }

  override async onClose(): Promise<void> {
    this.contentEl.replaceChildren();
    this.#pane = null;
  }

  /** Shows a scenario or a fixture (`fixture:<id>`). */
  select(id: string): void {
    this.prototype.select(id);
    if (this.#select !== null) this.#select.value = id;
    this.render();
  }

  setNarrow(on: boolean): void {
    this.#narrow = on;
    this.render();
  }

  render(): void {
    const pane = this.#pane;
    const controls = this.#controls;
    if (pane === null || controls === null) return;
    pane.classList.toggle("is-narrow", this.#narrow);
    renderPane(pane, this.prototype.model(), {
      action: (id) => {
        this.prototype.act(id);
        this.render();
      },
      join: (link) => {
        this.prototype.join(link);
        this.render();
      },
    });
    controls.replaceChildren();
    for (const c of this.prototype.controls()) {
      const b = controls.ownerDocument.createElement("button");
      b.type = "button";
      b.textContent = c.label;
      b.dataset.control = c.id;
      b.addEventListener("click", () => {
        this.prototype.control(c.id);
        this.render();
      });
      controls.appendChild(b);
    }
  }
}

/** Registers the view and its developer command (only when the developer flag is set). */
export function registerPanePrototype(plugin: Plugin): void {
  plugin.registerView(PANE_PROTOTYPE_VIEW, (leaf) => new PanePrototypeView(leaf));
  plugin.addCommand({
    id: "open-pane-prototype",
    name: "Open pane prototype (developer)",
    callback: async () => {
      const workspace = plugin.app.workspace;
      const existing = workspace.getLeavesOfType(PANE_PROTOTYPE_VIEW)[0];
      const leaf = existing ?? workspace.getRightLeaf(false);
      if (leaf === null) return;
      if (existing === undefined)
        await leaf.setViewState({ type: PANE_PROTOTYPE_VIEW, active: true });
      await workspace.revealLeaf(leaf);
    },
  });
}
