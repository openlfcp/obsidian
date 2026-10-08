// LFCP-02-043: when typing becomes a reconciliation (idle, composition
// end, blur, a cap) and which new content waits (MS17-transient). Unit
// evidence; IME on the real host is the manual checklist.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnboundNode } from "../../../src/core/sections/base";
import {
  IDLE_MS,
  MAX_WAIT_MS,
  ReconcileScheduler,
  transientCandidates,
} from "../../../src/core/sections/input";

const timer = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function scheduler() {
  const runs: number[] = [];
  const dirty: number[] = [];
  const s = new ReconcileScheduler(
    () => runs.push(Date.now()),
    timer,
    () => dirty.push(Date.now()),
  );
  return { s, runs, dirty };
}

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe("ReconcileScheduler", () => {
  it("shows the edit at once and reconciles after a short idle", () => {
    const { s, runs, dirty } = scheduler();
    s.edit(false);
    expect(dirty).toEqual([0]);
    expect(s.dirty).toBe(true);
    vi.advanceTimersByTime(IDLE_MS - 1);
    s.edit(false);
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(runs).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(runs).toEqual([2 * IDLE_MS - 1]);
    expect(s.dirty).toBe(false);
    expect(dirty).toHaveLength(1);
  });

  it("reconciles continuous typing at the cap", () => {
    const { s, runs } = scheduler();
    for (let t = 0; t < MAX_WAIT_MS + 500; t += 100) {
      s.edit(false);
      vi.advanceTimersByTime(100);
    }
    expect(runs).toEqual([MAX_WAIT_MS]);
  });

  it("never reconciles during a composition; its end does, at once", () => {
    const { s, runs } = scheduler();
    s.compositionStart();
    s.edit(true);
    vi.advanceTimersByTime(MAX_WAIT_MS * 2);
    expect(runs).toEqual([]);
    expect(s.dirty).toBe(true);
    s.compositionEnd();
    expect(runs).toEqual([MAX_WAIT_MS * 2]);
  });

  it("reconciles at blur, and a clean editor's blur or composition end does nothing", () => {
    const { s, runs } = scheduler();
    s.blur();
    s.compositionEnd();
    expect(runs).toEqual([]);
    s.edit(false);
    s.blur();
    expect(runs).toEqual([0]);
    vi.advanceTimersByTime(MAX_WAIT_MS);
    expect(runs).toEqual([0]);
  });

  it("dispose drops the timers without a pass", () => {
    const { s, runs } = scheduler();
    s.edit(false);
    s.dispose();
    vi.advanceTimersByTime(MAX_WAIT_MS);
    expect(runs).toEqual([]);
  });
});

describe("transientCandidates (MS17-transient)", () => {
  const c = (kind: UnboundNode["kind"], line: number, text?: string): UnboundNode => ({
    kind,
    parent: null,
    after: null,
    line,
    ...(text === undefined ? {} : { text }),
  });
  const lines = ["- [ ] ", "- ", "- [ ] Title", "- Text", "Para"];

  it("holds an empty item or a Task without a title on the caret's line", () => {
    const at = (line: number) =>
      transientCandidates(
        [
          c("task", 0),
          c("item", 1, ""),
          c("task", 2),
          c("item", 3, "Text"),
          c("paragraph", 4, "Para"),
        ],
        (l) => lines[l] ?? "",
        line,
      );
    expect([...at(0)]).toEqual([0]);
    expect([...at(1)]).toEqual([1]);
    expect([...at(2)]).toEqual([]);
    expect([...at(3)]).toEqual([]);
    expect([...at(4)]).toEqual([]);
  });

  it("holds nothing once the caret is elsewhere", () => {
    expect([...transientCandidates([c("task", 0)], (l) => lines[l] ?? "", null)]).toEqual([]);
    expect([...transientCandidates([c("task", 0)], (l) => lines[l] ?? "", 3)]).toEqual([]);
  });
});
