// The timers and the randomness the platform-neutral core needs, given by the
// host. The core runs in Obsidian's windows (desktop, mobile, popouts) and in
// Node tests; it names no `window` or `globalThis`. The adapter installs the
// window's own functions at load (src/obsidian/plugin.ts), the unit tests
// install Node's (test/setup/window.ts).

export interface CoreClock {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  /** `n` cryptographically random bytes. */
  readonly randomBytes: (n: number) => Uint8Array;
}

let installed: CoreClock | null = null;

/** Called once by the host, before any core code runs a timer. */
export function installClock(clock: CoreClock): void {
  installed = clock;
}

/** The host's clock; a core module reads it when it needs a timer, not at import. */
export function clock(): CoreClock {
  if (installed === null) throw new Error("The host has not installed the core clock");
  return installed;
}
