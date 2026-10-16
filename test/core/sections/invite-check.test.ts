// LFCP-03-041 (I4): the executor's check before the invite role dialog
// waits for the status pass and the access check to catch up (just shared,
// just started), a few seconds at most; offline, or for any other reason,
// it refuses at once with the pane's reason.

import { describe, expect, it } from "vitest";
import { INVITE_WAITS } from "../../../src/core/actions/descriptors";
import {
  INVITE_CHECK_MS,
  INVITE_CHECK_STEP_MS,
  INVITE_STOPPED,
  type InviteCheckSource,
  inviteCheck,
  sectionKeyOf,
} from "../../../src/core/sections/invite-check";

const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const KEY = `${R}#sid`;

/** A source on a fake clock: `answers` are the descriptor's reasons, read one by one. */
function source(o: {
  keys?: (step: number) => string[];
  answers: (string | null)[];
  offline?: boolean;
  /** A read never answers (the card's content never resolves). */
  hang?: boolean;
  /** The host stops before read number `n` answers. */
  stopAt?: number;
}) {
  let clock = 0;
  let step = 0;
  const reads: string[] = [];
  let refreshes = 0;
  let stopped = false;
  const src: InviteCheckSource = {
    keys: () => (o.keys ?? (() => [KEY]))(step),
    refusal: (key) => {
      reads.push(key);
      if (reads.length === o.stopAt) stopped = true;
      if (o.hang === true) return new Promise(() => undefined);
      return Promise.resolve(o.answers[Math.min(reads.length - 1, o.answers.length - 1)] ?? null);
    },
    offline: () => o.offline === true,
    refresh: () => {
      refreshes++;
    },
    next: (ms, signal) => {
      // The bound on a read: time passes only while a read hangs; an answer aborts it.
      if (signal !== undefined && o.hang !== true)
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
      clock += ms;
      step++;
      return Promise.resolve();
    },
    now: () => clock,
    stopped: () => stopped,
  };
  return { src, reads, refreshes: () => refreshes, clock: () => clock };
}

describe("inviteCheck (LFCP-03-041)", () => {
  it("offered at once: no wait", async () => {
    const s = source({ answers: [null] });
    expect(await inviteCheck(s.src, R)).toBeNull();
    expect(s.reads).toEqual([KEY]);
    expect(s.clock()).toBe(0);
  });

  it("just shared: waits for the check, then offers (no refusal to repeat)", async () => {
    const s = source({ answers: [INVITE_WAITS, INVITE_WAITS, null] });
    expect(await inviteCheck(s.src, R)).toBeNull();
    expect(s.reads).toHaveLength(3);
    expect(s.refreshes()).toBe(2);
  });

  it("no status yet: waits for the section's first status pass", async () => {
    const s = source({ keys: (step) => (step < 2 ? [] : [KEY]), answers: [null] });
    expect(await inviteCheck(s.src, R)).toBeNull();
    expect(s.reads).toEqual([KEY]);
  });

  it("still not checked after the wait: refuses, within the bound", async () => {
    const s = source({ answers: [INVITE_WAITS] });
    expect(await inviteCheck(s.src, R)).toBe(INVITE_WAITS);
    expect(s.clock()).toBe(INVITE_CHECK_MS);
    const none = source({ keys: () => [], answers: [null] });
    expect(await inviteCheck(none.src, R, 1000)).toBe(INVITE_WAITS);
    expect(none.reads).toEqual([]);
  });

  it("offline: the honest refusal at once, no wait", async () => {
    const s = source({ answers: [INVITE_WAITS, null], offline: true });
    expect(await inviteCheck(s.src, R)).toBe(INVITE_WAITS);
    expect(s.clock()).toBe(0);
  });

  it("another reason (no right, not hosted): said at once", async () => {
    const s = source({ answers: ["You can't invite others to this section.", null] });
    expect(await inviteCheck(s.src, R)).toBe("You can't invite others to this section.");
    expect(s.reads).toHaveLength(1);
  });

  it("a read that never answers does not hold the check: the deadline still ends it (LFCP-03-046)", async () => {
    const s = source({ answers: [null], hang: true });
    expect(await inviteCheck(s.src, R, 1000)).toBe(INVITE_WAITS);
    expect(s.reads).toEqual([KEY]);
    // The read's bound is the time left, one step at least.
    expect(s.clock()).toBe(1000);
    const late = source({ answers: [null], hang: true });
    expect(await inviteCheck(late.src, R, 0)).toBe(INVITE_WAITS);
    expect(late.clock()).toBe(INVITE_CHECK_STEP_MS);
  });

  it("the host stopped (the plugin unloads): INVITE_STOPPED, nothing read after (LFCP-03-046)", async () => {
    const during = source({ answers: [INVITE_WAITS, null], stopAt: 1 });
    expect(await inviteCheck(during.src, R)).toBe(INVITE_STOPPED);
    expect(during.reads).toEqual([KEY]);
    expect(during.refreshes()).toBe(0);
    // Even an answer read as the host stopped is not acted on.
    const offered = source({ answers: [null], stopAt: 1 });
    expect(await inviteCheck(offered.src, R)).toBe(INVITE_STOPPED);
    const hanging = source({ answers: [null], hang: true, stopAt: 1 });
    expect(await inviteCheck(hanging.src, R)).toBe(INVITE_STOPPED);
    expect(hanging.clock()).toBe(0);
  });

  it("the section's key is found by its Resource, never another one's", () => {
    expect(sectionKeyOf([`${R}x#a`, `x${R}#b`, KEY], R)).toBe(KEY);
    expect(sectionKeyOf([`${R}x#a`], R)).toBeUndefined();
  });
});
