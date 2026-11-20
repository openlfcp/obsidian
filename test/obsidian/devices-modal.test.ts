// LFCP-04-413: the device dialogs over a scripted DeviceService: the link
// is revealed only on request; Approve waits for the fingerprint check; an
// approval that is not complete offers Finish, never "Added"; a removal
// shows its preview first; the new device shows its fingerprint and the
// sections it got.

import { PairingLinkText, type PairingReview, principalRefOf } from "@openlfcp/client";
import { type PrincipalId, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { describe, expect, it, vi } from "vitest";
import type { DeviceRow } from "../../src/core/identity/device-list";
import type { DeviceService } from "../../src/core/identity/service";
import OpenLfcpPlugin from "../../src/main";
import { AddDeviceModal, DevicesModal, PairThisDeviceModal } from "../../src/obsidian/ui/devices";
import * as mock from "../mocks/obsidian";
import { App, type FakeElement, modals } from "../mocks/obsidian";
import { FakeControl } from "../support/fake-control";

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

const button = (el: FakeElement, text: string): FakeElement => {
  const b = el.findAll("button").find((x) => x.text === text);
  if (b === undefined) throw new Error(`no button ${text} in: ${el.textContent}`);
  return b;
};

const review: PairingReview = {
  session: "s1",
  requestKey: "p:abc",
  device: new Uint8Array(32) as PrincipalId,
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
  ],
  requestChanges: [],
  tuple: "t",
};

const names = { resource: () => "Plans", device: () => "Laptop" };
const id = (n: number) => new Uint8Array(32).fill(n) as PrincipalId;
const root = { signer: id(1), writerClass: "root" as const };

function service(o: Partial<Record<keyof DeviceService, unknown>>): DeviceService {
  return { names: async () => names, ...o } as unknown as DeviceService;
}

describe("Add my other device…", () => {
  it("shows the link only on request, then the request with its fingerprint; Approve needs the check", async () => {
    const approved: unknown[] = [];
    const copied: string[] = [];
    const m = new AddDeviceModal(
      new App() as never,
      service({
        startSession: async () => ({
          kind: "link",
          session: "s1",
          result: {
            kind: "created",
            session: "s1",
            pairingDevice: new Uint8Array(32),
            link: new PairingLinkText("lfcp://pair/x#secret=y"),
          },
        }),
        requests: async () => [review],
        approve: async (...args: unknown[]) => {
          approved.push(args);
          return {
            kind: "finish",
            operation: "op1",
            message: '"Phone" is approved, but … adding it is not finished.',
          };
        },
      }),
      "Desk on computer",
      async (t) => {
        copied.push(t);
      },
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    // By now the request replaced the link; the link was never drawn as text.
    expect(el.textContent).not.toContain("secret=y");
    expect(el.textContent).toContain("aaaa-bbbb-cccc-dddd");
    expect(el.textContent).toContain("read-only");
    const approve = button(el, "Approve") as FakeElement & { disabled: boolean };
    expect(approve.disabled).toBe(true);
    const match = el.findAll("input").find((i) => i.type === "checkbox") as FakeElement & {
      checked: boolean;
    };
    match.checked = true;
    match.trigger("change");
    expect(approve.disabled).toBe(false);
    approve.click();
    await settle();
    expect(approved).toHaveLength(1);
    expect((approved[0] as unknown[])[1]).toBe("edit");
    expect(el.textContent).toContain("not finished");
    expect(el.textContent).not.toContain("Added");
    expect(button(el, "Finish")).toBeDefined();
    m.close();
  });

  it("Copy link copies, Show link reveals; nothing else does", async () => {
    const copied: string[] = [];
    const m = new AddDeviceModal(
      new App() as never,
      service({
        startSession: async () => ({
          kind: "link",
          session: "s1",
          result: {
            kind: "created",
            session: "s1",
            pairingDevice: new Uint8Array(32),
            link: new PairingLinkText("lfcp://pair/x#secret=y"),
          },
        }),
        requests: async () => [],
      }),
      "Desk",
      async (t) => {
        copied.push(t);
      },
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).not.toContain("secret=y");
    button(el, "Copy link").click();
    await settle();
    expect(copied).toEqual(["lfcp://pair/x#secret=y"]);
    expect(el.textContent).not.toContain("secret=y");
    button(el, "Show link").click();
    expect(el.textContent).toContain("secret=y");
    m.close();
  });

  it("two requests on one link: both listed by fingerprint, with a warning, none approved", async () => {
    const m = new AddDeviceModal(
      new App() as never,
      service({
        startSession: async () => ({
          kind: "link",
          session: "s1",
          result: {
            kind: "created",
            session: "s1",
            pairingDevice: new Uint8Array(32),
            link: new PairingLinkText("lfcp://pair/x#secret=y"),
          },
        }),
        requests: async () => [
          review,
          { ...review, requestKey: "p:def", label: "Unknown", fingerprint: "zzzz-yyyy-xxxx-wwww" },
        ],
      }),
      "Desk",
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).toContain("2 devices used this link");
    expect(el.textContent).toContain("aaaa-bbbb-cccc-dddd");
    expect(el.textContent).toContain("zzzz-yyyy-xxxx-wwww");
    expect(el.findAll("button").filter((b) => b.text === "Review")).toHaveLength(2);
    expect(el.findAll("button").some((b) => b.text === "Approve")).toBe(false);
    el.findAll("button")
      .filter((b) => b.text === "Review")[1]
      ?.click();
    await settle();
    expect(el.textContent).toContain("zzzz-yyyy-xxxx-wwww");
    expect(el.textContent).not.toContain("aaaa-bbbb-cccc-dddd");
    m.close();
  });

  it("a stop (no device support, offline) is said, with nothing to approve", async () => {
    const m = new AddDeviceModal(
      new App() as never,
      service({ startSession: async () => ({ kind: "stop", message: "No device support." }) }),
      "Desk",
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).toContain("No device support.");
    expect(el.findAll("button").map((b) => b.text)).toEqual(["Close"]);
  });
});

describe("Your devices…", () => {
  const row = (o: Partial<DeviceRow>): DeviceRow => ({
    principal: "aa",
    fingerprint: "ffff-ffff-ffff-ffff",
    label: "Laptop",
    first: false,
    thisDevice: false,
    kind: "personal",
    preset: "full",
    state: "active",
    suspendedBy: [],
    manages: true,
    ...o,
  });

  it("offers Remove device… for the others when this device manages, and the preview first", async () => {
    const previews: string[] = [];
    const m = new DevicesModal(
      new App() as never,
      service({
        devices: async () => ({
          kind: "list",
          current: true,
          manages: true,
          note: null,
          rows: [
            row({ principal: "01", first: true, label: "Desk", preset: null, thisDevice: true }),
            row({
              principal: "02",
              label: "Phone",
              preset: "edit",
              state: "suspended",
              suspendedBy: ["03"],
            }),
            row({ principal: "03", label: "Old", state: "removed" }),
          ],
        }),
        unfinished: async () => [{ kind: "approval", operation: "op1", label: "Tablet" }],
        upkeep: async () => ({
          reconciled: true,
          rotations: [],
          issues: [],
          offline: false,
          summary: "Your devices are up to date in every section.",
        }),
        accessStates: async () => [],
        previewRemoval: async (hex: string) => {
          previews.push(hex);
          return {
            blocked: null,
            lines: ['"Phone" loses access to all your sections.'],
            suspended: [],
          };
        },
      }),
      () => undefined,
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).toContain("Desk (first device) · this device");
    expect(el.textContent).toContain("Phone (Edit) · suspended");
    expect(el.textContent).toContain('Adding "Tablet" is not finished.');
    // One Remove device… (the suspended phone); none for the first device or a removed one.
    const removes = el.findAll("button").filter((b) => b.text === "Remove device…");
    expect(removes).toHaveLength(1);
    expect(button(el, "Re-certify")).toBeDefined();
    removes[0]?.click();
    await settle();
    expect(previews).toEqual(["02"]);
    const dialog = modals[modals.length - 1];
    const d = dialog?.contentEl as unknown as FakeElement;
    expect(d.textContent).toContain("loses access to all your sections");
    expect(button(d, "Remove device")).toBeDefined();
    dialog?.close();
    m.close();
  });

  it("a service device (the Reminders bridge) of 0.5 is an Older device, removed by the human, its reminders kept (P-050, E17)", async () => {
    const m = new DevicesModal(
      new App() as never,
      service({
        devices: async () => ({
          kind: "list",
          current: true,
          manages: true,
          note: null,
          rows: [
            row({ principal: "01", first: true, label: "Desk", preset: null, thisDevice: true }),
            row({ principal: "04", label: "Mac bridge", kind: "service", preset: "service" }),
          ],
        }),
        unfinished: async () => [],
        upkeep: async () => ({
          reconciled: true,
          rotations: [],
          issues: [],
          offline: false,
          summary: "",
        }),
        accessStates: async () => [],
        previewRemoval: async () => ({
          blocked: null,
          lines: ['"Mac bridge" loses access to all your sections.'],
          suspended: [],
        }),
      }),
      () => undefined,
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).toContain("Mac bridge (Service)");
    expect(el.textContent).toContain("Service device: a bridge or bot");
    expect(el.textContent).toContain(
      "Reminders bridge (experimental: a tech preview run from the Terminal)",
    );
    // E17: an installation of 0.5 (no approval record) is an older device, removed by the human.
    expect(el.textContent).toContain("Older device — not managed by LFCP Bridge 0.6");
    expect(el.findAll("button").filter((b) => b.text === "Disconnect…")).toHaveLength(0);
    button(el, "Remove device…").click();
    await settle();
    const dialog = modals[modals.length - 1];
    const d = dialog?.contentEl as unknown as FakeElement;
    expect(d.textContent).toContain("stops syncing these sections");
    expect(d.textContent).toContain(
      "the reminders of a Reminders bridge (experimental) stay in Apple Reminders as yours",
    );
    expect(button(d, "Remove device")).toBeDefined();
    dialog?.close();
    m.close();
  });

  it("groups a bridge's installations under its line, with Pending connection [Cancel] (E-023, U П5)", async () => {
    const C = new FakeControl(new Uint8Array(32).fill(9) as ResourceId, id(1));
    C.data.service = { instance: "bridge-a", app: "0.6.0" };
    const ref = (n: number) => principalRefOf(id(n));
    C.put("approvals", ref(4), { role: "base", revoked: false } as never, root);
    C.put("approvals", ref(5), { role: "section", revoked: false } as never, root);
    const pending = {
      rid: "r1",
      binding: toBase64url(new Uint8Array(32).fill(7)),
      pairingDevice: id(6),
      c: "c",
    };
    const cancelled: unknown[] = [];
    const m = new DevicesModal(
      new App() as never,
      service({
        devices: async () => ({
          kind: "list",
          current: true,
          manages: true,
          note: null,
          rows: [
            row({ principal: "01", first: true, label: "Desk", preset: null, thisDevice: true }),
            row({
              principal: toHex(id(4)),
              label: "MacBook Air",
              kind: "service",
              preset: "service",
            }),
            row({
              principal: toHex(id(5)),
              label: "MacBook Air · Home",
              kind: "service",
              preset: "service",
            }),
          ],
        }),
        unfinished: async () => [],
        upkeep: async () => ({
          reconciled: true,
          rotations: [],
          issues: [],
          offline: false,
          summary: "",
        }),
        accessStates: async () => [],
        bridges: async () => [
          {
            c: "09".repeat(32),
            name: "Reminders bridge · MacBook Air",
            port: C,
            pending: [pending],
          },
        ],
        sectionPairings: () => ({
          cancelPending: async (...a: unknown[]) => (cancelled.push(a), true),
        }),
      }),
      () => undefined,
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).toContain("Reminders bridge · MacBook Air — 1 section · 0.6.0");
    expect(el.textContent).toContain("Pending connection for “Plans”.");
    button(el, "Cancel").click();
    await settle();
    expect(cancelled).toHaveLength(1);
    m.close();
  });

  it("a bridge is disconnected as a whole (E-024): no Remove device… for its installations", async () => {
    const C = new FakeControl(new Uint8Array(32).fill(9) as ResourceId, id(1));
    C.data.service = { instance: "bridge-a" };
    C.put("approvals", principalRefOf(id(5)), { role: "section", revoked: false } as never, root);
    const started: unknown[] = [];
    const revocations = {
      start: async (port: unknown) => started.push(port),
      disconnect: async () => ({ state: "silent" }),
      anyway: async (port: unknown) => started.push(["anyway", port]),
      tick: async () => undefined,
      forget: async () => undefined,
    };
    const m = new DevicesModal(
      new App() as never,
      service({
        devices: async () => ({
          kind: "list",
          current: true,
          manages: true,
          note: null,
          rows: [
            row({ principal: "01", first: true, label: "Desk", preset: null, thisDevice: true }),
            row({ principal: toHex(id(5)), label: "Home", kind: "service", preset: "service" }),
          ],
        }),
        unfinished: async () => [],
        accessStates: async () => [],
        bridges: async () => [
          { c: "09".repeat(32), name: "Reminders bridge · MacBook Air", port: C, pending: [] },
        ],
        controlPort: async () => C,
        bridgeRevocations: () => revocations,
      }),
      () => undefined,
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.findAll("button").filter((b) => b.text === "Remove device…")).toHaveLength(0);
    expect(el.textContent).not.toContain("Older device");
    button(el, "Disconnect…").click();
    await settle();
    const d = modals[modals.length - 1]?.contentEl as unknown as FakeElement;
    expect(d.textContent).toContain("The lists stay in Reminders.");
    button(d, "Disconnect").click();
    await settle();
    expect(started).toEqual([C]);
    // U П1: the Mac has not answered.
    expect(d.textContent).toContain(
      "Your Mac hasn't answered.\nDisconnect anyway? Lists and the bridge's hidden service reminders stay in Reminders.",
    );
    button(d, "Disconnect anyway").click();
    await settle();
    expect(started).toEqual([C, ["anyway", C]]);
    modals[modals.length - 1]?.close();
    m.close();
  });

  it("r1-1: Disconnect of a bridge reconnected under another C acts on both C", async () => {
    const C1 = new FakeControl(new Uint8Array(32).fill(8) as ResourceId, id(1));
    const C2 = new FakeControl(new Uint8Array(32).fill(9) as ResourceId, id(1));
    for (const [C, n] of [
      [C1, 4],
      [C2, 5],
    ] as const) {
      C.data.service = { instance: "bridge-a" };
      C.put("approvals", principalRefOf(id(n)), { role: "section", revoked: false } as never, root);
    }
    const started: unknown[] = [];
    const ports: Record<string, FakeControl> = { ["08".repeat(32)]: C1, ["09".repeat(32)]: C2 };
    const m = new DevicesModal(
      new App() as never,
      service({
        devices: async () => ({
          kind: "list",
          current: true,
          manages: true,
          note: null,
          rows: [
            row({ principal: "01", first: true, label: "Desk", preset: null, thisDevice: true }),
            row({ principal: toHex(id(4)), label: "Home", kind: "service", preset: "service" }),
            row({ principal: toHex(id(5)), label: "Work", kind: "service", preset: "service" }),
          ],
        }),
        unfinished: async () => [],
        accessStates: async () => [],
        bridges: async () => [
          { c: "08".repeat(32), name: "Reminders bridge", port: C1, pending: [] },
          { c: "09".repeat(32), name: "Reminders bridge", port: C2, pending: [] },
        ],
        controlPort: async (c: string) => ports[c],
        bridgeRevocations: () => ({
          start: async (port: unknown) => started.push(port),
          disconnect: async () => ({ state: "done" }),
          tick: async () => undefined,
        }),
      }),
      () => undefined,
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.findAll("button").filter((b) => b.text === "Disconnect…")).toHaveLength(1);
    button(el, "Disconnect…").click();
    await settle();
    const d = modals[modals.length - 1]?.contentEl as unknown as FakeElement;
    button(d, "Disconnect").click();
    await settle();
    expect(started).toEqual([C1, C2]);
    modals[modals.length - 1]?.close();
    m.close();
  });

  it("r1-1: a conflict's base is removed in the C that holds it, also when it is not the first", async () => {
    const C1 = new FakeControl(new Uint8Array(32).fill(8) as ResourceId, id(1));
    const Cid = new Uint8Array(32).fill(9) as ResourceId;
    const C2 = new FakeControl(Cid, id(1));
    for (const C of [C1, C2]) C.data.service = { instance: "bridge-a" };
    for (const n of [4, 5])
      C2.put(
        "approvals",
        principalRefOf(id(n)),
        { role: "base", resource: toBase64url(Cid), revoked: false } as never,
        root,
      );
    const revoked: unknown[] = [];
    const ports: Record<string, FakeControl> = { ["08".repeat(32)]: C1, ["09".repeat(32)]: C2 };
    const m = new DevicesModal(
      new App() as never,
      service({
        devices: async () => ({
          kind: "list",
          current: true,
          manages: true,
          note: null,
          rows: [
            row({ principal: "01", first: true, label: "Desk", preset: null, thisDevice: true }),
            row({ principal: toHex(id(4)), label: "Mac", kind: "service", preset: "service" }),
            row({ principal: toHex(id(5)), label: "Mac 2", kind: "service", preset: "service" }),
          ],
        }),
        unfinished: async () => [],
        accessStates: async () => [],
        bridges: async () => [
          { c: "08".repeat(32), name: "Reminders bridge", port: C1, pending: [] },
          { c: "09".repeat(32), name: "Reminders bridge", port: C2, pending: [] },
        ],
        controlPort: async (c: string) => ports[c],
        bridgeRevocations: () => ({
          revokeOne: async (port: unknown, P: PrincipalId) => (
            revoked.push([port, toHex(P)]), null
          ),
        }),
      }),
      () => undefined,
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    el.findAll("button")
      .filter((b) => b.text === "Remove this connection…")[0]
      ?.click();
    await settle();
    button(modals[modals.length - 1]?.contentEl as unknown as FakeElement, "Remove").click();
    await settle();
    expect(revoked).toEqual([[C2, toHex(id(4))]]);
    m.close();
  });

  it("two base approvals: the conflict is shown, each base may be removed by its record (A§3.1)", async () => {
    const Cid = new Uint8Array(32).fill(9) as ResourceId;
    const C = new FakeControl(Cid, id(1));
    for (const n of [4, 5])
      C.put(
        "approvals",
        principalRefOf(id(n)),
        { role: "base", resource: toBase64url(Cid), revoked: false } as never,
        root,
      );
    const revoked: unknown[] = [];
    const m = new DevicesModal(
      new App() as never,
      service({
        devices: async () => ({
          kind: "list",
          current: true,
          manages: true,
          note: null,
          rows: [
            row({ principal: "01", first: true, label: "Desk", preset: null, thisDevice: true }),
            row({ principal: toHex(id(4)), label: "Mac", kind: "service", preset: "service" }),
            row({ principal: toHex(id(5)), label: "Mac 2", kind: "service", preset: "service" }),
          ],
        }),
        unfinished: async () => [],
        accessStates: async () => [],
        bridges: async () => [
          { c: "09".repeat(32), name: "Reminders bridge", port: C, pending: [] },
        ],
        controlPort: async () => C,
        bridgeRevocations: () => ({
          revokeOne: async (_: unknown, P: PrincipalId) => (revoked.push(toHex(P)), null),
        }),
      }),
      () => undefined,
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).toContain("This Mac is connected to your account twice");
    const remove = el.findAll("button").filter((b) => b.text === "Remove this connection…");
    expect(remove).toHaveLength(2);
    remove[0]?.click();
    await settle();
    button(modals[modals.length - 1]?.contentEl as unknown as FakeElement, "Remove").click();
    await settle();
    expect(revoked).toEqual([toHex(id(4))]);
    m.close();
  });

  it("a device that does not manage sees the list without actions", async () => {
    const m = new DevicesModal(
      new App() as never,
      service({
        devices: async () => ({
          kind: "list",
          current: false,
          manages: false,
          note: "The server could not be reached: this is this device's last copy.",
          rows: [
            row({ principal: "01", first: true, label: "Desk" }),
            row({ principal: "02", thisDevice: true }),
          ],
        }),
        unfinished: async () => [],
        accessStates: async () => [
          { name: "Plans", text: "This device was removed from your identity." },
        ],
      }),
      () => undefined,
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).toContain("last copy");
    expect(el.textContent).toContain('"Plans": This device was removed from your identity.');
    expect(el.findAll("button").map((b) => b.text)).toEqual(["Close"]);
    m.close();
  });
});

describe("Your devices…: what the upkeep owes (review obsidian#107 P1-2, P2-3)", () => {
  it("lists a device not added yet and a key not changed yet, and Finish now runs the upkeep", async () => {
    const runs: boolean[] = [];
    let owed = true;
    const m = new DevicesModal(
      new App() as never,
      service({
        devices: async () => ({ kind: "list", current: true, manages: true, note: null, rows: [] }),
        unfinished: async () =>
          owed
            ? [
                { kind: "registration", operation: "", label: "Phone", sections: ["Plans"] },
                { kind: "key", operation: "", label: "", sections: ["Team X"] },
              ]
            : [],
        accessStates: async () => [],
        upkeep: async (force: boolean) => {
          runs.push(force);
          if (runs.length > 1) owed = false;
          return {
            reconciled: true,
            rotations: [],
            issues: [],
            offline: false,
            summary: "Your devices are up to date in every section.",
          };
        },
      }),
      () => undefined,
    );
    m.open();
    await settle();
    // Opening the list runs the upkeep once, forced.
    expect(runs).toEqual([true]);
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).toContain('"Phone" is not added to "Plans" yet.');
    expect(el.textContent).toContain(
      'The key of "Team X" is not changed yet after a device was removed.',
    );
    mock.notices.length = 0;
    el.findAll("button")
      .find((b) => b.text === "Finish now")
      ?.click();
    await settle();
    expect(runs).toEqual([true, true]);
    expect(mock.notices.some((n) => n.includes("up to date"))).toBe(true);
    expect(el.textContent).not.toContain("is not added to");
    m.close();
  });
});

describe("Pair this device with a link…", () => {
  it("sends the pasted link, shows this device's fingerprint, then the sections it got", async () => {
    const requested: unknown[] = [];
    const m = new PairThisDeviceModal(
      new App() as never,
      service({
        openRequest: async () => null,
        pairRefusal: async () => null,
        request: async (...args: unknown[]) => {
          requested.push(args);
          return { kind: "requested", operation: "rq1", fingerprint: "abcd-efgh-ijkl-mnop" };
        },
        progress: async () => ({
          final: true,
          approved: true,
          headline: "Approved. Your sections are on this device.",
          sections: [{ name: "Plans", status: "ready" }],
          deviceList: "ready",
          opened: ["Plans"],
        }),
      }),
      "Vault on phone",
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    const [link, name] = el.findAll("input");
    expect(link?.type).toBe("password");
    expect(name?.value).toBe("Vault on phone");
    if (link === undefined) throw new Error("no link field");
    link.value = "lfcp://pair/x#secret=y";
    button(el, "Pair").click();
    await settle();
    expect(requested).toEqual([["lfcp://pair/x#secret=y", "Vault on phone"]]);
    expect(el.textContent).toContain("abcd-efgh-ijkl-mnop");
    expect(el.textContent).toContain("Approved. Your sections are on this device.");
    expect(el.textContent).toContain("Plans: ready");
    expect(el.textContent).toContain("Your device list: ready");
    m.close();
  });

  it("a vault that cannot be paired says why, and asks for no link", async () => {
    const m = new PairThisDeviceModal(
      new App() as never,
      service({
        openRequest: async () => null,
        pairRefusal: async () => "Pair a new, empty vault instead.",
      }),
      "Vault",
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).toContain("empty vault");
    expect(el.findAll("input")).toHaveLength(0);
  });

  it("an open request is resumed with its fingerprint, without a new link", async () => {
    const m = new PairThisDeviceModal(
      new App() as never,
      service({
        openRequest: async () => ({ operation: "rq1", fingerprint: "abcd-efgh-ijkl-mnop" }),
        progress: async () => ({
          final: false,
          approved: false,
          headline: "Waiting for your other device to approve…",
          sections: [],
          deviceList: null,
          opened: [],
        }),
      }),
      "Vault",
    );
    m.open();
    await settle();
    const el = m.contentEl as unknown as FakeElement;
    expect(el.textContent).toContain("abcd-efgh-ijkl-mnop");
    expect(el.textContent).toContain("Waiting for your other device to approve…");
    m.close();
  });
});

describe("the dialogs ask the server again with a backoff (decision I18)", () => {
  /** Advances the fake clock by `ms` and checks how many questions were asked by then. */
  const at = async (count: () => number, ms: number, asked: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    expect(count()).toBe(asked);
  };

  it("Pair this device: after 4 s, 8 s, 15 s, then every 30 s; Check now asks at once and starts again", async () => {
    vi.useFakeTimers();
    try {
      let asked = 0;
      const m = new PairThisDeviceModal(
        new App() as never,
        service({
          openRequest: async () => ({ operation: "rq1", fingerprint: "abcd-efgh-ijkl-mnop" }),
          progress: async () => {
            asked++;
            return {
              final: false,
              approved: false,
              headline: "Waiting for your other device to approve…",
              sections: [],
              deviceList: null,
              paused: false,
              opened: [],
            };
          },
        }),
        "Vault",
      );
      m.open();
      const n = () => asked;
      await at(n, 0, 1);
      await at(n, 3999, 1);
      await at(n, 1, 2);
      await at(n, 7999, 2);
      await at(n, 1, 3);
      await at(n, 14_999, 3);
      await at(n, 1, 4);
      await at(n, 29_999, 4);
      await at(n, 1, 5);
      await at(n, 30_000, 6);
      // The person acts: asked now, and 4 s later again.
      button(m.contentEl as unknown as FakeElement, "Check now").click();
      await at(n, 0, 7);
      await at(n, 3999, 7);
      await at(n, 1, 8);
      // Closed: nothing more.
      m.close();
      await at(n, 120_000, 8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Add my other device: requests asked with the same backoff; copying the link starts it again", async () => {
    vi.useFakeTimers();
    try {
      let asked = 0;
      const m = new AddDeviceModal(
        new App() as never,
        service({
          startSession: async () => ({
            kind: "link",
            session: "s1",
            result: {
              kind: "created",
              session: "s1",
              pairingDevice: new Uint8Array(32),
              link: new PairingLinkText("lfcp://pair/x#secret=y"),
            },
          }),
          requests: async () => {
            asked++;
            return [];
          },
        }),
        "Desk on computer",
        async () => undefined,
      );
      m.open();
      const n = () => asked;
      await at(n, 0, 1);
      await at(n, 4000, 2);
      await at(n, 8000, 3);
      await at(n, 15_000, 4);
      await at(n, 30_000, 5);
      button(m.contentEl as unknown as FakeElement, "Copy link").click();
      await at(n, 0, 6);
      await at(n, 4000, 7);
      m.close();
      await at(n, 120_000, 7);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the plugin's device commands", () => {
  it("are registered, and before Shared Tasks is ready say so instead of opening a dialog", async () => {
    const plugin = new OpenLfcpPlugin(
      new App() as never,
      { id: "shared-tasks", version: "0" } as never,
    );
    await plugin.onload();
    const commands = (plugin as unknown as mock.Plugin).commands;
    const byId = (id: string) => commands.find((c) => c.id === id);
    expect(byId("add-device")?.name).toBe("Add my other device…");
    expect(byId("your-devices")?.name).toBe("Your devices…");
    expect(byId("pair-this-device")?.name).toBe("Pair this device with a link…");
    plugin.runtime = null;
    modals.length = 0;
    mock.notices.length = 0;
    byId("your-devices")?.callback?.();
    byId("pair-this-device")?.callback?.();
    expect(modals).toHaveLength(0);
    expect(mock.notices.filter((n) => n.includes("not ready"))).toHaveLength(2);
    plugin.onunload();
  });
});
