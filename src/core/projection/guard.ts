// The mutation guard (LFCP-061, item 9): writes the plugin makes to Markdown
// (projection updates from LFCP-062/064) must not come back as intents.
// Before writing, the writer records (path, SHA-256 of the exact content it
// will write); when the vault reports that file with exactly that content,
// the change is the plugin's own echo and is skipped. Content, not time:
// no debounce window decides, and a user edit that lands before the echo
// has other content, so it is processed.

import { toHex } from "@openlfcp/core";
import { sha256 } from "@openlfcp/crypto";

/** The guard key's content part: SHA-256 of the UTF-8 content, hex. */
export const contentHash = (content: string): string =>
  toHex(sha256(new TextEncoder().encode(content)));

/** How many pending expectations one path keeps (older ones are dropped). */
const PER_PATH = 8;

export class MutationGuard {
  readonly #expected = new Map<string, string[]>();

  /** Records that the plugin is about to write `content` to `path`. Returns the hash. */
  expect(path: string, content: string): string {
    const hash = contentHash(content);
    const list = this.#expected.get(path) ?? [];
    list.push(hash);
    while (list.length > PER_PATH) list.shift();
    this.#expected.set(path, list);
    return hash;
  }

  /**
   * True when `content` at `path` is a write the plugin expected: that
   * expectation and every older one for the path are consumed.
   */
  consume(path: string, content: string): boolean {
    const list = this.#expected.get(path);
    if (list === undefined) return false;
    const at = list.indexOf(contentHash(content));
    if (at < 0) return false;
    list.splice(0, at + 1);
    if (list.length === 0) this.#expected.delete(path);
    return true;
  }

  /** Expectations follow a renamed file. */
  rename(oldPath: string, newPath: string): void {
    const list = this.#expected.get(oldPath);
    if (list === undefined) return;
    this.#expected.delete(oldPath);
    this.#expected.set(newPath, list);
  }

  /** Drops the expectations of a path (e.g. the write failed). */
  forget(path: string): void {
    this.#expected.delete(path);
  }

  get pending(): number {
    let n = 0;
    for (const l of this.#expected.values()) n += l.length;
    return n;
  }
}
