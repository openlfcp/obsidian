// The Data Profiles the identity flows judge units with (LFCP-04-413f;
// review obsidian#109b, SDK 0.3.2): a rotation counts into its frontier only
// the units recipients accept as data (W §19, §26.3 rules 6 and 7;
// IDENTITY-PROFILE-01 §8.3), and judges each with its Resource's profile as
// that profile's receiver does: bound to the unit's Resource and signer
// (codecFor), so a change of another actor (CHANGE_ACTOR_MISMATCH) stays out.
// The plugin's Resources are 0.1 shared Tasks (Shared Objects), shared
// sections and the person's device list (the Identity Profile); the SDK's
// shared-objects packages give each profile's per-unit check.

import type { UnitProfile } from "@openlfcp/client";
import { sharedObjectsUnitProfile } from "@openlfcp/shared-objects";
import { identityUnitProfile } from "@openlfcp/shared-objects/identity";
import { sectionsUnitProfile } from "@openlfcp/shared-objects/sections";

/** The profiles every identity flow call of the plugin passes (FlowOptions.profiles). */
export const UNIT_PROFILES: readonly UnitProfile[] = Object.freeze([
  sharedObjectsUnitProfile,
  sectionsUnitProfile,
  identityUnitProfile,
]);
