// Flows a second run of would duplicate while the first is still open (the
// MVP 0.3 baseline review, F-03 and F-C04): "Share section…" run twice on
// one note opened two previews, and both created a Resource; insert and
// join had no guard either. One flow per key at a time, as invitations do
// (CollabCommands#oneInvitation). A second start meanwhile opens nothing
// and allocates nothing: it is handed the running flow, which shows what it
// has open (its dialog), or says where it stands (LFCP-03-002).
//
// A flow whose effect has an unknown outcome keeps its key (LFCP-03-010,
// owner decision D12): it is not cancelled, so nothing may start a second
// operation on the same key until a reconcile of the same operation finds
// its result. A repeated start meanwhile runs that reconcile, never a new
// flow. Once a flow is closed, what it is still told (a dialog shown, a
// stage, a late reconcile) is ignored.
//
// A check of an unknown outcome is bounded (LFCP-03-017): one that has not
// answered within its time leaves the outcome unknown and says so, and a
// later check joins it while it still runs; nothing is started again. A
// flow a restart found unfinished (a step not started, no effect waiting
// for its answer) holds its key the same way until "Continue" resumes it.

/** What a reconcile of an unknown outcome found: settled (the key is free again), or still unknown. */
export type Reconciled = "settled" | "unknown";

/** How long "Check the result" waits for a reconcile before it says the result is still unknown. */
export const CHECK_TIMEOUT_MS = 60_000;

/** Why a flow holds its key after its body returned (UX contract §5 P2). */
export type Held = "unknown" | "unfinished";

/** A running flow, as a repeated start sees it. */
export class Flow {
  #reveal: (() => void) | null = null;
  #stage: string;
  #closed = false;
  #reconcile: (() => Promise<Reconciled>) | null = null;
  #held: Held = "unknown";
  /** The reconcile running now (it may outlive a check that timed out). */
  #running: Promise<void> | null = null;
  #checking = false;

  constructor(
    /** This flow's number, never reused: a late callback for an earlier flow names another one. */
    readonly generation: number,
    stage: string,
    private readonly onClose: () => void,
    /** How long a check of an unknown outcome waits (CHECK_TIMEOUT_MS). */
    private readonly checkTimeoutMs = CHECK_TIMEOUT_MS,
  ) {
    this.#stage = stage;
  }

  /** What the flow is doing now, said to a repeated start when it has nothing open to show. */
  get stage(): string {
    return this.#stage;
  }

  set stage(stage: string) {
    if (!this.#closed) this.#stage = stage;
  }

  /** Whether the flow ended: its key is free, and what it is told now is ignored. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Whether its last effect's outcome is unknown: the key stays held until a reconcile settles it. */
  get unknown(): boolean {
    return this.#reconcile !== null && this.#held === "unknown";
  }

  /** Whether a restart left it unfinished: the key stays held until "Continue" resumes it. */
  get unfinished(): boolean {
    return this.#reconcile !== null && this.#held === "unfinished";
  }

  /** Whether it holds its key after its body returned: unknown or unfinished. */
  get held(): boolean {
    return this.#reconcile !== null;
  }

  /** Whether a check of its unknown outcome (or its resume) is under way, within its time. */
  get checking(): boolean {
    return this.#checking;
  }

  /** While set, a repeated start calls `reveal` (the flow's open dialog, brought forward). */
  showing(reveal: (() => void) | null): void {
    if (!this.#closed) this.#reveal = reveal;
  }

  /** Shows the flow's open dialog; false when it has none open now. */
  reveal(): boolean {
    if (this.#closed || this.#reveal === null) return false;
    this.#reveal();
    return true;
  }

  /**
   * The flow's last effect has an unknown outcome (D12): when its body
   * returns, its key stays held, with `stage` said to a repeated start,
   * until `reconcile` (the same operation, resumed) settles it. `held`
   * "unfinished": no effect waits for its answer; a restart stopped the
   * flow before its next step, which `reconcile` resumes (LFCP-03-017).
   */
  unresolved(stage: string, reconcile: () => Promise<Reconciled>, held: Held = "unknown"): void {
    if (this.#closed) return;
    this.#stage = stage;
    this.#reveal = null;
    this.#reconcile = reconcile;
    this.#held = held;
  }

  /**
   * Reconciles an unknown outcome (or resumes an unfinished flow), once at
   * a time: a check while one runs joins it. Settled, the flow closes and
   * its key is free; a reconcile that throws leaves the outcome unknown.
   * An unknown outcome's check waits at most its time: then `timedOut` is
   * called and the outcome stays unknown, while the reconcile goes on (a
   * late settle still closes the flow; a check meanwhile joins it).
   */
  check(timedOut?: () => void): Promise<void> {
    const reconcile = this.#reconcile;
    if (this.#closed || reconcile === null) return Promise.resolve();
    if (this.#running === null) {
      const running = reconcile()
        .catch((): Reconciled => "unknown")
        .then((r) => {
          if (r === "settled" && this.#reconcile === reconcile) this.close();
        })
        .finally(() => {
          if (this.#running === running) {
            this.#running = null;
            this.#checking = false;
          }
        });
      this.#running = running;
    }
    const running = this.#running;
    this.#checking = true;
    // A resume waits for the user (its preview): no time limit.
    if (this.#held === "unfinished") return running;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((r) => {
      timer = setTimeout(() => r("late"), this.checkTimeoutMs);
    });
    return Promise.race([running.then(() => "done" as const), late]).then((r) => {
      clearTimeout(timer);
      if (r === "late" && this.#running === running && !this.#closed) {
        this.#checking = false;
        timedOut?.();
      }
    });
  }

  /** Ends the flow: its key is free. Once only. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reveal = null;
    this.#reconcile = null;
    this.#checking = false;
    this.onClose();
  }
}

export class InFlight {
  readonly #running = new Map<string, Flow>();
  #generation = 0;

  constructor(
    /** How long a check of an unknown outcome waits (tests shorten it). */
    private readonly checkTimeoutMs = CHECK_TIMEOUT_MS,
  ) {}

  /** Whether a flow under `key` is running (its outcome unknown included). */
  busy(key: string): boolean {
    return this.#running.has(key);
  }

  /** The flow under `key`, if one runs. */
  get(key: string): Flow | undefined {
    return this.#running.get(key);
  }

  /** The running flows, by key. */
  entries(): [string, Flow][] {
    return [...this.#running.entries()];
  }

  /** The running flow of this generation; undefined once it closed (a late callback). */
  byGeneration(generation: number): Flow | undefined {
    for (const f of this.#running.values()) if (f.generation === generation) return f;
    return undefined;
  }

  /**
   * Runs `body` unless a flow under `key` is running; then calls `busy`
   * with that flow and resolves with undefined. The key is free again when
   * `body` settles, also when it throws; unless the body marked its
   * outcome unknown or the flow unfinished (Flow.unresolved): then the key
   * stays held until a reconcile settles it.
   */
  async run<T>(
    key: string,
    busy: (running: Flow) => void,
    body: (flow: Flow) => Promise<T>,
    stage = "running",
    /** Runs once, when the flow closes (its key free again). */
    onClose: () => void = () => undefined,
  ): Promise<T | undefined> {
    const running = this.#running.get(key);
    if (running !== undefined) {
      busy(running);
      return undefined;
    }
    const flow = new Flow(
      ++this.#generation,
      stage,
      () => {
        if (this.#running.get(key) === flow) this.#running.delete(key);
        onClose();
      },
      this.checkTimeoutMs,
    );
    this.#running.set(key, flow);
    let held = false;
    try {
      const out = await body(flow);
      held = flow.held;
      return out;
    } finally {
      if (!held) flow.close();
    }
  }
}
