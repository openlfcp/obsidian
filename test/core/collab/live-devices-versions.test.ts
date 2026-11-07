// IDENTITY draft §7.4 scenarios 6, 7 and 8 against the reference server
// (LFCP-04-414): older versions of the plugin and an older server next to
// a person's devices.
//
// The older plugins run from their own checkouts, with their own SDK, as
// their tests run them (LfcpRuntime, Collaboration, test/support/lfcp-env):
//   LFCP_PLUGIN_0_6_0     Shared Tasks 0.6.0 (V_legacy, SDK 0.2.2)
//   LFCP_PLUGIN_V_NOTICE  obsidian f33bb4d, #105 (V_notice, SDK 0.2.2)
// each with its dependencies installed (pnpm install --frozen-lockfile).
// The older server is LFCP_OLD_SERVER_BIN, the reference server at
// server-legacy.lock (138030a, before identity-01). Without the reference
// server these tests skip as every live test does (LFCP_REQUIRE_LIVE=1: they
// fail). Without one of the older inputs the test that needs it skips with
// the reason; with LFCP_REQUIRE_VERSIONS=1 it fails instead (the platform
// smoke run does not provide them: docs/devel/testing/device-scenarios.md).

import { existsSync, readFileSync } from "node:fs";
import { loadControlChain } from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invite,
  type LiveDevices,
  type OlderPlugin,
  olderPlugin,
  pairDevice,
  serverChain,
  settled,
  until,
  LiveDevices as World,
} from "../../support/live-devices";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 });

const skip = liveSkipReason();
const servers: LiveServer[] = [];
const stops: (() => Promise<void>)[] = [];
let world: LiveDevices | undefined;

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s().catch(() => undefined);
  await world?.stop();
  for (const s of servers.splice(0)) await s.stop();
  world = undefined;
});

type Ctx = { skip(note?: string): never };

/** What a test needs besides the server, or a skip (a failure in a gate) naming it. */
function needs(ctx: Ctx, what: string, value: string | undefined, why: string): string {
  if (skip !== null) ctx.skip(`no reference server: ${skip}`);
  if (value !== undefined && value !== "" && existsSync(value)) return value;
  const reason = `${what} is not set or does not exist (${why})`;
  if (process.env.LFCP_REQUIRE_VERSIONS === "1")
    throw new Error(`LFCP_REQUIRE_VERSIONS=1 but this test would skip: ${reason}`);
  ctx.skip(reason);
}

async function live(): Promise<LiveDevices> {
  const server = await startLiveServer();
  servers.push(server);
  world = new World(server.url);
  return world;
}

async function older(version: string, root: string, url: string): Promise<OlderPlugin> {
  return olderPlugin(version, root, url);
}

describe("§7.4 scenario 6: a person on 0.6.0 updates", () => {
  it("nothing of a Resource changes; the warning comes before the first pairing; Add my other device creates the device list", async (ctx) => {
    const root = needs(
      ctx,
      "LFCP_PLUGIN_0_6_0",
      process.env.LFCP_PLUGIN_0_6_0,
      "a checkout of 0.6.0",
    );
    const w = await live();
    const v060 = await older("0.6.0", root, w.url);
    // On 0.6.0: a section, shared with a colleague, written by both.
    const before = await v060.start("Mac on 0.6.0");
    stops.push(() => before.runtime.stop());
    const plans = await before.section("Plans");
    await before.write(plans, "written on 0.6.0");
    const bob = await w.installation("Bob");
    const invitation = await before.collab.invite(plans, "read-write");
    expect((await bob.collab.join(invitation.link.reveal(), { name: "Plans" })).kind).toBe(
      "joined",
    );
    await bob.write(plans, "by Bob");
    await until("Bob's edit on 0.6.0", () => before.texts(plans).includes("by Bob"));
    const head = (await serverChain(bob, plans)).state;
    const principal = toHex(before.runtime.status.principalId as Uint8Array);
    await before.runtime.stop();
    stops.pop();

    // Updated: the same installation on this version (the sections host opens its sections at start).
    const mac = await w.installation("Mac", before.state);
    await mac.runtime.openSection(plans);
    expect(mac.me).toBe(principal);
    expect((await mac.runtime.registry()).map((e) => e.localName)).toEqual(["Plans"]);
    await until("the section open after the update", () =>
      mac.texts(plans).includes("by Bob") ? true : undefined,
    );
    expect([...mac.texts(plans)].sort()).toEqual(["by Bob", "written on 0.6.0"]);
    // No change in any Resource: the same chain on the server and here.
    const after = (await serverChain(bob, plans)).state;
    expect([after.seq, toHex(after.head)]).toEqual([head.seq, toHex(head.head)]);
    const stored = await loadControlChain(
      mac.runtime.collaborationContext()?.storage as never,
      plans,
    );
    expect(stored?.kind === "linear" ? toHex(stored.state.head) : stored?.kind).toBe(
      toHex(head.head),
    );
    expect(await mac.service.identity()).toBeUndefined();

    // Before the first pairing: the warning names the shared section.
    const warning = await mac.service.firstPairingWarning();
    expect(warning?.title).toBe("Before you add your first other device");
    expect(warning?.affected).toEqual(['"Plans" (1 other person)']);
    // "Add my other device…" creates the device list, then the link.
    const session = await mac.service.startSession("Mac");
    expect(session.kind).toBe("link");
    expect(await mac.service.identity()).toBeDefined();
    expect(await mac.service.firstPairingWarning()).toBeNull();
  });
});

describe("§7.4 scenario 7: three generations", () => {
  it("0.6.0 past the barrier, V_notice blocked across a restart, and the same installation updated syncs", async (ctx) => {
    const legacyRoot = needs(
      ctx,
      "LFCP_PLUGIN_0_6_0",
      process.env.LFCP_PLUGIN_0_6_0,
      "a checkout of 0.6.0",
    );
    const noticeRoot = needs(
      ctx,
      "LFCP_PLUGIN_V_NOTICE",
      process.env.LFCP_PLUGIN_V_NOTICE,
      "a checkout of obsidian f33bb4d",
    );
    const w = await live();
    const mac = await w.installation("Mac");
    const plans = await mac.section("Plans");
    await mac.write(plans, "before the barrier");
    const v060 = await older("0.6.0", legacyRoot, w.url);
    const vNotice = await older("V_notice", noticeRoot, w.url);
    const legacy = await v060.start("Bob on 0.6.0");
    stops.push(() => legacy.runtime.stop());
    let notice = await vNotice.start("Carol on V_notice");
    stops.push(() => notice.runtime.stop());
    for (const o of [legacy, notice]) {
      const invitation = await mac.collab.invite(plans, "read-write");
      expect((await o.collab.join(invitation.link.reveal(), { name: "Plans" })).kind).toBe(
        "joined",
      );
      await until(`the section on ${o.name}`, () => o.texts(plans).includes("before the barrier"));
    }
    const legacyErrors: string[] = [];
    legacy.runtime.on((e) => {
      if (e.type === "error" && e.code !== undefined) legacyErrors.push(e.code);
    });

    // The barrier: the person pairs a device; it is registered in the section.
    const mac2 = await w.installation("Mac 2");
    await settled(mac2, (await pairDevice(mac, mac2, "full")).operation);
    await mac.write(plans, "after the barrier");

    // V_notice: blocked with the update message.
    await until("the block on V_notice", () =>
      notice.runtime.identityBlock?.(plans) ? true : undefined,
    );
    const noticeView = await viewOf(noticeRoot);
    const legacyView = await viewOf(legacyRoot);
    expect(noticeView(await notice.collab.status(plans))).toContain(
      "This section now uses a person's linked devices, which this version of Shared Tasks does not support. Update the plugin",
    );
    expect(notice.texts(plans)).not.toContain("after the barrier");
    // 0.6.0: its actual behaviour, recorded.
    await until("0.6.0 to stop on the chain", () => (legacyErrors.length > 0 ? true : undefined));
    const legacyStatus = await legacy.collab.status(plans);
    expect(legacy.texts(plans)).not.toContain("after the barrier");
    // Recorded on 0.6.0 with SDK 0.2.2: the session stops with the error code INTERNAL
    // (the draft expected a generic chain error, INVALID_CONTROL_CHAIN).
    expect(legacyErrors).toContain("INTERNAL");
    expect(legacy.runtime.phase(plans)).not.toBe("LIVE");
    // What 0.6.0 shows (a chain error, no update message): recorded for the report.
    const legacyText = legacyView(legacyStatus);
    console.log(
      "0.6.0 past the barrier:",
      JSON.stringify({ errors: [...new Set(legacyErrors)], phase: legacy.runtime.phase(plans) }),
      legacyText,
    );
    expect(legacyText).not.toContain("linked devices");
    // It shows the section as offline (control sync), not as a chain error.
    expect(legacyText).toContain("Sync: Offline");
    expect(legacyText).toContain("(control sync)");

    // V_notice restarted: still blocked, from its stored state.
    const state = notice.state;
    await notice.runtime.stop();
    stops.pop();
    notice = await vNotice.start("Carol on V_notice", state);
    stops.push(() => notice.runtime.stop());
    await notice.runtime.openSection(plans).catch(() => undefined);
    expect(notice.runtime.identityBlock?.(plans)).toBeTruthy();
    expect(noticeView(await notice.collab.status(plans))).toContain(
      "This section now uses a person's linked devices",
    );

    // Updated to this version: the same installation syncs past the barrier.
    await notice.runtime.stop();
    stops.pop();
    const carol = await w.installation("Carol", state);
    await carol.runtime.openSection(plans);
    await until("the edit after the barrier on the updated installation", () =>
      carol.texts(plans).includes("after the barrier") ? true : undefined,
    );
    expect(carol.runtime.identityBlock(plans)).toBeNull();
    await carol.write(plans, "by Carol, updated");
    await until("Carol's edit on the person's second device", () =>
      mac2.texts(plans).includes("by Carol, updated"),
    );
  });
});

describe("§7.4 scenario 8: a server without identity-01", () => {
  it("pairing skips its section and lists it; after the server's update, reconciliation adds the device and its keys", async (ctx) => {
    const oldBin = needs(
      ctx,
      "LFCP_OLD_SERVER_BIN",
      process.env.LFCP_OLD_SERVER_BIN,
      `the reference server at server-legacy.lock (${legacyCommit()}), without identity-01`,
    );
    const w = await live();
    const old = await startLiveServer({ bin: oldBin });
    servers.push(old);
    const mac = await w.installation("Mac");
    const plans = await mac.section("Plans");
    const archive = await mac.section("Archive", old.url);
    await mac.write(archive, "on the old server");

    // Before the first pairing: the old server's section is not changed now.
    const warning = await mac.service.firstPairingWarning();
    expect(warning).toBeNull(); // shared with no one: nothing to warn about

    const mac2 = await w.installation("Mac 2");
    const paired = await pairDevice(mac, mac2, "full");
    const view = await until("the pairing result on the second Mac", async () => {
      await new Promise((r) => setTimeout(r, 1000));
      const v = await mac2.service.progress(paired.operation);
      return v.sections.some((s) => s.name === "Plans" && s.status === "ready") ? v : undefined;
    });
    expect(view.sections).toContainEqual({
      name: "Archive",
      status: "on a server without device support",
    });
    expect(view.final).toBe(false);
    expect(await mac2.runtime.hasResource(archive)).toBe(false);
    expect(mac2.runtime.sectionProfile(plans)).toBeDefined();

    // The server is updated (the same state, the identity-01 binary).
    await old.stop(true);
    servers.splice(servers.indexOf(old), 1);
    const updated = await startLiveServer({ on: { dir: old.dir, port: old.port } });
    servers.push(updated);
    // The managing device's upkeep reconciles: the second Mac is added there, with the key.
    await until("the reconciliation on the first Mac", async () => {
      const r = await mac.service.upkeep(true);
      return r.offline ? undefined : r;
    });
    const done = await settled(mac2, paired.operation);
    expect(done.sections).toContainEqual({ name: "Archive", status: "ready" });
    await until("the old server's section on the second Mac", () =>
      mac2.texts(archive).includes("on the old server"),
    );
  });
});

/** An older version's own status view (its collab/view.ts): its banner and rows, as text. */
async function viewOf(root: string): Promise<(status: unknown) => string> {
  const view = (await import(/* @vite-ignore */ `${root}/src/core/collab/view.ts`)) as {
    statusView(s: unknown): {
      banner?: string | null;
      rows: readonly { label: string; value: string }[];
    };
  };
  return (status) => {
    const v = view.statusView(status);
    return [v.banner ?? "", ...v.rows.map((r) => `${r.label}: ${r.value}`)].join("\n");
  };
}

function legacyCommit(): string {
  try {
    const lock = JSON.parse(
      readFileSync(new URL("../../../server-legacy.lock", import.meta.url), "utf8"),
    ) as { commit?: string };
    return lock.commit?.slice(0, 7) ?? "unknown";
  } catch {
    return "unknown";
  }
}
