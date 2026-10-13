// A removed member opens a new invitation to the section it was removed
// from (beta.15). Rejoining is MVP 0.3: the join answers "removed" before
// any claim, uses nothing and changes nothing, and the user is told in
// plain words that their local copy stays. Not "already-member", which
// read as if nothing were wrong.

import * as client from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";
import { PROFILE_ID } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollabCommands, type Prompter } from "../../../src/core/collab/commands";
import { REMOVED_REJOIN } from "../../../src/core/collab/messages";
import { Collaboration, type CollabRuntime } from "../../../src/core/collab/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { MutationGuard } from "../../../src/core/projection/guard";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";

vi.mock("@openlfcp/client", async (original) => ({
  ...(await original<typeof import("@openlfcp/client")>()),
  acceptInvitation: vi.fn(),
}));
const accept = vi.mocked(client.acceptInvitation);

const SERVER = "wss://offline.example.invalid/v1/ws";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  accept.mockReset();
  for (const r of running.splice(0)) await r.stop();
});

/** A real one-time link to an owner's collaboration (created and invited offline). */
async function invitation(): Promise<{ link: string; R: ResourceId }> {
  const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(runtime);
  const owner = new Collaboration(runtime, { sleep, connectTimeoutMs: 50, ackTimeoutMs: 50 });
  const { resourceId: R } = await owner.create({ name: "Team", server: SERVER });
  return { link: (await owner.invite(R, "read-write")).link.reveal(), R };
}

/** A runtime that holds the Resource, with what it knows of this vault's access. */
function holding(o: {
  readonly profile?: string;
  readonly refusal?: string | null;
  readonly access?: { allowed: boolean; reason: string | null } | Error;
}) {
  const writes: string[] = [];
  const runtime = {
    status: { kind: "ready" },
    collaborationContext: () => ({
      storage: {
        resources: { get: async () => ({ dataProfile: o.profile ?? SECTIONS_PROFILE_ID }) },
      },
    }),
    hasResource: async () => true,
    refusal: () => (o.refusal === undefined || o.refusal === null ? null : { code: o.refusal }),
    canWriteSection: async () => {
      if (o.access instanceof Error) throw o.access;
      return o.access ?? { allowed: true, reason: null };
    },
    localState: {
      get: async () => undefined,
      put: async (key: string) => {
        writes.push(key);
      },
    },
  } as unknown as CollabRuntime;
  return { collab: new Collaboration(runtime, { sleep, sections: true }), writes };
}

describe("Join with a new invitation after being removed", () => {
  for (const reason of ["revoked", "server-refused"])
    it(`a section whose access is ${reason}: removed, no claim, nothing written`, async () => {
      const { link, R } = await invitation();
      const { collab, writes } = holding({ access: { allowed: false, reason } });
      expect(await collab.join(link, { name: "Again" })).toEqual({
        kind: "removed",
        resourceId: R,
      });
      expect(accept).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });

  it("a collaboration the server refuses for good (AUTHORIZATION_FAILED): removed", async () => {
    const { link, R } = await invitation();
    const { collab } = holding({ profile: PROFILE_ID, refusal: "AUTHORIZATION_FAILED" });
    expect(await collab.join(link, { name: "Again" })).toEqual({ kind: "removed", resourceId: R });
    expect(accept).not.toHaveBeenCalled();
  });

  it("still a member (writer, reader, access not known yet, another refusal): already a member", async () => {
    const { link, R } = await invitation();
    for (const o of [
      { access: { allowed: true, reason: null } },
      { access: { allowed: false, reason: "read-only" } },
      { access: { allowed: false, reason: "unknown" } },
      { access: new Error("not open") },
      { profile: PROFILE_ID, refusal: "RESOURCE_NOT_HOSTED" },
    ]) {
      const { collab, writes } = holding(o);
      expect(await collab.join(link, { name: "Again" })).toEqual({
        kind: "already-member",
        resourceId: R,
      });
      expect(writes).toEqual([]);
    }
    expect(accept).not.toHaveBeenCalled();
  });
});

describe("what Join collaboration says to a removed member", () => {
  it("in plain words: removed, rejoining not supported yet, the local copy stays", async () => {
    const notices: string[] = [];
    const texts = ["lfcp://join/x", "Again"];
    const prompter = {
      notice: (m: string) => void notices.push(m),
      text: async () => texts.shift() ?? null,
      progress: () => ({ update: () => undefined, close: () => undefined }),
    } as unknown as Prompter;
    const commands = new CollabCommands({
      collab: () =>
        ({
          join: async () => ({ kind: "removed", resourceId: new Uint8Array(32) as ResourceId }),
        }) as unknown as Collaboration,
      prompter,
      notes: {} as never,
      guard: new MutationGuard(),
      placement: () => "child-line",
      defaultServer: () => SERVER,
    } as never);
    await commands.joinCollaboration();
    expect(notices.at(-1)).toBe(`Shared Tasks: ${REMOVED_REJOIN}`);
    expect(REMOVED_REJOIN).toBe(
      "You were removed from this section. Rejoining a section you were removed from isn't supported yet; your local copy stays on this device.",
    );
  });
});
