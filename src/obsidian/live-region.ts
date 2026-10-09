// One polite live region for the plugin's announcements (LFCP-02-064,
// OBSIDIAN-SHARED-SECTIONS-UX-01 §10): a new blocking condition and the
// problem reached by a command are said once. Visually hidden, outside any
// note, so never in a copy.

export class LiveRegion {
  readonly #el: HTMLElement;
  #timer: number | null = null;

  constructor(doc: Document) {
    this.#el = doc.body.createDiv({
      cls: "openlfcp-live-region",
      attr: {
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true",
        "data-lfcp-ui": "live",
      },
    });
  }

  /** Says `text`: cleared first, so the same words said again are read again. */
  announce(text: string): void {
    this.#el.textContent = "";
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      this.#el.textContent = text;
    }, 100);
  }

  /** The words last said (the native spec reads them). */
  get text(): string {
    return this.#el.textContent ?? "";
  }

  detach(): void {
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#el.remove();
  }
}
