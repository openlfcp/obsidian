// One polite live region for the plugin's announcements (LFCP-02-064,
// OBSIDIAN-SHARED-SECTIONS-UX-01 §10): a new blocking condition and the
// problem reached by a command are said once. Visually hidden, outside any
// note, so never in a copy.
//
// A popout window has a document of its own, which a screen reader reads
// apart from the main one (LFCP-03-022, U03-20): what is said goes to the
// region of the window in use, made there the first time.

export class LiveRegion {
  /** The region of each document, the main one first. */
  readonly #regions = new Map<Document, HTMLElement>();
  /** The region last spoken in. */
  #said: HTMLElement;
  #timer: number | null = null;

  constructor(
    doc: Document,
    /** The document of the window in use (Obsidian's activeDocument). */
    private readonly current: () => Document = () => doc,
  ) {
    this.#said = this.#regionIn(doc);
  }

  #regionIn(doc: Document): HTMLElement {
    let el = this.#regions.get(doc);
    if (el?.isConnected === true) return el;
    el = doc.createElement("div");
    el.className = "openlfcp-live-region";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    el.setAttribute("data-lfcp-ui", "live");
    doc.body.appendChild(el);
    this.#regions.set(doc, el);
    return el;
  }

  /** Says `text`: cleared first, so the same words said again are read again. */
  announce(text: string): void {
    for (const [doc, el] of this.#regions) {
      // A closed popout: its document is gone, and its region with it.
      if (doc.defaultView === null) this.#regions.delete(doc);
      else el.textContent = "";
    }
    const el = this.#regionIn(this.current());
    this.#said = el;
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      el.textContent = text;
    }, 100);
  }

  /** The words last said (the native spec reads them). */
  get text(): string {
    return this.#said.textContent ?? "";
  }

  /** How many documents hold a region now (tests). */
  get documents(): number {
    return this.#regions.size;
  }

  detach(): void {
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
    for (const el of this.#regions.values()) el.remove();
    this.#regions.clear();
  }
}
