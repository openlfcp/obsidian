// The device list's bridges (MVP 0.6 U П5, E-023): the installations of one
// LFCP Bridge — its base and one per connected section (E11) — grouped by
// `bridgeInstanceId` (`C.service.instance`), with the bridge's own line and
// its pending section connection. Which installation belongs to a bridge is
// read from the approval records of its C written by root or personal
// (A§5.3), never from a field the service wrote. Pure.

import { createdBy, principalOfRef, type ServiceControlPort } from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
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
