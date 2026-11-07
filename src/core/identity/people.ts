// People, not installations (LFCP-04-411, IDENTITY-PROFILE-01 §10;
// LFCP-WIRE-01 §7.2, §80.1). A human's installations are distinct
// Principals tied to one root by Device Certificates in each Resource's own
// Control Chain. What a reader shows is the root: an author is
// `rootOf(actor)`, the access list has one row per root with its devices
// inside, an assignee `p:<D>` is the same human as `p:<rootOf(D)>`, and a
// local alias names a root.
//
// Pure: every answer is a function of one Resource's validated Control
// state (N3), through the SDK's `rootOf` and `activeDevice`; never the
// Identity Resource, another Resource or a server. Attribution only, never
// authority: a revoked or intermediate device keeps its root so that
// history keeps its author (rootOf), while whether it may act is the SDK's
// answer (activeDevice), shown here and decided nowhere else. Nothing is
// rewritten: actors, `created_by` and assignee sets stay as written.

import { fromHex, type PrincipalId, toHex } from "@openlfcp/core";
import { isPrincipalRef, parsePrincipalRef, principalRef } from "@openlfcp/shared-objects";
import {
  activeDevice,
  type ControlState,
  DEVICE_KIND,
  deviceFingerprint,
  revocationOf,
  rootOf,
} from "@openlfcp/wire";

/** How many hex characters of a Principal ID are shown (and key a local alias). */
export const SHORT_ID = 8;

/** A Principal ID (hex) as it is shown, and as a local alias is keyed. */
export const shortId = (hex: string): string => hex.slice(0, SHORT_ID);

/**
 * Where the local aliases live in the plugin's sealed local state: short
 * root ID → label, labels of this device only (never sent or verified).
 */
export const ALIASES_KEY = "identity-aliases";

/**
 * Where the labels of the reader's own devices are kept (Principal ID hex →
 * label), as last read from its Identity Resource by the device flows
 * (LFCP-04-413): display only, used for the reader's own person (§10).
 */
export const DEVICE_LABELS_KEY = "identity-device-labels";

/** The device labels, as read from local state (anything else reads as none). */
export const deviceLabelsOf = (stored: unknown): Readonly<Record<string, string>> =>
  typeof stored === "object" && stored !== null
    ? Object.fromEntries(
        Object.entries(stored as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      )
    : {};

/** The local aliases, as read from local state (anything else reads as none). */
export const aliasesOf = (stored: unknown): Readonly<Record<string, string>> =>
  typeof stored === "object" && stored !== null ? (stored as Record<string, string>) : {};

/** A device's kind (§7.2), by name; codes this version does not know are "other". */
export type DeviceKindName = "personal" | "service" | "pairing" | "other";

/**
 * Whether a device acts for its person in this Resource now (§17.5):
 * active; suspended (an issuer in its chain was removed); removed (revoked
 * here, N5); inactive (registered, but its person holds no access here).
 */
export type DeviceStatus = "active" | "suspended" | "removed" | "inactive";

/** A device of a person, registered in one Resource (§7.2 "registered"). */
export interface PersonDevice {
  /** The device's Principal ID (hex). */
  readonly principal: string;
  /** IDENTITY-PROFILE-01 §5.2: what the person compared when pairing; the device's default label. */
  readonly fingerprint: string;
  readonly kind: DeviceKindName;
  readonly status: DeviceStatus;
}

/** People of one Resource, as its Control state says (People.of). */
export interface People {
  /** The reader's person: `rootOf` of this installation's Principal (hex). */
  readonly me: string;
  /** `rootOf(P)` (hex): the root a bound P acts for (revoked or intermediate included), else P. */
  root(principal: string): string;
  /** Whether `principal` (hex) is the reader's person or one of its devices. */
  mine(principal: string): boolean;
  /** The devices registered here for root `root` (hex), by Principal ID; empty for a root without devices. */
  devices(root: string): readonly PersonDevice[];
  /** The registered device `principal` (hex), or undefined for a root, an intermediate or an unknown Principal. */
  device(principal: string): PersonDevice | undefined;
}

const KIND: ReadonlyMap<number, DeviceKindName> = new Map([
  [DEVICE_KIND.PERSONAL, "personal"],
  [DEVICE_KIND.SERVICE, "service"],
  [DEVICE_KIND.PAIRING, "pairing"],
]);

/** The §5.2 fingerprint of a Principal ID (hex); the hex prefix when it is not a Principal ID. */
export function fingerprintOf(hex: string): string {
  try {
    return deviceFingerprint(fromHex(hex) as PrincipalId);
  } catch {
    return shortId(hex);
  }
}

/**
 * The people of a Resource whose validated Control state is `state`, read
 * by the installation `me` (hex). Without a state (none stored yet, or a
 * forked chain) every Principal is its own person, as before devices.
 */
export function peopleOf(state: ControlState | null, me: string): People {
  const root = (p: string): string => {
    if (state === null) return p;
    try {
      return toHex(rootOf(state, fromHex(p) as PrincipalId));
    } catch {
      return p;
    }
  };
  const byRoot = new Map<string, PersonDevice[]>();
  const byDevice = new Map<string, PersonDevice>();
  if (state !== null)
    for (const [hex, binding] of state.devices) {
      // An intermediate only (bound by a chain, never registered here) acts nowhere here.
      if (!binding.registered) continue;
      const id = fromHex(hex) as PrincipalId;
      const status: DeviceStatus =
        activeDevice(state, id) !== undefined
          ? "active"
          : revocationOf(state, binding.root, id) !== undefined
            ? "removed"
            : binding.issuers.some((e) => revocationOf(state, binding.root, e) !== undefined)
              ? "suspended"
              : "inactive";
      const device: PersonDevice = Object.freeze({
        principal: hex,
        fingerprint: fingerprintOf(hex),
        kind: KIND.get(binding.kind) ?? "other",
        status,
      });
      const r = toHex(binding.root);
      const list = byRoot.get(r) ?? [];
      list.push(device);
      byRoot.set(r, list);
      byDevice.set(hex, device);
    }
  for (const list of byRoot.values())
    list.sort((a, b) => (a.principal < b.principal ? -1 : a.principal > b.principal ? 1 : 0));
  const mine = root(me);
  return {
    me: mine,
    root,
    mine: (p) => root(p) === mine,
    devices: (r) => byRoot.get(r) ?? [],
    device: (p) => byDevice.get(p),
  };
}

/** An author as shown (§10 "Attribution"): the person, and the device as detail. */
export interface Author {
  /** The root (hex). */
  readonly root: string;
  /** The device that wrote, when it is not the root's own installation. */
  readonly device: PersonDevice | null;
}

/** The author of a change written by `actor` (hex): `rootOf(actor)`, the device as detail. */
export function authorOf(people: People, actor: string): Author {
  const root = people.root(actor);
  return { root, device: root === actor ? null : (people.device(actor) ?? null) };
}

/**
 * The device detail of an author (§10): "from <label>", or "via <label>"
 * for a service device (a bridge or bot); the label is the device's own
 * name in the reader's Identity Resource when it is one of the reader's
 * devices (`labels`), else its fingerprint. Null for the root itself.
 */
export function deviceDetail(
  device: PersonDevice | null,
  labels: Readonly<Record<string, string>> = {},
): string | null {
  if (device === null) return null;
  const label = labels[device.principal] ?? device.fingerprint;
  return `${device.kind === "service" ? "via" : "from"} ${label}`;
}

/**
 * An author as one line (§10): the person (its local alias, else its short
 * ID), then the device detail when a device wrote: "Anna (from abcd-…)".
 */
export function authorLabel(
  people: People,
  actor: string,
  aliases: Readonly<Record<string, string>> = {},
  labels: Readonly<Record<string, string>> = {},
): string {
  const { root, device } = authorOf(people, actor);
  return personLabel(people, { root, devices: device === null ? [] : [device] }, aliases, labels);
}

/**
 * A person and the devices that wrote, as one line (§10): the person's
 * local alias, else its short ID, then each device as detail:
 * "Anna (from abcd-…, via efgh-…)". Just the name when only the root's own
 * installation wrote.
 */
export function personLabel(
  people: People,
  person: { readonly root: string; readonly devices: readonly PersonDevice[] },
  aliases: Readonly<Record<string, string>> = {},
  labels: Readonly<Record<string, string>> = {},
): string {
  const own = people.mine(person.root) ? labels : {};
  const details = person.devices.flatMap((d) => deviceDetail(d, own) ?? []);
  const name = aliases[shortId(person.root)] ?? shortId(person.root);
  return details.length === 0 ? name : `${name} (${details.join(", ")})`;
}

/** Edits of one person that cannot be applied (blockedByPerson). */
export interface BlockedPerson {
  /** The root (hex). */
  readonly root: string;
  readonly units: number;
  /** Reason codes, sorted. */
  readonly reasons: readonly string[];
  /** The person's devices among the authors, in first-seen order; not the root's own installation. */
  readonly devices: readonly PersonDevice[];
}

/**
 * Blocked authors by person (§10 "Attribution"): the units of all of a
 * person's installations count once for `rootOf(actor)`, reasons merged,
 * the writing devices kept as detail; in the order of each person's first
 * actor.
 */
export function blockedByPerson(
  people: People,
  blocked: readonly {
    readonly principal: string;
    readonly units: number;
    readonly reasons: readonly string[];
  }[],
): BlockedPerson[] {
  const byRoot = new Map<
    string,
    { units: number; reasons: Set<string>; devices: PersonDevice[] }
  >();
  for (const b of blocked) {
    const { root, device } = authorOf(people, b.principal);
    const entry = byRoot.get(root) ?? { units: 0, reasons: new Set<string>(), devices: [] };
    entry.units += b.units;
    for (const r of b.reasons) entry.reasons.add(r);
    if (device !== null && !entry.devices.includes(device)) entry.devices.push(device);
    byRoot.set(root, entry);
  }
  return [...byRoot].map(([root, e]) => ({
    root,
    units: e.units,
    reasons: [...e.reasons].sort(),
    devices: e.devices,
  }));
}

/**
 * The local alias of the person `principal` acts for (§10 "Aliases"):
 * aliases are keyed by the root's short ID, so a device shows its person's
 * name, and naming a device's row names its person.
 */
export function aliasOf(
  people: People,
  aliases: Readonly<Record<string, string>>,
  principal: string,
): string | undefined {
  return aliases[shortId(people.root(principal))];
}

/** The key a local alias set from any of `principal`'s rows is stored under (its root's short ID). */
export const aliasKey = (people: People, principal: string): string =>
  shortId(people.root(principal));

/** One human among a task's assignees (§10 "Assignees", decision I6). */
export interface AssignedPerson {
  /** The root (hex); for a reference that is not a Principal, the reference itself. */
  readonly root: string;
  /** The members of the CRDT set that name this human, as written (a device's and the root's). */
  readonly refs: readonly string[];
}

/**
 * A task's assignee set as people (§10, decision I6; IDENTITY-PROFILE-01
 * vector `assignee_root_ref`): `p:<D>` and `p:<R>` with `rootOf(D) = R`
 * are one human, for display and filtering. The set itself is unchanged:
 * two keys for one human stay two members, merged here only; legacy
 * assignees (an installation's Principal) need no change and map to their
 * root once this Resource binds them. A reference that is not a Principal
 * is kept as its own entry. In the order each human first appears.
 */
export function assignedPeople(people: People, refs: readonly string[]): AssignedPerson[] {
  const out = new Map<string, string[]>();
  for (const ref of refs) {
    const key = isPrincipalRef(ref) ? people.root(toHex(parsePrincipalRef(ref))) : ref;
    const list = out.get(key) ?? [];
    if (!list.includes(ref)) list.push(ref);
    out.set(key, list);
  }
  return [...out].map(([root, r]) => ({ root, refs: r }));
}

/** Whether a task with assignees `refs` is assigned to the human `principal` acts for (filtering). */
export const isAssignedTo = (people: People, refs: readonly string[], principal: string): boolean =>
  assignedPeople(people, refs).some((a) => a.root === people.root(principal));

/**
 * The reference an identity-aware writer assigns for `principal` (§10,
 * I6): always its root, never a device. Existing members of the set are
 * never rewritten here; replacing a device reference is the user's own
 * edit of that task.
 */
export const assigneeRef = (people: People, principal: string): string =>
  principalRef(fromHex(people.root(principal)) as PrincipalId);
