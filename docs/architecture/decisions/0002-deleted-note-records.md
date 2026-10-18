# ADR 0002: What a deleted note leaves in the local records

- **Status:** Proposed, 2026-10-18 (LFCP-03-048, obsidian#46). Phase A of the
  task: findings and a recommendation; no implementation yet.
- **Scope:** the install's local records of shared sections: projection
  bases, the journal (unfinished operations) and pending candidates (kept
  copies), plus the badge facts the host keeps in memory. Never synced.
- **Evidence:** `test/core/sections/deleted-note.test.ts` pins today's
  behaviour and the harm of the reverted change.

## Context

The host reacts to a note's deletion by forgetting its placement index and
its editor state (`SectionsHost.vaultChange`, kind `delete`). Bases, journal
entries and candidates stay. LFCP-03-046 added "drop the bases of a deleted
note" (5942b25) and reverted it (885beb3) after review, because:

1. candidates are found through `bases.load(projectionId)`
   (`SectionActions.#keptCopies`, behind "Discard the local copy…"), so a
   dropped base hides the copy from the card while diagnostics still count it;
2. a note restored from the trash, or deleted and created again by an
   external sync, lost the automatic merge through its old base;
3. a leftover `committed` journal entry then had no projection to resume it.

What Obsidian lets the plugin observe: a `delete` event when the file goes
(also for a deletion made while Obsidian runs by another tool); a `create`
event when it comes back, at the old path or elsewhere. **Emptying the
system trash, or the `.trash` folder, is not observable**, and with the
"permanently delete" setting there is no restore at all. A rename made while
Obsidian is closed (or by a sync tool) is a delete plus a create at startup.

## Findings (today's behaviour, each with a test)

| # | Situation | What happens now | Harm |
| --- | --- | --- | --- |
| F1 | Delete, then restore at the **same path** (Trash "put back", sync) | The base is found by path; peers' changes made meanwhile are rendered, nothing is sent; no duplicates (`today: bases stay…`) | None. This is the behaviour any fix must keep |
| F2 | Delete after a pass committed but did not write the note (crash window), then restore | The `committed` entry is resumed by the same projection ID; the binding is written; one Task (`today: a committed entry…`) | None |
| F3 | Same as F2 with the reverted drop | Restore is held as `base-unknown`; the entry is never resumed (it names the dropped projection); "Keep mine" adopts the model, which already has the Task, while the note's line has no binding: **NODE_BINDING_LOST**, the projection is blocked, the model's Task and the note's line stay apart, the entry stays unfinished (`naive drop: …`). The issue feared a duplicate Task on "Keep mine"; this harness shows a blocked projection instead. A duplicate is still possible if the user then re-creates the line from Repair; not reproduced | Real (blocked, needs Repair), not silent loss |
| F4 | Kept copy (read-only, refused) of a deleted note's section | With bases kept it is found and can be discarded. With the drop it is neither offered nor resolved, and diagnostics still count it (`naive drop: the base is gone…`) | The drop orphans private text |
| F5 | A Repair recovery copy (`candidateId` `repair:<uuid>`, `projectionId` `repair:<path>`) | `#keptCopies` finds a candidate by `base.locator.section` or by `projectionId.includes("#<key>#")`; neither holds for `repair:<path>`. **Never discoverable by section today, deleted note or not** (`today (already…)`). Found while investigating; independent of deletion | Existing bug: "Your previous text is kept as a recovery copy" cannot be discarded from the card |
| F6 | Delete, never restored | Base, journal entries and candidates (with private note text) stay for good; nothing resolves them (`today: delete leaves…`) | Growth only; plus text the user may expect gone |
| F7 | Delete of a note whose section is `diverged` / `base-unknown` / holds edits | `ProjectionFactsStore` keeps the projection's facts and held entry until a restart: the section keeps showing a problem in a note that no longer exists (`the badge facts…`; the delete handler calls only `damaged(path, ∅)`) | Real, user-visible, cheap to fix |
| F8 | Restore to a **different** path, or an external rename (delete + create) | No base for the new path: a note that shows the model seeds a new base silently (the old one is orphaned, F6); a note with unsent edits is held as `base-unknown` and needs Repair. Not lost, but not automatic either (by code reading; not covered by a test) | Friction, not loss |
| F9 | A base-unknown candidate of a pending projection (`pending:<path>#<key>#<n>`) when its note is renamed | The id embeds the old path; the resolving pass uses the new path's id (`base-unknown:pending:<new>…`), so the old candidate is not resolved (by code reading; not covered by a test) | Stale kept copy until discarded |

Summary: the reverted drop is wrong as implemented (F3, F4). The status quo
has no loss, but unbounded growth (F6), stale badge facts (F7), an
undiscoverable copy kind (F5) and an indexing scheme (by projection ID, via
the base) that makes every future cleanup dangerous.

## Decision drivers

- Never lose or hide user text: a candidate is dropped only by an explicit
  choice (journal.ts: "never dropped to save space").
- A restore at the same path must keep merging through the old base (F1, F2).
- No multi-step cleanup with a crash window: a crash at any point must leave
  the state at least as recoverable as before.
- Trash emptying cannot be observed, so "keep until the trash is emptied"
  is not an option.

## Design

### 1. Candidates are keyed by section, not by projection

`PendingCandidate` gets `sectionKey` (`<resource base64url>#<sectionId>`, the
key surfaces already use) written at creation by every producer (engine
`base-unknown`, `drift`, `pasted`; commit.ts refusals; the host's flush
failure; Repair). A second index `section-candidates-by-section:<key>` joins
the two existing ones (all, by projection). `#keptCopies(key)` reads that
index and no longer loads any base; the `includes("#key#")` heuristic goes.

Old records have no `sectionKey`. A one-time backfill at startup derives it,
in this order: the base of its projection; the `pending:<path>#<key>#<n>`
id; else by parsing the candidate's `sourceText` (it holds the section's
boundary markers, so `parseSections` yields the ref; this also fixes F5 for
existing `repair:` copies). A candidate that yields no key stays reachable by
its projection and in diagnostics, and the backfill reports it there.

`resolveCandidate` maintains the new index. Candidate ids that embed a path
(`base-unknown:pending:<path>…`) are made path-independent for new records
(`base-unknown:<key>#<n>`), which also fixes F9.

### 2. Bases of a missing note are kept, bounded by time

No deletion handler changes the base. A base whose note path is not in the
vault is **dormant**; this is derived, not stored, so there is no state to
get out of step and no crash window (delete, crash, restore is F1/F2 as
today). The host records `missingSince` (one small key per path, written on
the `delete` event or by the startup sweep for deletions made while Obsidian
was closed; cleared on `create` at that path).

A sweep at startup (and once a day while running) removes bases that have
been missing longer than **N = 30 days**, with these rules:

- candidates are never swept (design 1 keeps them reachable by section);
- a base with an unfinished journal entry is swept too, but its entries are
  first abandoned with the reason `note-deleted` (the model already holds
  what they committed; a restore after N days in that exact crash window ends
  as F3, which is rare enough to accept and is documented);
- a base is also swept at once when its Resource has left the device.

N is a constant, not a setting. 30 days is the usual horizon of an OS trash
that empties itself; we chose time because the emptying is invisible.

### 3. The badge forgets a deleted note's projections

On `delete`, the host calls `facts.forget(key, id)` for each projection of the
path and `heldPassed(path, ∅)` (F7). The next pass after a restore records
them again.

### 4. Optional, separate: revive a dormant base by section (F8)

When a pass finds a section with no base at its path and a dormant base for
the same section exists, and the note shows exactly the base (no local
difference), adopt that base at the new path (same projection ID, so its
entries resume). With any difference the existing `base-unknown` hold
applies, so a copy pasted from a live note is never merged with a stale base.
This helps external renames and restores to another folder. It touches
`SectionEngine.#projectionIds`, the riskiest code here, so it ships only if
the pilot meets F8.

## Options

| | Change | For | Against |
| --- | --- | --- | --- |
| **V0** | Design 1 and 3 only; bases stay forever | Smallest; fixes F5, F7, F9 and the keying that makes later cleanup safe | F6 stays: growth, and deleted notes' private text lives on |
| **V1 (recommended)** | Designs 1, 2 and 3 | No loss; bounded growth; no crash window; F1 and F2 untouched | A restore after more than N days is held as `base-unknown` (Repair), as a copy is today |
| V2 | V1 plus design 4 | Automatic merge for external rename and restore elsewhere | Engine change with real risk; F8 is friction, not loss |
| V3 | Drop at delete (the revert) | Smallest state | F3, F4: rejected |

## What the user sees

Normally nothing changes. After V1: a section's card lists its kept copies
whatever notes exist, "Discard the local copy…" finds every kind of copy, and
the badge stops showing a problem for a deleted note. A note restored within
30 days merges as before. Later it opens held as "Needs your choice", with
Keep mine or Use shared in Repair. Diagnostics gain two counts: bases of
missing notes and the age of the oldest.

## Open questions for the owner

1. **N** (recommended 30 days) and whether a setting is wanted (recommended not).
2. **Candidates of deleted notes:** keep until the user discards them
   (recommended: they are the only copy of private text, and the rule is
   explicit choice only), or expire them after N too? Deleting a note and
   expecting its text to leave the device is a fair expectation. If the owner
   wants it, the card needs a line that says the copy belongs to a deleted
   note, and the expiry needs its own notice.
3. **V2:** now, on evidence from the pilot, or never.

## Implementation

Three PRs, each independently useful and bisectable:

1. Candidate `sectionKey`, index, backfill, `#keptCopies` by index, path-free
   candidate ids, plus the delete-time facts fix (design 1 and 3). About
   250 lines with tests; touches `journal.ts`, `stores.ts`, `engine.ts`,
   `commit.ts`, `actions.ts`, `sections-host.ts`.
2. `missingSince`, the sweep, diagnostics counts (design 2). About 200 lines
   with tests; `stores.ts`, `sections-host.ts`, `diagnostics-collect.ts`.
3. Design 4, only if wanted. About 150 lines with tests; `engine.ts`,
   `stores.ts`.

Tests, on the harness of `deleted-note.test.ts` (no stress): delete, restore
(same path, peers' changes meanwhile); delete, crash after commit, restore;
delete, sweep after N days with and without an unfinished entry, restore;
candidates found by section for every producer, and after the backfill of
legacy records; rename with a pending candidate. No native spec is needed;
`sections-interruption` already deletes a note live, and its assertion about
the bases is the one the reverted commit changed.
