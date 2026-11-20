// The device list's bridges (MVP 0.6 U П5, E-023): the installations of one
// LFCP Bridge — its base and one per connected section (E11) — grouped by
// `bridgeInstanceId` (`C.service.instance`), with the bridge's own line and
// its pending section connection. Which installation belongs to a bridge is
// read from the approval records of its C written by root or personal
// (A§5.3), never from a field the service wrote. Pure.

import { createdBy, principalOfRef, type ServiceControlPort } from "@openlfcp/client";
import { fromHex, type ResourceId, toHex } from "@openlfcp/core";
import { baseApprovals, type Disconnect } from "./bridge-revocation";
import type { DeviceRow } from "./device-list";
import type { PendingConnection } from "./section-pairing";

/** One control Resource C of the roster, as this device reads it. */
export interface BridgeControl {
  /** C (hex). */
  readonly c: string;
  /** The roster name: "Reminders bridge · MacBook Air". */
  readonly name: string;
  readonly port: Pick<ServiceControlPort, "state" | "creatorsOf">;
  readonly pending: readonly PendingConnection[];
}

export interface BridgeGroup {
  /** `service.instance`, or C (hex) before the bridge's first write. */
  readonly instance: string;
  readonly name: string;
  /** `service.app`, when the bridge wrote it. */
  readonly app?: string;
  /** `status.heartbeatAt` (RFC 3339), when written. */
  readonly heartbeatAt?: string;
  /** The control Resources of this bridge (a reconnect makes another C). */
  readonly controls: readonly string[];
  readonly base: readonly DeviceRow[];
  /** One row per connected section's installation. */
  readonly sections: readonly DeviceRow[];
  readonly pending: readonly (PendingConnection & { readonly c: string })[];
  /** A§3.1: a C of this bridge holds two base approvals; the bridge cannot act until one is revoked. */
  readonly conflict: boolean;
}

/** A string field of a record the bridge wrote (display only), else undefined. */
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * The rows grouped by bridge, and the rows of no bridge (in their order).
 * A row is a bridge's when a non-revoked approval of its C names it.
 */
export function bridgeGroups(
  rows: readonly DeviceRow[],
  controls: readonly BridgeControl[],
): { readonly groups: BridgeGroup[]; readonly rest: DeviceRow[] } {
  const byPrincipal = new Map(rows.map((r) => [r.principal, r]));
  const taken = new Set<string>();
  const groups = new Map<string, BridgeGroup>();
  for (const c of controls) {
    const state = c.port.state() as
      | (ReturnType<ServiceControlPort["state"]> & { service?: unknown; status?: unknown })
      | undefined;
    if (state === undefined) continue;
    const service = state.service as
      | { readonly instance?: unknown; readonly app?: unknown }
      | undefined;
    const status = state.status as { readonly heartbeatAt?: unknown } | undefined;
    const instance = text(service?.instance) ?? c.c;
    const app = text(service?.app);
    const heartbeatAt = text(status?.heartbeatAt);
    const base: DeviceRow[] = [];
    const sections: DeviceRow[] = [];
    for (const [ref, a] of Object.entries(state.approvals)) {
      if (a.revoked || !createdBy(c.port.creatorsOf("approvals", ref), ["root", "personal"]))
        continue;
      const P = principalOfRef(ref);
      const row = P === undefined ? undefined : byPrincipal.get(toHex(P));
      if (row === undefined || row.kind !== "service" || taken.has(row.principal)) continue;
      taken.add(row.principal);
      (a.role === "base" ? base : sections).push(row);
    }
    const g = groups.get(instance);
    const shownApp = app ?? g?.app;
    const heard = later(heartbeatAt, g?.heartbeatAt);
    groups.set(instance, {
      instance,
      name: g?.name ?? c.name,
      ...(shownApp === undefined ? {} : { app: shownApp }),
      ...(heard === undefined ? {} : { heartbeatAt: heard }),
      controls: [...(g?.controls ?? []), c.c],
      base: [...(g?.base ?? []), ...base],
      sections: [...(g?.sections ?? []), ...sections],
      pending: [...(g?.pending ?? []), ...c.pending.map((p) => ({ ...p, c: c.c }))],
      conflict:
        g?.conflict === true || baseApprovals(c.port, fromHex(c.c) as ResourceId).length > 1,
    });
  }
  return {
    groups: [...groups.values()],
    rest: rows.filter((r) => !taken.has(r.principal)),
  };
}

const later = (a: string | undefined, b: string | undefined): string | undefined =>
  a === undefined ? b : b === undefined || a > b ? a : b;

/** "3 min ago", "2 h ago", "12 days ago". */
function ago(at: string, now: number): string | undefined {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return undefined;
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / (24 * 60))} days ago`;
}

/** U П5: "Reminders bridge · MacBook Air — 3 sections · 0.6.0 · last heard 3 min ago". */
export function bridgeLine(g: BridgeGroup, now: number): string {
  const n = g.sections.length;
  const heard = g.heartbeatAt === undefined ? undefined : ago(g.heartbeatAt, now);
  return [
    `${g.name} — ${n} ${n === 1 ? "section" : "sections"}`,
    ...(g.app === undefined ? [] : [g.app]),
    ...(heard === undefined ? [] : [`last heard ${heard}`]),
  ].join(" · ");
}

/** U П1, П5: a section connection not finished; [Cancel] until it is approved. */
export const pendingLine = (section: string): string => `Pending connection for “${section}”.`;

/** E17, A§5.3: a bridge installation of 0.5 (no approval record); removed only by the human. */
export const OLDER_DEVICE = "Older device — not managed by LFCP Bridge 0.6";

/** The rows of no bridge that are such installations: service devices still bound. */
export const olderDevices = (rest: readonly DeviceRow[]): DeviceRow[] =>
  rest.filter((r) => r.kind === "service" && r.state !== "removed");

/** A§3.1: two base approvals of one C, shown with the group. */
export const BASE_CONFLICT =
  "This Mac is connected to your account twice, so LFCP Bridge can't act until one connection is removed. Remove one, or disconnect the Mac.";

/** [Disconnect…]'s confirmation (U П5: "lists stay in Reminders"). */
export const DISCONNECT_CONFIRM =
  "Its sections stop syncing with Apple Reminders. The lists stay in Reminders.";

export type DisconnectAction = "disconnect-anyway" | "cancel" | "try-again" | "close";

/** U П1, A§6.3: what the Disconnect dialog says at each step. */
export function disconnectView(d: Disconnect | undefined): {
  readonly lines: readonly string[];
  readonly actions: readonly DisconnectAction[];
} {
  switch (d?.state) {
    case undefined:
    case "removing":
      return { lines: ["Removing your sections from Reminders on the Mac…"], actions: ["close"] };
    case "silent":
      return {
        lines: [
          ...(d.code === undefined
            ? ["Your Mac hasn't answered."]
            : [`Your Mac couldn't remove every section (${d.code}).`]),
          "Disconnect anyway? Lists and the bridge's hidden service reminders stay in Reminders.",
        ],
        actions: ["disconnect-anyway", "cancel"],
      };
    case "revoking":
      return { lines: ["Disconnecting…"], actions: ["close"] };
    case "done":
      return { lines: ["Disconnected. The lists stay in Reminders."], actions: ["close"] };
    case "failed":
      return {
        lines: [d.message ?? "The Mac could not be disconnected."],
        actions: ["try-again", "close"],
      };
  }
}

/**
 * The control Resources (hex) of the bridge C belongs to (by `service.instance`, as
 * bridgeGroups groups them): Disconnect is of the whole bridge (U П5), every C of it.
 */
export function bridgeControlsOf(controls: readonly BridgeControl[], c: string): string[] {
  const instance = (b: BridgeControl) => {
    const service = (b.port.state() as { service?: { instance?: unknown } } | undefined)?.service;
    return text(service?.instance) ?? b.c;
  };
  const mine = controls.find((b) => b.c === c);
  if (mine === undefined) return [c];
  return controls.filter((b) => instance(b) === instance(mine)).map((b) => b.c);
}

/** The Disconnect of a bridge with several C, as one: what still needs the human comes first. */
export function groupDisconnect(ds: readonly (Disconnect | undefined)[]): Disconnect | undefined {
  const rank = (d: Disconnect | undefined): number =>
    d === undefined ? 2 : { failed: 0, silent: 1, removing: 3, revoking: 4, done: 5 }[d.state];
  return ds.reduce((a, b) => (rank(b) < rank(a) ? b : a), ds[0]);
}
