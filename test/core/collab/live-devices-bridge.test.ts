// IDENTITY draft §7.4 scenario 3 against the reference server
// (LFCP-04-414): a bridge paired headless as a service device with
// `lfcp-node pair` of @openlfcp/storage-node 0.3.0 (its built CLI, run as
// a child process), approved from the plugin's "Add my other device…".
// The link goes in on standard input, never on the command line.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectionNetwork,
  createInvitation,
  fetchDeks,
  IdentityRefused,
  syncChain,
} from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
import { InvitationSecret } from "@openlfcp/crypto";
import { InMemoryLfcpStorage } from "@openlfcp/storage";
import { FileSecretStore, openInstallation, PAIR_EXIT } from "@openlfcp/storage-node";
import { invitationPrincipal, signControlRecord } from "@openlfcp/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPreset } from "../../../src/core/identity/pairing-view";
import { authorLabel, fingerprintOf, shortId } from "../../../src/core/identity/people";
import { type LiveDevices, until, LiveDevices as World } from "../../support/live-devices";
import { type LiveServer, liveSkipReason, startLiveServer } from "../../support/live-server";
import { guardChild } from "../../support/reaper.mjs";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

const skip = liveSkipReason();
let server: LiveServer | undefined;
let world: LiveDevices | undefined;
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  await world?.stop();
  await server?.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  world = undefined;
  server = undefined;
});

/** The built CLI of @openlfcp/storage-node (the `lfcp-node` bin), as installed here. */
const CLI = fileURLToPath(
  new URL("../../../node_modules/@openlfcp/storage-node/dist/cli.js", import.meta.url),
);

/** `lfcp-node pair <args>`, the link piped in on standard input. */
function pairCli(args: readonly string[], link: string) {
  const child = spawn(process.execPath, [CLI, "pair", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const release = guardChild(child, []);
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
  });
  child.stderr?.on("data", (d) => {
    err += String(d);
  });
  child.stdin?.end(`${link}\n`);
  const exited = new Promise<number | null>((r) =>
    child.once("exit", (code) => {
      release();
      r(code);
    }),
  );
  return { output: () => out, stderr: () => err, exited };
}

describe("§7.4 scenario 3: the bridge CLI", () => {
  it("pairs headless as a service for two sections; attributed via the bridge; cannot invite, nor open a third section or the device list", async (ctx) => {
    if (skip !== null) ctx.skip(`no reference server: ${skip}`);
    server = await startLiveServer();
    world = new World(server.url);
    const mac = await world.installation("Mac");
    const notes = await mac.section("Notes");
    const tasks = await mac.section("Tasks");
    const mail = await mac.section("Mail");
    await mac.write(notes, "for the bridge");
    const session = await mac.service.startSession("Mac");
    if (session.kind !== "link" || session.result.kind !== "created")
      throw new Error(JSON.stringify(session));
    const I = await mac.service.identity();
    if (I === undefined) throw new Error("no device list");

    const state = mkdtempSync(join(tmpdir(), "lfcp-bridge-"));
    dirs.push(state);
    const link = session.result.link.reveal();
    const cli = pairCli(
      [
        "-",
        "--state",
        state,
        "--label",
        "notes bridge",
        "--section",
        "Notes",
        "--section",
        "Tasks",
        "--wait",
        "120",
        "--poll",
        "1",
      ],
      link,
    );
    await until("the bridge's fingerprint", () => /Fingerprint: \S+/.test(cli.output()), 60_000);
    const shown = /Fingerprint: (\S+)/.exec(cli.output())?.[1];
    expect(cli.output()).toContain('"notes bridge" (service) asks to join Notes, Tasks');
    // The link is a bearer secret: never printed.
    expect(cli.output()).not.toContain(link);
    expect(cli.output()).not.toContain("#secret=");

    // The managing device: the same fingerprint, a service asking for two sections.
    const reviews = await until("the bridge's request", async () => {
      const r = await mac.service.requests(session.session);
      return Array.isArray(r) && r.length > 0 ? r : undefined;
    });
    const review = reviews[0];
    if (review === undefined) throw new Error("no request");
    expect(review.fingerprint).toBe(shown);
    expect(review.kind).toBe(1);
    expect(defaultPreset(review)).toBe("service");
    expect(review.requestedScope.map(toHex).sort()).toEqual([toHex(notes), toHex(tasks)].sort());
    const approved = await mac.service.approve(review, "service", review.requestedScope);
    expect(approved.kind).toBe("done");

    expect(await cli.exited).toBe(PAIR_EXIT.DONE);
    expect(cli.stderr()).toBe("");
    expect(cli.output()).toContain("Approved: Service (service device).");
    expect(cli.output()).toContain("  Notes: ready");
    expect(cli.output()).toContain("  Tasks: ready");

    // The bridge, with the installation the command made.
    const bridge = await openInstallation(state, new FileSecretStore(join(state, "secrets")));
    const id = toHex(bridge.signer.descriptor.principalId);
    expect(fingerprintOf(id)).toBe(shown);
    // Its edits are the person's, via the bridge (on the managing device's chain of Notes).
    await until("the bridge in Notes on the Mac", async () =>
      (await mac.runtime.people(notes)).devices(mac.me).some((d) => d.principal === id)
        ? true
        : undefined,
    );
    const people = await mac.runtime.people(notes);
    const alias = { [shortId(mac.me)]: "Olga" };
    expect(authorLabel(people, id, alias)).toBe(`Olga (via ${fingerprintOf(id)})`);
    const list = await mac.service.devices();
    if (list.kind !== "list") throw new Error(list.kind);
    expect(list.rows.find((r) => r.principal === id)).toMatchObject({
      kind: "service",
      preset: "service",
      state: "active",
    });

    const network = connectionNetwork({
      now: () => Date.now(),
      timeout: () => new Promise((r) => setTimeout(r, 15_000)),
    });
    const channel = await network.connect(bridge.signer, server.url);
    try {
      const storage = new InMemoryLfcpStorage();
      const secrets = new FileSecretStore(join(state, "secrets"));
      // Its two sections open; Mail (not requested) and the device list do not.
      const n = await syncChain(storage, channel, notes);
      expect((await fetchDeks(storage, secrets, channel, n, bridge)).size).toBeGreaterThan(0);
      await syncChain(storage, channel, tasks);
      await expect(syncChain(storage, channel, mail)).rejects.toBeInstanceOf(IdentityRefused);
      await expect(syncChain(storage, channel, I)).rejects.toBeInstanceOf(IdentityRefused);

      // An invitation from the bridge is refused: its access cannot grant (the Service preset).
      const dek = (await fetchDeks(storage, secrets, channel, n, bridge)).get(
        String(n.state.epoch.epoch),
      );
      if (dek === undefined) throw new Error("no key of Notes");
      await expect(
        createInvitation({
          storage,
          resourceId: notes,
          inviter: bridge.signer,
          dek,
          endpoints: [server.url],
        }),
      ).rejects.toThrow(/does not validate/);
      // And the server refuses the grant record itself.
      const grant = signControlRecord(
        { resourceId: notes, controlSeq: n.state.seq + 1n, prevControlId: n.state.head },
        {
          type: "CAPABILITY_GRANT",
          subject: invitationPrincipal(InvitationSecret.generate()),
          abilities: [1n, 2n, 11n],
          delegable: [],
          claimLimit: 1n,
        },
        bridge.signer,
      );
      const answer = await channel.putControl(notes, n.state.head, grant.bytes);
      expect(answer.kind).toBe("nack");
    } finally {
      channel.close();
    }
  });
});
