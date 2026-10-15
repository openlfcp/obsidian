# Action seam and contract checks (LFCP-03-023)

The evidence of LFCP-03-023 (M03-4, P0; finding F-C08; cases U03-04…07,
U03-24…28). It checks, with automated tests, that every surface runs its
actions through one seam with the same guards, and that the UX contract's
fixtures and words hold. Written 2026-10-15. The work started on `main`
`0deb18d` (tasks 001–021 merged) and was rebased onto `ec4317b` (022 focus
and keyboard, 039 SDK `@openlfcp/*` 0.2.1). Spec `mvp-0.2-baseline.12`
(`bf1c78c`), server `138030a` for the live runs.

## The seam

UX contract §3: the pane, the card, the editor menu and the palette run an
action by its ID through `ActionDispatcher` (`src/core/actions/dispatcher.ts`).
Each action has one handler (`coreHandlers`), whose executor is
`SectionActions` (or the collaboration commands, or the host). Availability
is one pure predicate per action (`src/core/actions/descriptors.ts`).

## Inventory: what was covered, what was added

| Property | Before this task | Added |
| --- | --- | --- |
| P1. Palette command → dispatcher, surface `palette` | Behaviour only (`share-reservation`) | `test/obsidian/action-seam.test.ts`: the §3 table = `PALETTE_COMMAND` = registered IDs and names; each command runs its action through `actions.run(…, "palette")` on the editor's note |
| P2. Card and menu → dispatcher | `actions.test.ts` (A7, card); `pane-host.test.ts` (menu, stubbed `run`) | Surface independence below covers the menu's handlers |
| U03-07. Same handler, same guards from every surface | Per-flow tests | `test/core/actions/dispatcher.test.ts`: all 21 actions × 4 surfaces × 9 request shapes reach the same executor call with the same arguments; the one difference is where "Join with a link…" asks for the link (I5) |
| P3. The executor checks again (target, revision, access, host) | `actions.test.ts` (U03-05, stale revision, host refusal), `insert-destination.test.ts` | Shared sections off: no section action reaches the executor (A6) |
| P4. A second start from another surface | Share across surfaces, invite, join (one lock) | Insert from the pane, then the palette and the menu on that note: one preview brought forward, one copy |
| P5. Unknown result is checked, not repeated (D12) | Share, insert, join (`actions.test.ts`, `insert-destination.test.ts`, `join-flow.test.ts`, `pane-join.test.ts`) | — |
| P6. UX fixtures match rendering | Model, renderer, plugin pane path (`model-fixtures`, `pane-renderer`, `pane-fixtures`, no state skipped) | — |
| P7. Words by the vocabulary | Pane, card, badge, catalogue, descriptors, previews | `vocabulary.test.ts` also scans `sections/actions.ts`, `actions/dispatcher.ts`, `collab/join-flow.ts`, `collab/service.ts`, `obsidian/plugin.ts`; each remaining exception has its reason |
| P8. Every action has a handler | `actions.test.ts` (LFCP-03-013) | Every action reaches something from some request (no dead button) |
| Dialogs of every surface keep Tab and give focus back (022, U03-18) | `focus-return.test.ts`, native `pane-keyboard` (per dialog) | `action-seam.test.ts`: every Modal and SuggestModal class of the plugin is opened through `returnsFocus` (or the prompter's `opened()`); a bare `new …Modal(` fails it |
| P9. A key from the pane names one section | None: no row without a key was ever tested | `host-facts.test.ts`, `insert-destination.test.ts`, `dispatcher.test.ts` (obsidian#30) |

The U03 cases of the card are covered by these suites:

- U03-04: `target.test.ts`, `target-canaries.test.ts`, `host-facts.test.ts`
  ("a selection is the executor's own scope rule").
- U03-05: `actions.test.ts` (U03-05).
- U03-06: `states.json` through `model-fixtures`, `pane-fixtures`.
- U03-24: `collab/commands.test.ts` (F-05 section dispatch).
- U03-25: `status/held-queue.test.ts`, `pane/problems.test.ts`.
- U03-26: `target.test.ts`, `target-canaries.test.ts`,
  `share-invite-journey.test.ts`.
- U03-27: `preview-display.test.ts`, `insert-preview-modal.test.ts`.
- U03-28: `status/access-connection.test.ts`, `pane/truth-model.test.ts`.
- Secret redaction (U03-11): `diagnostics.test.ts`, `join-flow.test.ts`
  ("never holds the link or its secret"), `collab-ui.test.ts` (the join
  dialog masks the link).

## Defects found and fixed

1. **obsidian#30 (LFCP-03-040).** Right after a join, "Insert into a
   note…" in the pane opened the section picker. The issue named one cause:
   a row whose model is not read yet is keyed by its Resource alone. The
   live test showed a second, earlier one: the click came before the
   registry listed the row, so the pane named no section at all. Now the
   pane names the section just joined by its Resource until the registry
   lists it, and the insert takes the one section of a Resource named
   alone. A key that matches none or several still asks. `sections-resume`
   #3 no longer waits for the section ID, and passes live.
2. **Invite from a row without a key.** The dispatcher cut a section key at
   its "#". A Resource alone has no "#", so the key lost its last character
   and an invitation decoded the wrong Resource. It now reads the Resource
   of either form.
3. **"Collaboration" on section surfaces.** A section's join failures,
   invitation errors and refusal notices said "collaboration". Join
   failures now say "the server". Invitation errors say "section" for a
   shared section and "collaboration" for a 0.1 one. A Resource without a
   local name is named by its profile.

## Not changed: candidates

- **C1. Invite does not re-check access freshness.** The descriptor
  disables "Invite collaborator…" until access is checked with the server
  (`canInvite` unknown or false). The executor (`CollabCommands.inviteTo`,
  `Collaboration.invite`) checks that the section is hosted and ready and
  that this device may write. It opens the role dialog without the
  freshness check. Only the SDK's authorization check guards the side
  effect, so the palette's command reaches a dialog the pane would not
  offer. This is a product decision: either the executor refuses on
  stale access as the descriptor does, or the contract says the palette
  may try. Owner question; repair task if refused.
- **C2. Wording where the profile is unknown.** Two texts can still reach
  a section: "Shared collaboration" as the name of a join not settled yet
  (`pendingJoins`, the resume notices), and "This collaboration is not on
  this device." (a Resource missing from the registry). Both are listed
  exceptions in `vocabulary.test.ts`.
- **C3. Wording outside the scanned files.** Some files can show
  "collaboration" during a section's join or invitation:
  - `collab/messages.ts`: the plain texts of SDK codes.
  - `collab/commands.ts`: the palette's join dialog and its progress,
    "Connecting to the collaboration's server…".
  - `ui/import-section.ts`.
  - `collab/view.ts`: "Resource status", the technical details.

  These need a wording task with a decision per text. The 0.1 texts
  among them are correct.
- **C4. Fixtures in the native harness.** UX contract §13 says that
  LFCP-03-023 runs the `states.json` fixtures in the native harness. Only
  the developer prototype does that (`pane-prototype.e2e.mjs`). The real
  plugin pane runs the fixtures on the recording mock
  (`pane-fixtures.test.ts`). A native spec that builds each state in real
  Obsidian has not been written: NOT_RUN. It is a candidate for LFCP-03-024
  or its own task.
- **C5. Host actions with sections off.** From the dispatcher, "Open for
  editing", "Copy readable text" and "Copy shared section" still run while
  shared sections are off. The pane shows them disabled, and their palette
  commands are not registered. They change no shared state, so this is
  only noted.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint; pnpm typecheck
LFCP_SPEC_DIR=<spec checkout at bf1c78c> pnpm vitest run \
  test/core/actions test/obsidian/action-seam.test.ts test/core/vocabulary.test.ts \
  test/core/pane/host-facts.test.ts test/core/sections/insert-destination.test.ts
LFCP_SERVER_BIN=<lfcp-server at server.lock> LFCP_REQUIRE_LIVE=1 pnpm vitest run \
  test/e2e/sections-resume.test.ts test/core/collab/live-sections.test.ts test/core/collab/live.test.ts
pnpm test
gh workflow run native.yml --ref mvp03/023-contract-checks
```

The results are in the PR description.
