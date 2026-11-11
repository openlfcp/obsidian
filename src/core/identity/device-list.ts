// The person's devices (LFCP-04-413, IDENTITY-PROFILE-01 §5.4, §8, §10),
// as the Identity Resource's validated Control state says: the root (the
// first installation) and every device bound to it by a certificate, with
// the preset its mask is, and whether it acts now. Pure. The labels come
// from the document (display only, §4 rule 5); a device without one is
// shown by its §5.2 fingerprint. Pairing devices (kind 2) are sessions,
// not devices, and are not listed.

import { MASK_PRESETS, type MaskPreset } from "@openlfcp/client";
import { fromHex, type PrincipalId, toHex } from "@openlfcp/core";
import { type ControlState, DEVICE_KIND, revocationOf } from "@openlfcp/wire";
import { fingerprintOf } from "./people";

/** A device's access, by the presets of §5.4; "custom" for any other mask. */
export type DevicePreset = MaskPreset | "custom";

/**
 * Whether a device acts for the person now: active; suspended (a device
 * that certified it was removed, W §17.5 cascade); removed (revoked, N5:
 * never again under the same Principal).
 */
export type DeviceState = "active" | "suspended" | "removed";

export interface DeviceRow {
  /** Principal ID (hex). */
  readonly principal: string;
  /** IDENTITY-PROFILE-01 §5.2. */
  readonly fingerprint: string;
  /** The label from the device list, else the fingerprint. */
  readonly label: string;
  /** The root's own installation: the first device, which holds the person's key (I2). */
  readonly first: boolean;
  /** This installation. */
  readonly thisDevice: boolean;
  readonly kind: "personal" | "service";
  /** Null for the first device (it is the person). */
  readonly preset: DevicePreset | null;
  readonly state: DeviceState;
  /** For a suspended device: the removed devices (hex) its certificate passes through. */
  readonly suspendedBy: readonly string[];
  /** Whether this device may add and remove devices (the root, or `12` in its mask). */
  readonly manages: boolean;
}

/** The words of a preset, for lists and dialogs. */
export const PRESET_LABEL: Readonly<Record<DevicePreset, string>> = {
  full: "Full",
  edit: "Edit",
  read: "Read",
  service: "Service",
  custom: "Custom",
};

/** What each preset may do, in one line (§5.4). */
export const PRESET_TEXT: Readonly<Record<MaskPreset, string>> = {
  full: "Full: read, write, invite and manage your devices. For another computer.",
  edit: "Edit: read and write. For a phone.",
  read: "Read: read only.",
  service: "Service: read and write the chosen sections only. For a bridge or bot.",
};

const DEVICE_MANAGE = 12n;

/** The preset a certificate's kind and mask are (§5.4), or "custom". */
export function presetOf(kind: number, mask: readonly bigint[]): DevicePreset {
  const same = (a: readonly bigint[]) =>
    a.length === mask.length && a.every((c) => mask.includes(c));
  for (const [name, p] of Object.entries(MASK_PRESETS) as [
    MaskPreset,
    (typeof MASK_PRESETS)[MaskPreset],
  ][])
    if (p.kind === kind && same(p.mask)) return name;
  return "custom";
}

/**
 * The devices of the person whose Identity Resource has the validated
 * Control state `state`, read by installation `me` (hex): the devices of
 * `root`, by default the Genesis owner (the root of an Identity Resource,
 * §2.3). `labels` maps a Principal ID (hex) to its label in the document.
 * The first device comes first, then this device, then the rest: active
 * before suspended before removed, each by label.
 */
export function deviceRows(
  state: ControlState,
  me: string,
  labels: Readonly<Record<string, string>> = {},
  root: PrincipalId = state.owner.principalId,
): DeviceRow[] {
  const rootHex = toHex(root);
  const label = (hex: string, fingerprint: string) => labels[hex]?.trim() || fingerprint;
  const rows: DeviceRow[] = [];
  const fp = fingerprintOf(rootHex);
  rows.push({
    principal: rootHex,
    fingerprint: fp,
    label: label(rootHex, fp),
    first: true,
    thisDevice: rootHex === me,
    kind: "personal",
    preset: null,
    state: "active",
    suspendedBy: [],
    manages: true,
  });
  for (const [hex, b] of state.devices) {
    // A leaf of this root: an intermediate only has no chain; a pairing device is a session.
    if (b.chain === null || toHex(b.root) !== rootHex) continue;
    if (b.kind !== DEVICE_KIND.PERSONAL && b.kind !== DEVICE_KIND.SERVICE) continue;
    const id = fromHex(hex) as PrincipalId;
    const suspendedBy = b.issuers
      .filter((e) => revocationOf(state, root, e) !== undefined)
      .map((e) => toHex(e));
    const deviceState: DeviceState =
      revocationOf(state, root, id) !== undefined
        ? "removed"
        : suspendedBy.length > 0
          ? "suspended"
          : "active";
    const f = fingerprintOf(hex);
    rows.push({
      principal: hex,
      fingerprint: f,
      label: label(hex, f),
      first: false,
      thisDevice: hex === me,
      kind: b.kind === DEVICE_KIND.SERVICE ? "service" : "personal",
      preset: presetOf(b.kind, b.mask),
      state: deviceState,
      suspendedBy,
      manages: b.kind === DEVICE_KIND.PERSONAL && b.mask.includes(DEVICE_MANAGE),
    });
  }
  const order: Readonly<Record<DeviceState, number>> = { active: 0, suspended: 1, removed: 2 };
  const [first, ...rest] = rows;
  rest.sort(
    (a, b) =>
      Number(b.thisDevice) - Number(a.thisDevice) ||
      order[a.state] - order[b.state] ||
      a.label.localeCompare(b.label) ||
      (a.principal < b.principal ? -1 : 1),
  );
  return first === undefined ? rest : [first, ...rest];
}

/** A device row as one line: "Laptop (Full) · this device", "Phone (Edit) · suspended". */
export function deviceLine(row: DeviceRow): string {
  const preset = row.preset ?? "custom";
  const what = row.first
    ? "first device"
    : row.kind === "service" && preset !== "service"
      ? `${PRESET_LABEL[preset]}, service`
      : PRESET_LABEL[preset];
  const notes = [
    ...(row.thisDevice ? ["this device"] : []),
    ...(row.state === "active" ? [] : [row.state]),
  ];
  return `${row.label} (${what})${notes.length === 0 ? "" : ` · ${notes.join(" · ")}`}`;
}

/**
 * What a service device is, under its line (P-050): a bridge (the Apple Reminders bridge) or a bot
 * with access to the chosen sections. Null for a device of the person. The device list holds no
 * "last seen" for a device, so none is shown.
 */
export function deviceNote(row: DeviceRow): string | null {
  return row.kind === "service"
    ? "Service device: a bridge or bot (such as the Reminders bridge) with access to the sections you chose."
    : null;
}

/**
 * The words of the remove action for a device (§8). Removing a service device is the same
 * revocation, said as disconnecting it: a bridge stops syncing, and what it wrote stays.
 */
export function removalWords(row: DeviceRow): {
  readonly button: string;
  readonly title: string;
  readonly confirm: string;
  readonly note: string | null;
} {
  if (row.kind === "service")
    return {
      button: "Disconnect…",
      title: `Disconnect "${row.label}"`,
      confirm: "Disconnect",
      note: "It stops syncing these sections for good. What it already wrote stays: a Reminders bridge's reminders stay in Apple Reminders as yours. To connect it again, pair it as a new service.",
    };
  return {
    button: "Remove device…",
    title: `Remove "${row.label}"`,
    confirm: "Remove device",
    note: null,
  };
}
