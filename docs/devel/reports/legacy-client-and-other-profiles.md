# Legacy clients and collaborations of another profile (LFCP-02-004)

Evidence for LFCP-02-004: how Shared Tasks 0.3.x behaves when it meets a
collaboration of another Data Profile, such as a 0.4 shared section
(`org.openlfcp.shared-sections.v1`). Written 2026-10-08, obsidian `6cee927`.

## Findings on the released 0.3.1

| # | Situation | 0.3.1 behavior | Evidence |
| --- | --- | --- | --- |
| L1 | A stored Resource of another profile (a downgrade from 0.4 on the same install database) | Opened as Shared Objects at startup and merged with the Shared Objects profile: `#local` never looked at the stored profile | `src/core/lfcp/runtime.ts` before `35f7f83`; review finding OP-03 |
| L2 | Joining a collaboration of another profile | The profile was checked only **after** the claim: the one-time link was used up, and the message said "does not use Shared Objects" without asking for an update | `src/core/collab/service.ts` before the 0.3.2 join change; OP-03 |
| L3 | Section markers in a note (`lfcp-section`, `lfcp-node`) | Ignored: the 0.3 scanner recognizes only `lfcp-ref:` comments | `src/core/refs/comments.ts` |
| L4 | A Task ref inside a section, to a section Resource | As any ref: `RESOURCE_UNKNOWN` when the Resource is not on the device; if it is stored (L1), it was read through the wrong profile | `src/core/projection/engine.ts` |

No silent data loss in the vault was found for L3/L4: 0.3.1 neither rewrites
nor removes comments it does not know. L1 and L2 are the unsafe cases.

## What 0.3.2 changes

| # | 0.3.2 behavior | Commit | Tests |
| --- | --- | --- | --- |
| L1 | A stored Resource of another profile is `unsupported`: never opened, merged or written; "Resource status" says it needs a newer version; every other command refuses with that message | `35f7f83`, `4490550` | `test/core/lfcp/foreign-profile.test.ts`, `test/core/collab/commands.test.ts` ("a collaboration of another Data Profile…") |
| L2 | Join asks the SDK to check the profile before the claim (`acceptInvitation({ dataProfiles })`, sdk-ts task 086). The link stays unused, nothing is stored, the user is told to update and join again with the same link | pending: committed with the `@openlfcp/*` 0.1.2 bump (needs sdk-ts 0.1.2 on npm) | `test/core/collab/join-profile.test.ts` (in the working tree until then); sdk-ts live test `conformance/interop/rust-server-invite.test.ts` step 2a |
| L4 | A ref to a stored Resource of another profile: `RESOURCE_UNSUPPORTED`, nothing sent or rendered, one notice per note | `35f7f83` | `test/core/lfcp/foreign-profile.test.ts` |

## Minimum version and downgrade

- **0.3.2 must be released before any 0.4 beta.** A downgrade from 0.4 to
  0.3.1 or older keeps L1. The 0.4 release notes should say "downgrade only
  to 0.3.2 or later".
- A local storage version bump is **not** needed for profile safety: 0.3.2
  decides by the stored profile of each Resource. 0.4's own local records
  (journals, projection bases under new keys) are invisible to 0.3.2, which
  reads only the keys it knows.
- Clients from the community directory do not update by themselves, so
  0.1.0–0.3.1 will meet section invitations for a while. They burn the link
  (L2). The inviter's UI in 0.4 should say that the invitee needs Shared
  Tasks 0.4 (decision recorded in the review, OP-03/OP-20).

## Status

LFCP-02-004 can close once the L2 commit lands with 0.1.2. Everything else
is in `main`.
