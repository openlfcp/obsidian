// LFCP-03-041 (I4): the sections host's inviteRefusal, as the plugin wires it
// into "Invite collaborator…": the section of the Resource found by its key,
// the card's invite descriptor read for that key, a wait for the status pass
// while access is not checked yet, and offline said at once.

import { fromBase64url, type ResourceId } from "@openlfcp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INVITE_WAITS } from "../../src/core/actions/descriptors";
import { INVITE_STOPPED } from "../../src/core/sections/invite-check";
import type { StatusView } from "../../src/core/status/reducer";
import { SectionsHost } from "../../src/obsidian/sections-host";
import * as mock from "../mocks/obsidian";

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const KEY = `${R0}#019a2f85-7b31-7c42-b85a-fc843e2f4001`;
const R = fromBase64url(R0) as ResourceId;

function host(o: {
  answers: (string | null)[];
  connection?: StatusView["connection"];
  /** The card's content never resolves: the read never answers. */
  hang?: boolean;
}) {
  const h = new SectionsHost(
    new mock.App() as never,
    () => undefined,
    () => "child-line",
    () => "local",
    () => null,
    () => "wss://sync.example/v1/ws",
  );
  // Another Resource whose ID starts like this one's, and this one's section.
  vi.spyOn(h, "sectionKeys").mockReturnValue([`${R0}x#other`, KEY]);
  vi.spyOn(h, "sectionStatus").mockReturnValue({
    connection: o.connection ?? "connected",
  } as unknown as StatusView);
  const schedule = vi.spyOn(h, "scheduleStatus").mockImplementation(() => undefined);
  const reads: string[] = [];
  vi.spyOn(h.actions, "inviteRefusal").mockImplementation((key) => {
    reads.push(key);
    if (o.hang === true) return new Promise(() => undefined);
    return Promise.resolve(o.answers[Math.min(reads.length - 1, o.answers.length - 1)] ?? null);
  });
  // The status subscriptions still held: each one the check took, until it let go.
  let listening = 0;
  const subscribe = h.onStatusChange.bind(h);
  vi.spyOn(h, "onStatusChange").mockImplementation((l) => {
    listening++;
    const off = subscribe(l);
    let done = false;
    return () => {
      if (!done) listening--;
      done = true;
      return off();
    };
  });
  return { h, reads, schedule, listening: () => listening };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SectionsHost.inviteRefusal (LFCP-03-041)", () => {
  it("reads the card's descriptor for the Resource's own section", async () => {
    const t = host({ answers: ["You can't invite others to this section."] });
    expect(await t.h.inviteRefusal(R)).toBe("You can't invite others to this section.");
    expect(t.reads).toEqual([KEY]);
    expect(t.schedule).not.toHaveBeenCalled();
  });

  it("access not checked yet: asks for a status pass and waits, then offers", async () => {
    const t = host({ answers: [INVITE_WAITS, null] });
    expect(await t.h.inviteRefusal(R)).toBeNull();
    expect(t.reads).toEqual([KEY, KEY]);
    expect(t.schedule).toHaveBeenCalledTimes(1);
  });

  it("still not checked when the wait is over: the pane's reason", async () => {
    const t = host({ answers: [INVITE_WAITS] });
    expect(await t.h.inviteRefusal(R, 300)).toBe(INVITE_WAITS);
    expect(t.reads.length).toBeGreaterThan(1);
  });

  it("leaves no status listener and no timer behind (LFCP-03-046)", async () => {
    vi.useFakeTimers();
    const t = host({ answers: [INVITE_WAITS, INVITE_WAITS, null] });
    const check = t.h.inviteRefusal(R, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await check).toBeNull();
    expect(t.reads.length).toBe(3);
    expect(t.listening()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // Refused when the wait is over: nothing left either.
    const late = host({ answers: [INVITE_WAITS] });
    const refused = late.h.inviteRefusal(R, 1000);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await refused).toBe(INVITE_WAITS);
    expect(late.listening()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the card's content never resolves: refused at the deadline, nothing left behind (LFCP-03-046)", async () => {
    vi.useFakeTimers();
    const t = host({ answers: [null], hang: true });
    const check = t.h.inviteRefusal(R, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await check).toBe(INVITE_WAITS);
    expect(t.listening()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopped while it waits (the plugin unloads): INVITE_STOPPED at once, no further pass (LFCP-03-046)", async () => {
    vi.useFakeTimers();
    const t = host({ answers: [INVITE_WAITS] });
    const check = t.h.inviteRefusal(R);
    await vi.advanceTimersByTimeAsync(10);
    const reads = t.reads.length;
    const passes = t.schedule.mock.calls.length;
    t.h.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(await check).toBe(INVITE_STOPPED);
    expect(t.reads.length).toBe(reads);
    expect(t.schedule.mock.calls.length).toBe(passes);
    expect(t.listening()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // Asked after unload: refused without a read.
    expect(await t.h.inviteRefusal(R)).toBe(INVITE_STOPPED);
    expect(t.reads.length).toBe(reads);
  });

  it("offline: refused at once, no wait", async () => {
    const t = host({ answers: [INVITE_WAITS, null], connection: "offline" });
    expect(await t.h.inviteRefusal(R)).toBe(INVITE_WAITS);
    expect(t.reads).toEqual([KEY]);
    expect(t.schedule).not.toHaveBeenCalled();
  });
});
