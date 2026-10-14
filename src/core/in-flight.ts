// Flows a second run of would duplicate while the first is still open (the
// MVP 0.3 baseline review, F-03 and F-C04): "Share section…" run twice on
// one note opened two previews, and both created a Resource; insert and
// join had no guard either. One flow per key at a time, as invitations do
// (CollabCommands#oneInvitation). A second start meanwhile opens nothing
// and allocates nothing: it is handed the running flow, which shows what it
// has open (its dialog), or says where it stands (LFCP-03-002).

/** A running flow, as a repeated start sees it. */
export class Flow {
  #reveal: (() => void) | null = null;

  constructor(
    /** What the flow is doing now, said to a repeated start when it has nothing open to show. */
    public stage: string,
  ) {}

  /** While set, a repeated start calls `reveal` (the flow's open dialog, brought forward). */
  showing(reveal: (() => void) | null): void {
    this.#reveal = reveal;
  }

  /** Shows the flow's open dialog; false when it has none open now. */
  reveal(): boolean {
    if (this.#reveal === null) return false;
    this.#reveal();
    return true;
  }
}

export class InFlight {
  readonly #running = new Map<string, Flow>();

  /** Whether a flow under `key` is running. */
  busy(key: string): boolean {
    return this.#running.has(key);
  }

  /**
   * Runs `body` unless a flow under `key` is running; then calls `busy`
   * with that flow and resolves with undefined. The key is free again when
   * `body` settles.
   */
  async run<T>(
    key: string,
    busy: (running: Flow) => void,
    body: (flow: Flow) => Promise<T>,
    stage = "running",
  ): Promise<T | undefined> {
    const running = this.#running.get(key);
    if (running !== undefined) {
      busy(running);
      return undefined;
    }
    const flow = new Flow(stage);
    this.#running.set(key, flow);
    try {
      return await body(flow);
    } finally {
      this.#running.delete(key);
    }
  }
}
