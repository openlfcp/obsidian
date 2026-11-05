// The Data Profile codecs the identity flows judge units with (LFCP-04-413e;
// sdk-ts#21, SDK 0.3.1): a rotation counts into its frontier only the units
// recipients accept as data (W §19, §26.3 rules 6 and 7; IDENTITY-PROFILE-01
// §8.3), and it checks rule 7 only with the Resource's codec in
// FlowOptions.dataProfiles. The plugin's Resources are 0.1 shared Tasks
// (Shared Objects) and shared sections; both carry one framed Automerge
// change per unit, which unframeChange decodes and checks (framing, change
// structure), throwing on anything else.
//
// Not checked here: that the change's actor is the one derived from the
// unit's signer (SO-SEC1, CHANGE_ACTOR_MISMATCH). The wire codec's decode
// gets the plaintext only, not the unit; the profiles' own codecs are made
// per unit (codecFor). See the open question in status-413e.md.

import { PROFILE_ID, unframeChange } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import type { DataProfileCodec } from "@openlfcp/wire";

const framedChange = (dataProfile: string): DataProfileCodec<unknown> =>
  Object.freeze({
    dataProfile,
    encode: (value: unknown) => value as Uint8Array,
    decode: (plaintext: Uint8Array) => unframeChange(plaintext),
  });

/** The codecs every identity flow call of the plugin passes (FlowOptions.dataProfiles). */
export const PROFILE_CODECS: readonly DataProfileCodec<unknown>[] = Object.freeze([
  framedChange(PROFILE_ID),
  framedChange(SECTIONS_PROFILE_ID),
]);
