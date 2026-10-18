# Usability pilot protocol for the 0.5.0 candidate

**Task:** LFCP-03-027 prepares it, LFCP-03-028 runs it (case U03-23, gate
G03-G). **Status:** draft for the owner's freeze. The threshold and the two
timed tasks are those of [pilot-0.3.md](../testing/pilot-0.3.md) §2, frozen on
2026-10-15; this document adds the procedure around them and changes none of
those values. Once the first pair starts, this protocol is frozen too: a
change after a run needs a new candidate and a new set of pairs.

Agents never stand in for participants. If five real pairs are not available,
G03-G is NOT_RUN and this material waits (it is not a lowered bar).

## 1. Goal

Find out whether two people who are new to Shared Tasks, and do not know its
commands, can share a section, join it, insert it into their own note and
resolve one ordinary problem, finding every step from what is visible in
Obsidian (the ribbon icon, the pane, the context menu).

Not measured: installation and the network (checked before the clock starts),
performance budgets (LFCP-03-026), anything about mobile.

## 2. Candidate and setup

- **Build.** The exact files of the 0.5.0 candidate (the release notes list
  their SHA-256). Each moderator compares the installed `main.js` with that
  checksum before the first session and writes down the build and Obsidian
  version, the OS and the server. A build that differs is not the candidate.
- **Server.** The default project server. Participants do not change it.
- **Participants.** Five *new* pairs: ten people who have not used Shared
  Tasks, know no commands of it, and can use Obsidian and a Markdown list. One
  person in a pair may be A (the sharer) and the other B; roles are fixed
  before the session. Nobody takes part twice.
- **Machines.** Desktop Obsidian 1.13.4 or later, with the beta installed by
  the moderator following [participant-onboarding.md](participant-onboarding.md)
  (not timed). Two machines per pair, or one pair on two vaults of one machine
  only when the owner accepts it (then record it; no two pairs share a
  machine).
- **Vaults.** The synthetic fixtures in `test/fixtures/pilot/` (section 8). No
  real names, no real notes.
- **Moderator.** One per pair; observes, keeps time, writes the record. Does
  not hint. May stop a session for safety (section 6).

### 2.1 Preconditions: the project server (D20)

The live server's limits are fixed (D20): 24 open connections in all and 8
per network address, 200 collaborations per identity, 50 new ones a day per
address. Ten vaults, two connections or more per vault, possibly behind one
network address. Before the first session, the person running LFCP-03-028
checks, and records the answer, in this order:

- [ ] The live server's configuration matches the values above (read the
      deployed config; do not infer it from the repository).
- [ ] The server is up and nothing else is using its connections during the
      sessions (check the open connection count before each pair).
- [ ] How many connections one vault with the candidate holds while idle and
      during the core flow (measure with one vault; do not guess).
- [ ] The sessions are planned so the connections of the pairs running at the
      same time stay below 24, and below 8 per address. Pairs run one after
      another, not in parallel, unless the count proves room.
- [ ] If participants share a network (one office, one home), the arithmetic
      above is repeated for that address, and one dry run with the same
      number of vaults behind that address passes before the pilot. A
      refusal for the quota during a session is not a participant failure:
      stop, record it, and rerun that pair after the cause is fixed.
- [ ] The server's privacy note and terms are the ones the participant gets
      (section 7).
- [ ] The day's new-collaboration limit is not exceeded: each pair makes two
      (the shared section and the problem scenario's, if it is a separate
      one); clean-up of test data is agreed with the owner, not done by the
      pilot.

The check of the live server is part of LFCP-03-028, not of this material.

## 3. Session outline (about 45 minutes)

| # | Step | Timed |
| --- | --- | --- |
| 0 | Welcome and consent (section 7); explain that the software is being tested, not the person, and that they may stop at any time | no |
| 1 | Moderator verifies build, vaults and server (section 2); participants have Obsidian open on the fixture vault | no |
| 2 | **Task 1, core flow** (section 4) | yes, <= 10 min |
| 3 | Break; the moderator prepares the problem (section 5) | no |
| 4 | **Task 2, problem** (section 5) | yes, <= 5 min |
| 5 | Understanding questions (section 4.4) | no |
| 6 | Feedback interview (section 9) | no |
| 7 | Moderator closes the session: removes access if asked, notes anything unsafe | no |

## 4. Task 1: core flow (U03-23, <= 10 minutes)

### 4.1 What is said

To A, read aloud, nothing else: "Make the Launch part of your plan shared with
your partner. Your partner should have it in their own Sprint notes note, and
you should both keep working on it."

To B, read aloud, nothing else: "Your partner will share something with you.
When you have it, put it in your Sprint notes note."

The moderator names no step, command, label or menu. The plugin name may be
said. How the two people exchange the invitation link is their choice (chat,
message, voice); the moderator provides a plain channel and does not suggest
which button produces a link.

### 4.2 The clock

Starts when the instruction to A has been read. Stops when all hold:

1. B's `Sprint notes.md` contains the Launch section (its heading and the
   three Tasks) and B's own text there is untouched;
2. A has made one edit (ticked a Task or changed its text) and it appears on
   B's side;
3. B has made one edit and it appears on A's side.

Both edits are asked for once the section is in place ("now both of you change
something in it"). That sentence is allowed and counts as no hint, because it
names no entry or step.

### 4.3 Hints, assisted runs

Any information about *how* (which icon, which menu, which word to look for,
the order of steps) is a hint, and the run is **assisted**. An assisted run
does not count toward the four passes. The moderator gives a hint only when
the pair has made no progress for 3 minutes, or at once if a participant asks
directly for one; every hint is written down word for word with the time. A
participant who gives up, or is stopped at 10 minutes, has a task time of
"not completed".

Not hints: re-reading the instruction, and "take your time".

### 4.4 Understanding questions (after Task 2)

Asked of each participant, answers noted word for word:

1. "What exactly did you share?" (the boundary: the Launch heading and what is
   under it, not the rest of the note)
2. "Where else does this text appear?" (the other person's note; copies)
3. "What does the double check mark ✓✓ mean?" (contract O-03; a correct answer
   is "shared", not "seen by the other person")

Each is scored: understood, partly, not understood. These do not decide the
threshold; they feed findings.

## 5. Task 2: the problem (<= 5 minutes)

### 5.1 Preparation (not timed, by the moderator)

Use a move conflict, which the 0.4 two-Obsidian check shows raises "Needs your
attention" (plain text edits to different parts merge and raise nothing):

1. Both vaults have the shared section open and current.
2. Turn off the network on both machines.
3. A moves one Task to another place in the section (cut and paste, or Tab
   under another Task); B moves the *same* Task elsewhere.
4. Turn the network on again and wait until both badges show "Needs your
   attention".

If the problem does not appear, the pair is rerun from the preparation step,
and the moderator records that it needed a retry. A problem that cannot be
made on this build is a blocker for the pilot, not a participant failure.

### 5.2 What is said, and the clock

Read aloud to both: "Something about your shared list needs your attention.
Sort it out." Start the clock then. It stops when the conflict is resolved and
both sides show the same order, the Task once. Hints are counted as in 4.3.

## 6. Observation record and incidents

For each pair, the moderator records:

| Item | Detail |
| --- | --- |
| Pair number, roles | No names beyond a first name or "P1/P2" |
| Build, SHA-256 of `main.js`, Obsidian version, OS, server | From section 2 |
| Time of Task 1 and Task 2 | Moderator's stopwatch; completed, not completed, assisted |
| Hints | Word for word, with time and which task |
| Stop points | Where someone stopped or hesitated more than 30 s, and what was on screen |
| Entry used | Ribbon, pane, context menu, card or palette |
| Wrong turns | Actions the participant took that were not on the path |
| Understanding | The three answers of section 4.4, scored |
| Feedback | Section 9 |
| Incidents | Below |

**Unsafe incident**, any of: private text published (anything outside the
Launch section reaches the other vault or the server, such as a
`PILOT-PRIVATE-*` marker in the other vault), data lost (a Task or text of
either person disappears without the person choosing it), a write to the
wrong note, or an invitation link shown to or sent to anyone but the
partner. The moderator stops, records it at once with what was on screen, and
does not recover it before recording. Any unsafe incident **blocks** the
gate regardless of times and of how many other pairs passed; it goes to an
owning repair task and a new candidate.

Optional: a screen recording or audio, only with the participant's consent
asked first, kept by the moderator and not attached to the record. The
record keeps pair numbers and first names only.

## 7. Privacy and consent

- Participants are told, before the session, in plain words: what is tested
  (the software, not them); that the vaults hold only made-up notes; that the
  synthetic text goes through the project's public server, which stores
  encrypted data and protocol metadata and sees IP addresses (links to its
  [privacy note](https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-privacy.md)
  and [terms](https://github.com/openlfcp/.github/blob/main/docs/operations/sync-server-terms.md));
  that a recording is optional and refusing costs nothing; and that they can
  stop at any time.
- No real names, e-mail addresses or notes in any record. The participant
  list (how they were found, how to contact them) is held by the owner, apart
  from the observations.
- Observations are published only anonymised: pair numbers, no quotes that
  identify anyone.
- Use no participant's own vault or account. The identities created for the
  pilot are test identities; the moderator removes them on request.

## 8. Fixtures

The vaults are in `test/fixtures/pilot/`, copied by the moderator into two new
folders and opened as vaults ("Open folder as vault"):

| Vault | Notes | Purpose |
| --- | --- | --- |
| A (`vault-a/`) | `Plan.md`: private line, heading `## Launch` with three Tasks and a paragraph, then `## Budget` with a private line; `Reading list.md`: unrelated | The section to share; `PILOT-PRIVATE-A` and `PILOT-PRIVATE-A-BUDGET` must never reach B |
| B (`vault-b/`) | `Sprint notes.md`: a private line, one Task and a paragraph; `Ideas.md`: unrelated | Where B inserts the section; `PILOT-PRIVATE-B` must never reach A |

After a session the moderator greps both vaults and the server-side
observations for the markers to confirm none crossed (an unsafe incident when
one does). A fresh copy of the fixtures is made for every pair.

## 9. Feedback collection

After the understanding questions, ask, in this order, and write the answers
down:

1. "What was the hardest moment?"
2. "Was there a moment you did not know what to do next? What did you expect to
   see?"
3. "Did the wording make sense? Was any word confusing?"
4. "Would you use this with a colleague? What would stop you?"
5. "Anything that worried you about your data?"

Plus a score for each task: "How easy was it? 1 (very hard) to 5 (very
easy)."

## 10. Success criteria (G03-G)

- **PASS**: at least 4 of the 5 pairs complete Task 1 in <= 10 minutes and
  Task 2 in <= 5 minutes, unassisted, **and** no unsafe incident in any
  session.
- **FAIL**: fewer than 4 such pairs, or any unsafe incident.
- **NOT_RUN**: fewer than five real pairs took part, or the candidate or
  server preconditions could not be met.

The threshold is not lowered after the run. Findings go to the owning repair
tasks and a new candidate; the retest uses five new pairs.

## 11. Outputs of LFCP-03-028

Anonymised observations per pair, the outcome matrix (pair x task: time,
assisted, completed), the incidents and issues with owning tasks, the
understanding scores, and the retest plan, in the MVP 0.3 evidence template.

## 12. Open for the owner

| ID | Question | Recommendation |
| --- | --- | --- |
| P-01 | How participants are recruited and whether they are compensated | Recruit people from outside the project who use Obsidian for tasks; a small thank-you of the owner's choosing is fine, not tied to a result. Decision and any budget are the owner's |
| P-02 | One place or remote sessions | In person, or remote screen share with the moderator watching both screens; do not rely on audio alone |
| P-03 | Two machines per pair or two vaults on one machine | Two machines; one machine only as a recorded exception |
| P-04 | Dates | The owner expects participants about 2026-10-22 (D21); schedule once the candidate is built (phase 2) |
