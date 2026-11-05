// LFCP-04-413: the device flows (draft §9 O2 + O3) over the real runtime
// and storage, with the SDK's identity flows replaced by recorded fakes:
// what the service passes to each flow, and what it makes of each result
// kind, `document-incomplete` and the display flag of a removal included.
// The flows themselves are the SDK's (tested there, against a coordinator).

import {
  type ApprovalResult,
  type CancelResult,
  type CreatedIdentityResource,
  IdentityConflict,
  IdentityUnavailable,
  PairingLinkText,
  type PairingOutcome,
  type PairingReview,
  type PairingSessionResult,
  type RequestPairingResult,
  type RevocationPreview,
  type RevokeDeviceResult,
  type RotationOutcome,
  saveControlChain,
  setLocalIdentityResource,
} from "@openlfcp/client";
import {
  fromHex,
  generateResourceId,
  type PrincipalId,
  type ResourceId,
  resourceId,
  toHex,
} from "@openlfcp/core";
import { validateControlChain } from "@openlfcp/wire";
import { afterEach, describe, expect, it } from "vitest";
import type { Collaboration } from "../../../src/core/collab/service";
import { type IdentityFlows, SDK_IDENTITY_FLOWS } from "../../../src/core/identity/flows";
import { NO_DEVICE_SUPPORT, OFFLINE } from "../../../src/core/identity/pairing-view";
import { DEVICE_LABELS_KEY, fingerprintOf } from "../../../src/core/identity/people";
import { DeviceService } from "../../../src/core/identity/service";
import { LfcpRuntime } from "../../../src/core/lfcp/runtime";
import { Device, FakeLocal, sleep } from "../../support/lfcp-env";
import { P, X } from "./x-chain";

const URL = "wss://sync.example";
const running: LfcpRuntime[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

type Calls = Record<string, unknown[]>;

/** Flows that answer from `answers` and record what they were given; the network is offline. */
function fakeFlows(answers: Partial<Record<keyof IdentityFlows, unknown>>, calls: Calls) {
  const flows: Record<string, unknown> = { ...SDK_IDENTITY_FLOWS };
  for (const [name, answer] of Object.entries(answers))
    flows[name] = async (...args: unknown[]) => {
      calls[name] = [...(calls[name] ?? []), args[0]];
      return typeof answer === "function"
        ? (answer as (...a: unknown[]) => unknown)(...args)
        : answer;
    };
  flows.connectionNetwork = () => ({
    connect: () => Promise.reject(new IdentityUnavailable("offline")),
  });
  return flows as unknown as IdentityFlows;
}

async function setup(
  answers: Partial<Record<keyof IdentityFlows, unknown>> = {},
  options: { readonly defaultServer?: string; readonly collab?: Partial<Collaboration> } = {},
) {
  const runtime = await LfcpRuntime.start(new Device().env(new FakeLocal()));
  running.push(runtime);
  const calls: Calls = {};
  const service = new DeviceService({
    runtime: () => ({ registry: () => runtime.registry(), localState: runtime.localState }),
    context: () => runtime.collaborationContext(),
    collab: () => (options.collab ?? null) as Collaboration | null,
    defaultServer: () => options.defaultServer ?? URL,
    platform: "desktop",
    sections: true,
    sleep,
    flows: fakeFlows(answers, calls),
  });
  return { runtime, service, calls };
}

const rotation = (status: RotationOutcome["status"]): RotationOutcome => ({
  resource: generateResourceId(),
  status,
});

function review(o: Partial<PairingReview> = {}): PairingReview {
  return {
    session: "s1",
    requestKey: "p:abc",
    device: fromHex(P("DEV_B")) as PrincipalId,
    descriptor: "",
    label: "Phone",
    platform: "mobile",
    kind: 0,
    requestedScope: [],
    fingerprint: "aaaa-bbbb-cccc-dddd",
    presets: [
      { preset: "full", offered: true },
      { preset: "edit", offered: true },
      { preset: "read", offered: true },
      { preset: "service", offered: false, reason: "not a service request" },
    ],
    requestChanges: [],
    tuple: "t",
    ...o,
  };
}

describe("Add my other device… (O2)", () => {
  it("creates the device list on first use, from this vault's sections, then the session and its link", async () => {
    const link = new PairingLinkText("lfcp://pair/x#secret=y");
    const { runtime, service, calls } = await setup({
      createIdentityResource: { kind: "created" } as CreatedIdentityResource,
      openPairingSessions: [],
      createPairingSession: {
        kind: "created",
        session: "s1",
        pairingDevice: fromHex(P("PAIR_J")) as PrincipalId,
        link,
      } satisfies PairingSessionResult,
    });
    const R = await runtime.createSectionResource({
      name: "Plans",
      endpoints: [URL],
      coordinatorUrl: URL,
    });
    await runtime.setLocalName(R, "Plans");
    const view = await service.startSession("Desk");
    expect(view.kind).toBe("link");
    if (view.kind === "link" && view.result.kind === "created")
      expect(view.result.link.reveal()).toBe("lfcp://pair/x#secret=y");
    const create = calls.createIdentityResource?.[0] as {
      url: string;
      label: string;
      platform: string;
      roster: { resource: ResourceId; entry: { coordinator: string; name?: string } }[];
    };
    expect(create).toMatchObject({ url: URL, label: "Desk", platform: "desktop" });
    expect(
      create.roster.map((r) => [toHex(r.resource), r.entry.coordinator, r.entry.name]),
    ).toEqual([[toHex(R), URL, "Plans"]]);
    // The link is never in what the service passes or keeps.
    expect(JSON.stringify(calls)).not.toContain("secret=y");
  });

  it("stops before anything when the server does not support devices (§5.1 step 1)", async () => {
    const { service, calls } = await setup({
      createIdentityResource: { kind: "unsupported" } as CreatedIdentityResource,
      createPairingSession: { kind: "conflict" },
    });
    expect(await service.startSession("Desk")).toEqual({
      kind: "stop",
      message: NO_DEVICE_SUPPORT,
    });
    expect(calls.createPairingSession).toBeUndefined();
  });

  it("needs a default server for the device list", async () => {
    const { service, calls } = await setup({}, { defaultServer: " " });
    expect((await service.startSession("Desk")).kind).toBe("stop");
    expect(calls.createIdentityResource).toBeUndefined();
  });

  it("shows an open session's link again rather than making a second one", async () => {
    const { runtime, service, calls } = await setup({
      openPairingSessions: [{ session: "s0", identity: generateResourceId(), pairingDevice: null }],
      resumePairingSession: { kind: "unavailable", reason: "x" } satisfies PairingSessionResult,
      createPairingSession: { kind: "conflict" },
    });
    const ctx = runtime.collaborationContext();
    if (ctx === null) throw new Error("not ready");
    await setLocalIdentityResource(ctx.storage, generateResourceId());
    expect(await service.startSession("Desk")).toEqual({ kind: "stop", message: OFFLINE });
    expect(calls.createIdentityResource).toBeUndefined();
    expect(calls.createPairingSession).toBeUndefined();
    expect(calls.resumePairingSession).toHaveLength(1);
  });

  it("requests: offline is asked again (null); a forked device list stops", async () => {
    const offline = await (
      await setup({
        pairingRequests: () => {
          throw new IdentityUnavailable("offline");
        },
      })
    ).service.requests("s1");
    expect(offline).toBeNull();
    const forked = await (
      await setup({
        pairingRequests: () => {
          throw new IdentityConflict(generateResourceId(), "forked");
        },
      })
    ).service.requests("s1");
    expect(forked).toMatchObject({ kind: "stop" });
  });

  it("approves with the chosen preset and reports what is left for later", async () => {
    const R = generateResourceId();
    const { service, calls } = await setup({
      approvePairing: {
        kind: "approved",
        operation: "op1",
        device: fromHex(P("DEV_B")) as PrincipalId,
        chain: {} as never,
        registrations: [{ resource: R, status: "unsupported" }],
        rotation: rotation("rotated"),
      } satisfies ApprovalResult,
    });
    const view = await service.approve(review(), "edit");
    expect(view.kind).toBe("done");
    expect(view.message).toContain('Added "Phone"');
    expect(view.message).toContain("On a server without device support");
    expect(calls.approvePairing?.[0]).toMatchObject({ preset: "edit" });
  });

  it("an approval whose device entry was refused is not success: Finish resumes it", async () => {
    let resumed = 0;
    const { service, calls } = await setup({
      approvePairing: {
        kind: "document-incomplete",
        operation: "op1",
        device: fromHex(P("DEV_B")) as PrincipalId,
        chain: {} as never,
        registrations: [],
        rotation: rotation("not-needed"),
        code: "AUTHORIZATION_FAILED",
      } satisfies ApprovalResult,
      resumeApproval: () => {
        resumed++;
        return {
          kind: "approved",
          operation: "op1",
          device: fromHex(P("DEV_B")) as PrincipalId,
          chain: {} as never,
          registrations: [],
          rotation: rotation("not-needed"),
        } satisfies ApprovalResult;
      },
    });
    const view = await service.approve(review(), "edit");
    expect(view).toMatchObject({ kind: "finish", operation: "op1" });
    expect(view.message).toContain("not finished");
    expect(view.message).not.toContain("Added");
    const finished = await service.finishApproval("op1", "Phone");
    expect(finished.kind).toBe("done");
    expect(resumed).toBe(1);
    expect(calls.resumeApproval?.[0]).toBeDefined();
  });

  it("a changed request is shown again; a superseded one signs nothing", async () => {
    const next = review({ label: "Phone 2" });
    const reconfirm = await (
      await setup({ approvePairing: { kind: "reconfirm", review: next } satisfies ApprovalResult })
    ).service.approve(review(), "edit");
    expect(reconfirm).toMatchObject({ kind: "reconfirm", review: next });
    const superseded = await (
      await setup({
        approvePairing: { kind: "superseded", operation: "op" } satisfies ApprovalResult,
      })
    ).service.approve(review(), "edit");
    expect(superseded.kind).toBe("stop");
  });

  it("a service request is approved within its scope only", async () => {
    const A = generateResourceId();
    const B = generateResourceId();
    const { service, calls } = await setup({
      approvePairing: { kind: "conflict" } satisfies ApprovalResult,
    });
    await service.approve(review({ kind: 1, requestedScope: [A, B] }), "service", [A]);
    expect(calls.approvePairing?.[0]).toMatchObject({ scope: [A] });
  });

  it("rejecting: a refused request deletion says the request stays, and the same call retries", async () => {
    const { service, calls } = await setup({
      cancelPairing: {
        kind: "document-incomplete",
        rotation: rotation("rotated"),
        code: "QUOTA_EXCEEDED",
      } satisfies CancelResult,
    });
    const view = await service.cancel("s1", "p:abc");
    expect(view.kind).toBe("retry");
    expect(view.message).toContain("QUOTA_EXCEEDED");
    expect(calls.cancelPairing?.[0]).toMatchObject({ session: "s1", reject: "p:abc" });
  });

  it("previews a removal: what it suspends and who changes the key", async () => {
    const R = generateResourceId();
    const { service } = await setup({
      previewRevocation: {
        device: fromHex(P("DEV_C")) as PrincipalId,
        selfDependent: false,
        resources: [
          {
            resource: R,
            status: "ok",
            suspended: [fromHex(P("DEV_E")) as PrincipalId],
            exposing: true,
            rotator: false,
          },
        ],
      } satisfies RevocationPreview,
    });
    const view = await service.previewRemoval(P("DEV_C"));
    if ("kind" in view) throw new Error(view.message);
    expect(view.blocked).toBeNull();
    expect(view.suspended).toEqual([P("DEV_E")]);
    expect(view.lines.join(" ")).toContain(fingerprintOf(P("DEV_E")));
    expect(view.lines.join(" ")).toContain("not by this device");
  });

  it("a removal that depends on the removed device is blocked before anything (§8.1)", async () => {
    const { service } = await setup({
      previewRevocation: {
        device: fromHex(P("DEV_C")) as PrincipalId,
        selfDependent: true,
        resources: [],
      } satisfies RevocationPreview,
    });
    const view = await service.previewRemoval(P("DEV_C"));
    expect("blocked" in view && view.blocked).toContain("Re-certify");
  });

  it("a removal whose display flag was refused offers Try again with its operation", async () => {
    const { service, calls } = await setup({
      revokeDevice: {
        kind: "revoked",
        operation: "rv1",
        results: [],
        document: { state: "refused", code: "AUTHORIZATION_FAILED" },
      } satisfies RevokeDeviceResult,
    });
    const view = await service.remove(P("DEV_C"), 1n, "Old phone");
    expect(view).toMatchObject({ kind: "retry", operation: "rv1" });
    expect(view.message).toContain('Removed "Old phone"');
    expect(view.message).toContain("AUTHORIZATION_FAILED");
    expect(calls.revokeDevice?.[0]).toMatchObject({ reason: 1n });
    const done = await (
      await setup({
        revokeDevice: {
          kind: "revoked",
          operation: "rv1",
          results: [],
          document: { state: "committed-own" },
        } satisfies RevokeDeviceResult,
      })
    ).service.remove(P("DEV_C"), 1n, "Old phone", "rv1");
    expect(done.kind).toBe("done");
  });

  it("an offline removal is refused, not queued (§8.5)", async () => {
    const { service } = await setup({
      revokeDevice: { kind: "unavailable", reason: "offline" } satisfies RevokeDeviceResult,
    });
    expect((await service.remove(P("DEV_C"), 0n, "x")).kind).toBe("stop");
  });
});

describe("the device list", () => {
  it("says there is none before the first pairing", async () => {
    const { service } = await setup();
    expect(await service.devices()).toEqual({ kind: "none" });
  });

  it("offline, shows this device's last copy with the labels it kept", async () => {
    const { runtime, service } = await setup();
    const ctx = runtime.collaborationContext();
    if (ctx === null) throw new Error("not ready");
    // X's chain stands in for the Identity Resource: the list reads only its Control state.
    const chain = validateControlChain(X.records.map((r) => fromHex(r.cose_sign1)));
    if (chain.kind !== "linear") throw new Error("fixture");
    expect((await saveControlChain(ctx.storage, chain, null)).ok).toBe(true);
    await setLocalIdentityResource(ctx.storage, resourceId(chain.state.resourceId));
    await runtime.localState.put(DEVICE_LABELS_KEY, { [P("DEV_B")]: "Laptop" });
    const list = await service.devices();
    if (list.kind !== "list") throw new Error(list.kind);
    expect(list.current).toBe(false);
    expect(list.note).toContain("last copy");
    expect(list.rows.map((r) => r.label)).toContain("Laptop");
    // This installation is not one of the person's devices: it manages nothing.
    expect(list.manages).toBe(false);
  });
});

describe("Pair this device with a link… (O3)", () => {
  it("refuses a vault that already shares sections under its own identity", async () => {
    const { runtime, service, calls } = await setup({ requestPairing: { kind: "conflict" } });
    await runtime.createSectionResource({ name: "Mine", endpoints: [URL], coordinatorUrl: URL });
    const view = await service.request("lfcp://pair/x#secret=y", "Phone");
    expect(view.kind).toBe("stop");
    expect(calls.requestPairing).toBeUndefined();
  });

  it("requests as a personal device of this platform, and shows the fingerprint to compare", async () => {
    const { service, calls } = await setup({
      requestPairing: {
        kind: "requested",
        operation: "rq1",
        identity: generateResourceId(),
        fingerprint: "abcd-efgh-ijkl-mnop",
      } satisfies RequestPairingResult,
    });
    const view = await service.request("lfcp://pair/x#secret=y", "Phone");
    expect(view).toEqual({
      kind: "requested",
      operation: "rq1",
      fingerprint: "abcd-efgh-ijkl-mnop",
    });
    expect(calls.requestPairing?.[0]).toMatchObject({
      kind: 0,
      label: "Phone",
      platform: "desktop",
    });
    // The link went to the SDK as a PairingLinkText, never as plain text.
    expect(JSON.stringify(calls)).not.toContain("secret=y");
  });

  it("a used or cancelled link is rejected with a clear next step", async () => {
    const { service } = await setup({
      requestPairing: { kind: "not-a-session", reason: "J revoked" } satisfies RequestPairingResult,
    });
    const view = await service.request("lfcp://pair/x#secret=y", "Phone");
    expect(view.kind === "stop" && view.message).toContain("new one");
  });

  it("opens the ready sections of the roster, and only those", async () => {
    const ready = generateResourceId();
    const keys = generateResourceId();
    const opened: string[] = [];
    const collab: Partial<Collaboration> = {
      openFromRoster: async (R: ResourceId) => {
        opened.push(toHex(R));
        return true;
      },
    };
    const { service } = await setup(
      {
        completePairing: {
          kind: "approved",
          certificate: {} as never,
          candidates: [
            { resource: ready, status: "ready", name: "Plans" },
            { resource: keys, status: "waiting-for-keys", name: "Notes" },
          ],
          foreignCertificates: 0,
        } satisfies PairingOutcome,
      },
      { collab },
    );
    const view = await service.progress("rq1");
    expect(opened).toEqual([toHex(ready)]);
    expect(view.opened).toEqual(["Plans"]);
    expect(view.final).toBe(false);
    expect(view.sections).toEqual([
      { name: "Plans", status: "ready" },
      { name: "Notes", status: "waiting for keys" },
    ]);
  });

  it("a rejected request is final; waiting is not a decision", async () => {
    const rejected = await (
      await setup({ completePairing: { kind: "rejected" } satisfies PairingOutcome })
    ).service.progress("rq1");
    expect(rejected).toMatchObject({ final: true, approved: false });
    const waiting = await (
      await setup({ completePairing: { kind: "unavailable", reason: "offline" } })
    ).service.progress("rq1");
    expect(waiting).toMatchObject({ final: false, approved: false });
  });
});
