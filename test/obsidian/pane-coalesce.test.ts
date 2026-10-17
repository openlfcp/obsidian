// @vitest-environment happy-dom
// LFCP-03-053 (B1): the pane's coalescing of changes. The first change after
// a quiet spell is drawn at once (leading edge); changes that follow a draw
// within COALESCE_MS make one draw at the window's end (trailing edge),
// which reads the facts as they are then; a held-down caret draws at most
// once per window; a close or an unload leaves no timer and no late draw.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneModel } from "../../src/core/pane/model";
import {
  COALESCE_MS,
  type PaneHostPort,
  type PaneSnapshot,
  SharedTasksView,
} from "../../src/obsidian/ui/pane-view";
import * as mock from "../mocks/obsidian";

// The renderer is not under test: each draw is the facts read for it.
vi.mock("../../src/obsidian/ui/pane-renderer", () => ({ renderPane: () => undefined }));

function pane() {
  /** The host's fact that changes (a caret line); each draw records what it read. */
  const host = { caret: 0 };
  const drawn: number[] = [];
  let changed: ((urgent?: boolean) => void) | null = null;
  const port: PaneHostPort = {
    snapshot: (): PaneSnapshot => {
      drawn.push(host.caret);
      return {
        model: {} as PaneModel,
        request: () => ({}),
        identity: () => "",
        pinned: null,
      };
    },
    run: async () => undefined,
    sources: [
      (f) => {
        changed = f;
        return () => {
          changed = null;
        };
      },
    ],
  };
  const app = new mock.App();
  const leaf = new mock.WorkspaceLeaf(app.workspace);
  const view = new SharedTasksView(leaf as never, port);
  /** The caret moved to `line`: the host's fact changes, the pane is told. */
  const move = (line: number) => {
    host.caret = line;
    changed?.();
  };
  const urgent = () => changed?.(true);
  return { view, host, drawn, move, urgent, subscribed: () => changed !== null };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The pane's timers are the window's (test/setup/window.ts): the faked ones here.
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pane coalescing (LFCP-03-053, B1)", () => {
  it("the first change after a quiet spell is drawn at once, not after the window", async () => {
    const t = pane();
    await t.view.onOpen();
    expect(t.drawn).toEqual([0]);
    t.move(5);
    // In the next task: out of the editor's own handler, long before COALESCE_MS.
    vi.advanceTimersByTime(0);
    expect(t.drawn).toEqual([0, 5]);
    // A quiet window draws nothing more.
    vi.advanceTimersByTime(COALESCE_MS * 3);
    expect(t.drawn).toEqual([0, 5]);
    // After the window, the next change is a leading edge again.
    t.move(6);
    vi.advanceTimersByTime(0);
    expect(t.drawn).toEqual([0, 5, 6]);
  });

  it("a series within the window makes one trailing draw with the last state", async () => {
    const t = pane();
    await t.view.onOpen();
    t.move(1);
    vi.advanceTimersByTime(0);
    expect(t.drawn).toEqual([0, 1]);
    for (let line = 2; line <= 9; line++) {
      vi.advanceTimersByTime(10);
      t.move(line);
    }
    // Still inside the window: nothing drawn yet.
    expect(t.drawn).toEqual([0, 1]);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(t.drawn).toEqual([0, 1, 9]);
    vi.advanceTimersByTime(COALESCE_MS * 3);
    expect(t.drawn).toEqual([0, 1, 9]);
  });

  it("changes before the leading draw runs are drawn by it, with no trailing draw", async () => {
    const t = pane();
    await t.view.onOpen();
    t.move(1);
    t.move(2);
    t.move(3);
    vi.advanceTimersByTime(COALESCE_MS * 3);
    expect(t.drawn).toEqual([0, 3]);
  });

  it("a held-down caret draws at most once per window, and its last position", async () => {
    const t = pane();
    await t.view.onOpen();
    const start = t.drawn.length;
    // 1 s of caret events every 5 ms.
    for (let line = 1; line <= 200; line++) {
      t.move(line);
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(COALESCE_MS * 2);
    const draws = t.drawn.length - start;
    expect(draws).toBeGreaterThan(1);
    expect(draws).toBeLessThanOrEqual(Math.ceil(1000 / COALESCE_MS) + 1);
    expect(t.drawn.at(-1)).toBe(200);
  });

  it("an urgent change is drawn at once and ends the window", async () => {
    const t = pane();
    await t.view.onOpen();
    t.move(1);
    vi.advanceTimersByTime(0);
    t.move(2);
    t.urgent();
    expect(t.drawn).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(COALESCE_MS * 2);
    expect(t.drawn).toEqual([0, 1, 2]);
  });

  it("a close or an unload with a draw due leaves no timer and no late draw", async () => {
    for (const end of ["close", "unload"] as const) {
      const t = pane();
      await t.view.onOpen();
      t.move(1);
      vi.advanceTimersByTime(0);
      t.move(2);
      // A leading draw waiting, too.
      expect(vi.getTimerCount()).toBe(1);
      if (end === "close") await t.view.onClose();
      else (t.view as unknown as mock.Component).unload();
      expect(t.subscribed()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(COALESCE_MS * 3);
      expect(t.drawn).toEqual([0, 1]);
    }
  });

  it("opened again after a close, it draws the state as it is then", async () => {
    const t = pane();
    await t.view.onOpen();
    t.move(1);
    vi.advanceTimersByTime(0);
    t.move(2);
    await t.view.onClose();
    t.host.caret = 3;
    await t.view.onOpen();
    expect(t.drawn).toEqual([0, 1, 3]);
    t.move(4);
    vi.advanceTimersByTime(0);
    expect(t.drawn).toEqual([0, 1, 3, 4]);
  });
});
