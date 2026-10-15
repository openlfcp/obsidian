// LFCP-03-041 (I4): the executor's check before the invite role dialog
// waits for the status pass and the access check to catch up (just shared,
// just started), a few seconds at most; offline, or for any other reason,
// it refuses at once with the pane's reason.

import { describe, expect, it } from "vitest";
import { INVITE_WAITS } from "../../../src/core/actions/descriptors";
import {
  INVITE_CHECK_MS,
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
}) {
  let clock = 0;
  let step = 0;
  const reads: string[] = [];
  let refreshes = 0;
  const src: InviteCheckSource = {
    keys: () => (o.keys ?? (() => [KEY]))(step),
    refusal: async (key) => {
      reads.push(key);
      return o.answers[Math.min(reads.length - 1, o.answers.length - 1)] ?? null;
    },
    offline: () => o.offline === true,
    refresh: () => {
      refreshes++;
    },
    next: async (ms) => {
      clock += ms;
      step++;
    },
    now: () => clock,
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

  it("the section's key is found by its Resource, never another one's", () => {
    expect(sectionKeyOf([`${R}x#a`, `x${R}#b`, KEY], R)).toBe(KEY);
    expect(sectionKeyOf([`${R}x#a`], R)).toBeUndefined();
  });
});
