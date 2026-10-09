// D1: a note whose passes keep failing (a model that throws when read) says
// so once, not on every edit, event and refresh. Pure.

/** Which pass errors to show: once per note and message, until that note passes again. */
export class PassErrorNotices {
  readonly #shown = new Map<string, string>();

  /** Whether to show `message` for `path` now. */
  shouldShow(path: string, message: string): boolean {
    if (this.#shown.get(path) === message) return false;
    this.#shown.set(path, message);
    return true;
  }

  /** The note passed: its next failure is news again. */
  passed(path: string): void {
    this.#shown.delete(path);
  }
}
