// Types for reaper.mjs (plain JavaScript, so that orphan-parent.mjs runs it
// under Node without a build step).

import type { ChildProcess } from "node:child_process";

/**
 * Guards a started child: it is SIGKILLed when this process exits, and, on
 * POSIX, by a watchdog when this process dies without exiting normally,
 * which also removes `paths`. Returns `release`: call it before stopping the
 * child on purpose.
 */
export function guardChild(child: ChildProcess, paths?: readonly string[]): () => void;
