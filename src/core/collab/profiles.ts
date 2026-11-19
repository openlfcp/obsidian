// Which Data Profile a stored Resource has, as this version reads it
// (IDENTITY-PROFILE-01 §10, A§3.5a). The registry holds every Resource the
// install database has, of any profile: a 0.1 task collaboration, a shared
// section, a service device's control Resource (`C`, "Reminders bridge ·
// <Mac>") or one of a profile this version has never heard of. Only the
// first two are listed as collaborations or sections: anything else would
// be shown as a "Task collaboration" it is not.
//
// The version gate: a profile ID is `<family>.v<N>`. A known family at a
// higher version than this one knows (a newer plugin's) is "newer": it is
// not interpreted, whatever its family, and only a surface that owns that
// family (Devices, for `C`) says "update Shared Tasks" for it.

import { PROFILE_ID as TASKS_PROFILE_ID } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";

/** SERVICE-CONTROL-PROFILE-01's ID: a service device's control Resource (A§3.2). */
export const SERVICE_CONTROL_PROFILE_ID = "org.openlfcp.service-control.v1";

export type ProfileFamily = "tasks" | "section" | "service-control";

export type ProfileClass =
  /** This version reads it. */
  | { readonly kind: "known"; readonly family: ProfileFamily }
  /** A family this version knows, at a later version: not interpreted. */
  | { readonly kind: "newer"; readonly family: ProfileFamily; readonly version: number }
  /** Not a family this version knows. */
  | { readonly kind: "unknown" };

const VERSIONED = /^(.+)\.v([1-9][0-9]{0,8})$/;

function split(id: string): { readonly family: string; readonly version: number } | null {
  const m = VERSIONED.exec(id);
  return m === null ? null : { family: m[1] as string, version: Number(m[2]) };
}

/** The families this version reads, by their ID's stem, with the version it reads. */
const KNOWN: ReadonlyMap<string, { readonly family: ProfileFamily; readonly version: number }> =
  new Map(
    (
      [
        [TASKS_PROFILE_ID, "tasks"],
        [SECTIONS_PROFILE_ID, "section"],
        [SERVICE_CONTROL_PROFILE_ID, "service-control"],
      ] as const
    ).flatMap(([id, family]) => {
      const s = split(id);
      return s === null ? [] : [[s.family, { family, version: s.version }] as const];
    }),
  );

/** What `profile` is to this version. */
export function classifyProfile(profile: string): ProfileClass {
  const s = split(profile);
  const known = s === null ? undefined : KNOWN.get(s.family);
  if (s === null || known === undefined) return { kind: "unknown" };
  if (s.version === known.version) return { kind: "known", family: known.family };
  return s.version > known.version
    ? { kind: "newer", family: known.family, version: s.version }
    : { kind: "unknown" };
}

/**
 * Whether a Resource of `profile` is listed as a task collaboration or a
 * shared section (pickers, "Resource status"): only those two, at the
 * version this one reads.
 */
export function listedAsResource(profile: string): boolean {
  const c = classifyProfile(profile);
  return c.kind === "known" && (c.family === "tasks" || c.family === "section");
}
