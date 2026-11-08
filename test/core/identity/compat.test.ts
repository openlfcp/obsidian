// LFCP-04-411: the compatibility warning before a human's first pairing
// (IDENTITY-PROFILE-01 §11, LFCP-WIRE-01 §100.1): collaborators on older
// versions stop syncing the affected sections until they update; updated
// ones see the new device under its person.

import { fromBase64url, generateResourceId, type ResourceId, toBase64url } from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import type { LfcpStorage } from "@openlfcp/storage";
import { afterEach, describe, expect, it } from "vitest";
import { Collaboration, type Participant } from "../../../src/core/collab/service";
import {
  firstPairingWarning,
  type PairingSection,
  pairingSections,
} from "../../../src/core/identity/compat";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

const section = (name: string, others: number | null, identityServer: boolean | null) =>
  ({ name, others, identityServer }) satisfies PairingSection;

describe("the warning before the first pairing", () => {
  it("names the sections shared with others, by their server's support", () => {
    const w = firstPairingWarning({
      firstPairing: true,
      sections: [
        section("Launch", 2, true),
        section("Mine only", 0, true),
        section("Old server", 1, false),
        section("Not checked", 3, null),
      ],
    });
    expect(w?.affected).toEqual(['"Launch" (2 other people)']);
    expect(w?.later).toEqual(['"Old server" (1 other person)']);
    expect(w?.unknown).toEqual(['"Not checked" (3 other people)']);
    expect(w?.message).toContain(
      "Anyone who uses them with an older version of Shared Tasks stops syncing them until they update the plugin.",
    );
    expect(w?.message).toContain(
      "they see your new device under your name, not as a new participant",
    );
    expect(w?.message).not.toContain("Mine only");
    expect(w).toMatchObject({
      title: "Before you add your first other device",
      action: "Continue",
    });
  });

  it("is not shown after the first pairing, nor when nothing is shared with anyone", () => {
    expect(
      firstPairingWarning({ firstPairing: false, sections: [section("Launch", 2, true)] }),
    ).toBeNull();
    expect(
      firstPairingWarning({ firstPairing: true, sections: [section("Mine", 0, true)] }),
    ).toBeNull();
    expect(firstPairingWarning({ firstPairing: true, sections: [] })).toBeNull();
  });

  it("warns for a section it could not read, rather than leaving it out", () => {
    const w = firstPairingWarning({
      firstPairing: true,
      sections: [section("Locked", null, null)],
    });
    expect(w?.unknown).toEqual(['"Locked" (who uses it is not known yet)']);
  });
});

describe("its facts", () => {
  const person = (principal: string, extra: Partial<Participant> = {}): Participant => ({
    id: principal.slice(0, 8),
    principal,
    you: false,
    owner: false,
    abilities: ["data/read"],
    ...extra,
  });

  it("counts other people, not the reader's person, its devices or open invitations", async () => {
    const sections = await pairingSections({
      resources: async () => [
        { resourceId: "a", name: "Launch" },
        { resourceId: "b", name: "Broken" },
        { resourceId: "c", name: "Draft" },
      ],
      status: async (id) => {
        if (id === "b") throw new Error("no chain");
        return id === "a"
          ? {
              coordinator: "wss://new.example/v1/ws",
              controlSeq: "3",
              participants: [
                person("aa", {
                  you: true,
                  owner: true,
                  devices: [
                    {
                      principal: "bb",
                      fingerprint: "bbbb-bbbb-bbbb-bbbb",
                      kind: "personal",
                      status: "active",
                      you: true,
                    },
                  ],
                }),
                person("cc"),
                person("dd", { invitation: { used: "0", limit: "1" } }),
              ],
            }
          : {
              coordinator: null,
              controlSeq: "0",
              participants: [person("ee", { you: true, owner: true })],
            };
      },
      identityServer: (url) => url === "wss://new.example/v1/ws",
    });
    expect(sections).toEqual([
      { name: "Launch", others: 1, identityServer: true },
      { name: "Broken", others: null, identityServer: null },
      { name: "Draft", others: 0, identityServer: null },
    ]);
  });
});

describe("its facts from a real collaboration status (review obsidian#106 R1)", () => {
  const running: LfcpRuntime[] = [];
  afterEach(async () => {
    for (const r of running.splice(0)) await r.stop();
  });

  it("a section without a validated Control Chain has unknown people, and is warned about", async () => {
    const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
    running.push(runtime);
    // A registry row whose chain is not stored (yet): status() answers, with no participants.
    const R = generateResourceId();
    await (runtime.storage as LfcpStorage).commit([
      {
        op: "put-resource",
        row: { resourceId: R, dataProfile: SECTIONS_PROFILE_ID, localPrincipal: null, labels: {} },
      },
    ]);
    const collab = new Collaboration(runtime, { sleep, connectTimeoutMs: 50 });
    const sections = await pairingSections({
      resources: async () => [{ resourceId: toBase64url(R), name: "Unread" }],
      status: (id) => collab.status(fromBase64url(id) as ResourceId),
      identityServer: () => true,
    });
    expect(sections).toEqual([{ name: "Unread", others: null, identityServer: null }]);
    expect(firstPairingWarning({ firstPairing: true, sections })?.unknown).toEqual([
      '"Unread" (who uses it is not known yet)',
    ]);
  });
});
