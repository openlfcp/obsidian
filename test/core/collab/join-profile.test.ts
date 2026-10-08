// Forward compatibility (0.3.2): joining a collaboration of another Data
// Profile (a newer plugin's shared sections, say). The SDK checks the
// profile from the Genesis before the claim (dataProfiles), so the one-time
// link stays unused and nothing is stored; the user is told to update the
// plugin and join again with the same link.

import * as client from "@openlfcp/client";
import type { ResourceId } from "@openlfcp/core";
import { PROFILE_ID } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Choice, CollabCommands, type Prompter } from "../../../src/core/collab/commands";
import { Collaboration } from "../../../src/core/collab/service";
import { LfcpRuntime, NEEDS_NEWER_VERSION } from "../../../src/core/lfcp/runtime";
import { MutationGuard } from "../../../src/core/projection/guard";
import { SECTIONS, storeForeign } from "../../support/foreign-resource";
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

async function offline() {
  const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(runtime);
  return {
    runtime,
    collab: new Collaboration(runtime, {
      sleep,
      connectTimeoutMs: 50,
      ackTimeoutMs: 50,
      joinTimeoutMs: 200,
    }),
  };
}

/** A real one-time link to an owner's collaboration (created and invited offline). */
async function invitation(): Promise<{ link: string; R: ResourceId }> {
  const owner = await offline();
  const { resourceId: R } = await owner.collab.create({ name: "Team", server: SERVER });
  return { link: (await owner.collab.invite(R, "read-write")).link.reveal(), R };
}

const unsupported = (R: ResourceId) =>
  ({
    kind: "profile-unsupported",
    resourceId: R,
    code: "PROFILE_UNSUPPORTED",
    dataProfile: SECTIONS,
  }) as const;

describe("Join a collaboration of another Data Profile (0.3.2)", () => {
  it("asks the SDK to refuse other profiles before the claim, and stores nothing", async () => {
    const { runtime, collab } = await offline();
    const { link, R } = await invitation();
    accept.mockResolvedValue(unsupported(R));
    const outcome = await collab.join(link, { name: "Launch" });
    expect(outcome).toEqual({ kind: "needs-newer-version", resourceId: R });
    expect(accept).toHaveBeenCalledOnce();
    expect(accept.mock.calls[0]?.[0].dataProfiles).toEqual([PROFILE_ID]);
    expect(await runtime.hasResource(R)).toBe(false);
    expect(await runtime.registry()).toEqual([]);
  });

  it("an already stored collaboration of another profile needs a newer version, without a claim", async () => {
    const { runtime, collab } = await offline();
    const { link, R } = await invitation();
    // As a newer plugin would have left it in this install's database.
    await storeForeign(runtime, SECTIONS, "Launch", R);
    expect(await collab.join(link, { name: "Launch" })).toEqual({
      kind: "needs-newer-version",
      resourceId: R,
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it("the command says to update the plugin and that the link was not used", async () => {
    const { collab } = await offline();
    const { link, R } = await invitation();
    accept.mockResolvedValue(unsupported(R));
    const notices: string[] = [];
    const texts = [link, "Launch"];
    const prompter: Prompter = {
      notice: (m) => void notices.push(m),
      text: async () => texts.shift() ?? null,
      choose: async <T>(_o: { readonly choices: readonly Choice<T>[] }) => null,
      invitation: async () => undefined,
      status: async () => undefined,
      progress: () => ({ update: () => undefined, close: () => undefined }),
    };
    const commands = new CollabCommands({
      collab: () => collab,
      prompter,
      notes: { active: () => null, rewrite: async () => undefined },
      guard: new MutationGuard(),
      placement: () => "child-line",
      defaultServer: () => SERVER,
    });
    await commands.joinCollaboration();
    expect(notices).toEqual([
      `Shared Tasks: could not join. ${NEEDS_NEWER_VERSION}, then join again with the same link: it has not been used.`,
    ]);
  });
});
