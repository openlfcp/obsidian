// Flows a second run of would duplicate while the first is still open (the
// MVP 0.3 baseline review, F-03 and F-C04): "Share section…" run twice on
// one note opened two previews, and both created a Resource; insert and
// join had no guard either. One flow per key at a time, as invitations do
// (CollabCommands#oneInvitation): a second start meanwhile is told so and
// does nothing.

export class InFlight {
  readonly #running = new Set<string>();

  /** Whether a flow under `key` is running. */
  busy(key: string): boolean {
    return this.#running.has(key);
  }

  /**
   * Runs `body` unless a flow under `key` is running; then calls `busy`
   * and resolves with undefined. The key is free again when `body` settles.
   */
  async run<T>(key: string, busy: () => void, body: () => Promise<T>): Promise<T | undefined> {
    if (this.#running.has(key)) {
      busy();
      return undefined;
    }
    this.#running.add(key);
    try {
      return await body();
    } finally {
      this.#running.delete(key);
    }
  }
}
