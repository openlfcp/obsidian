// LFCP-03-041 (I4): the sections host's inviteRefusal, as the plugin wires it
// into "Invite collaborator…": the section of the Resource found by its key,
// the card's invite descriptor read for that key, a wait for the status pass
// while access is not checked yet, and offline said at once.

import { fromBase64url, type ResourceId } from "@openlfcp/core";
import { describe, expect, it, vi } from "vitest";
import { INVITE_WAITS } from "../../src/core/actions/descriptors";
import type { StatusView } from "../../src/core/status/reducer";
import { SectionsHost } from "../../src/obsidian/sections-host";
import * as mock from "../mocks/obsidian";

const R0 = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const KEY = `${R0}#019a2f85-7b31-7c42-b85a-fc843e2f4001`;
const R = fromBase64url(R0) as ResourceId;

function host(o: { answers: (string | null)[]; connection?: StatusView["connection"] }) {
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
  vi.spyOn(h.actions, "inviteRefusal").mockImplementation(async (key) => {
    reads.push(key);
    return o.answers[Math.min(reads.length - 1, o.answers.length - 1)] ?? null;
  });
  return { h, reads, schedule };
}

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

  it("offline: refused at once, no wait", async () => {
    const t = host({ answers: [INVITE_WAITS, null], connection: "offline" });
    expect(await t.h.inviteRefusal(R)).toBe(INVITE_WAITS);
    expect(t.reads).toEqual([KEY]);
    expect(t.schedule).not.toHaveBeenCalled();
  });
});
