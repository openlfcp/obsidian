# Pane prototype for MVP 0.3: findings

**Task:** LFCP-03-007 (milestone M03-1; findings F-01, F-02; cases U03-01,
U03-03, U03-06; gates G03-B, G03-C, G03-E).
**Base:** obsidian `main` at `b00098a`.
**Status:** the prototype runs on mock facts. It is not sync and not
evidence of sync. No human acceptance or pilot result is claimed here. The
native screenshot run is NOT_RUN: it runs in CI after LFCP-03-031.

## 1. What was built

The prototype is the display layer of the future pane. LFCP-03-012 (pane
host) and 013 (context, CTA, statuses) reuse it.

| Part | Where | What it does |
| --- | --- | --- |
| View model | `src/core/pane/model.ts` | Pure: `(context, registry, section StatusView, flow) → PaneModel`. Holds the current context, the primary CTA (P1), secondary actions with disabled reasons, destructive actions in a menu, status lines, the share preview summary, the section list ("In this note", "Placed elsewhere", "Not inserted yet"), unfinished flows. Every text follows the contract |
| Catalogue and flows | `src/core/pane/actions.ts`, `src/core/pane/flows.ts` | The §3 action catalogue; the stages of share, invite, join, insert and repair, each waiting for the user or for an effect |
| Mock facts | `src/core/pane/mock-facts.ts` | Turns a fixture section (a StatusView-level fact set) into `StatusFacts` and runs the real `statusView`. The pane reads a real StatusView with its conditions, not a second status path |
| Prototype | `src/core/pane/prototype.ts` | The four UX §3 layouts, a no-note start, every fixture, and clickable flows: share → invite, join → insert, problem (held edits → repair). Clicks move the mock only |
| Renderer | `src/obsidian/ui/pane-renderer.ts` | Plain DOM from a `PaneModel`: native buttons, visible focus, no focus trap, disabled actions focusable with their reason, focus kept across redraws, Obsidian CSS variables, narrow layout (`styles.css`) |
| Developer view | `src/obsidian/ui/pane-prototype-view.ts` | An `ItemView` with a state picker, a narrow toggle and the prototype's own controls ("Mock: finish …", "Cancel", "Continue later", "Mock: switch the active note") |

**Opening it.** Set `"developerPanePrototype": true` in the plugin's
`data.json`, reload the plugin, and run "Open pane prototype (developer)".
Without the flag the view and the command are not registered, so the
palette does not list them. There is no ribbon, menu or settings entry:
production entries belong to LFCP-03-012.

The prototype calls no operation, network, vault or clipboard API. A pane
action outside a flow says which existing dialog, card or confirmation it
would open ("Nothing runs here"). The existing modals (share preview,
invitation, card, resolver) are kept as they are and are not moved into the
pane (UX §1).

## 2. Acceptance criteria

| Criterion | Evidence | Result |
| --- | --- | --- |
| The four UX §3 layouts and clickable share → invite, join → insert and problem flows on explicit mock facts | `PanePrototype` scenarios `first-use`, `just-joined`, `healthy`, `held-edits`; `test/core/pane/prototype.test.ts` (each layout's primary CTA); `test/obsidian/pane-renderer.test.ts` "prototype flows, walked with the pane's buttons only" (all three flows end to end, plus join then "Continue later") | PASS (unit, happy-dom) |
| Narrow pane, keyboard focus, note switch with an open flow; keep the existing good modals | Renderer: focus kept on the same control across a redraw, fallback to the heading, never taken from outside the pane (`pane focus` tests); the share flow keeps Plan.md when the active note switches (T2, renderer test and native spec); narrow 280 px layout in `styles.css` | PASS (unit); native NOT_RUN |
| Concrete findings and UX updates; the prototype is not real sync or evidence | §4 and §5 below | PASS |
| Required check: walkthrough without the palette; primary CTA and visible next step | Each flow is walked with the pane's buttons and the prototype controls only; every fixture's primary CTA is checked in the model and the DOM | PASS (unit) |
| Screenshots on synthetic content | `test/native/specs/pane-prototype.e2e.mjs` saves each scenario, light and dark, to `$LFCP_SCREENSHOT_DIR` | NOT_RUN (CI after 031) |
| Human acceptance | None. No pilot was run for this task | NOT_RUN |

### Fixture binding (for LFCP-03-013)

`test/core/pane/model-fixtures.test.ts` runs every state of
`test/fixtures/ux-0.3/states.json` (20 states) through the real reducer and
the view model, and checks:

- the reducer gives back the fixture's own `state`, `sync`, `access`,
  `connection`, `connectionQualifier` and `refusal`;
- `expected.primaryCta` (or no primary);
- every `expected.enabled` action is shown and enabled;
- every `expected.disabled` action is shown and disabled, with the
  fixture's reason word for word;
- every `requiredClaims` text is in the pane, and no `forbiddenClaims` or
  `globalForbiddenClaims` text is in any pane string (case-insensitive).

This binds the fixtures to the real reducer and to the view model. 013
still has to feed the model from the real hosts (`SectionsHost` status,
`SectionRegistryView`, the editor context).

## 3. Contract and fixture changes in this PR

| Change | Why |
| --- | --- |
| Contract §6, row `heldCheck` "pending": the card's sentence "No updates waiting in the sync queue. Notes with this section are still being checked for edits not sent." is allowed | The `loading` fixture requires "Notes with this section are still being checked for edits not sent.", but §6 allowed only "Not current yet: not every note with this section was checked." The card already says the fixture's sentence |
| Fixture `unknown-result-insert`: `localPersistence` "confirmed" → "unconfirmed" | With `heldCheck` "pending" the reducer always reports `localPersistence` "unconfirmed" (held text not known to be on disk). The fixture stated a view the reducer cannot produce. The schema test now checks this invariant |
| Fixture `selection-exact`: a `preview` with the warnings `future-additions` and `private-text-before-next-heading` | Its required claim (the H5 sentence about private text after the section) is a share preview warning (`share.ts`), but the fixture had no preview fact to show it from |
| Contract header and §13: the view model of 007 already runs the fixtures | Previously it said no task bound them to code before 013 |

## 4. Findings

| ID | Finding | Update for 012/013/014+ |
| --- | --- | --- |
| P-01 | The fixtures give a section at StatusView level without `conditions`, so P1 cannot be read from them directly. The prototype rebuilds `StatusFacts` and runs `statusView`, and all 20 states then bind | Keep `model-fixtures.test.ts` as the frozen suite. 013 passes the host's real `StatusView`. A new fixture must be one the reducer can produce |
| P-02 | `cursor: "private-text"` does not say whether a heading lies above the cursor, which `proposeRange` needs. The model is conservative: "Share section…" is a secondary action and there is no primary | 013: add a context fact (the heading `proposeRange` would take, or none) and make Share primary only with a heading |
| P-03 | Which section the pane is about when the cursor is not in one is not defined. The `unplaced` fixture has the cursor in private text and Sprint in focus. The model takes the section as given | 013 decides the rule. Proposal: the section under the cursor, else the row the user chose in the list, else the section just joined until the user moves on. Never pick one automatically from the list |
| P-04 | I4 "ready means hosted" needs a hosting fact that `StatusView` does not carry. `PaneSection.hosting` was added (optional) | 013/014: feed it from the same source as the card's `hosting` input |
| P-05 | Flow stage names mix journal stages ("captured", "projected", "claiming capability") with pane-only steps ("preview", "role", "link"). `flows.ts` lists them, and an unknown stage counts as waiting for the user, never as a guessed effect | 014–017: map each journal stage onto `FLOW_STAGES` and keep the names in one place |
| P-06 | "Cancel" and "Continue later" are flow controls (P2) and not catalogue actions. The prototype offers Cancel only before any effect and "Continue later" after one | Contract §3/§5 could name them as flow controls when 014 implements them |
| P-07 | During a join, the header's "Join with a link…" and a flow step "Join" would be two buttons with nearly the same meaning. The prototype makes pasting the link and choosing Join in the pane field the explicit Join (UX §6, I5). While the link is awaited there is no primary, and the header entry stays (A2) | 015/016: one Join step, in the field |
| P-08 | A disabled action must state its reason, and `disabled` buttons cannot be focused. The renderer uses `aria-disabled`, a visible reason under the button and `aria-describedby`; a click does nothing | 013: keep this pattern; the executor still checks again (A3) |
| P-09 | The `no-editor` and `unknown-result-join` fixtures require disabled actions that do not apply there ("Copy readable text": "No note is open."). In a narrow pane they add noise | Review with the owner: show only the disabled actions a user would look for in that state |
| P-10 | No fixture has a running flow at an effect stage (no primary, progress only, P1 row 2) | 013: add one, e.g. a join while "claiming capability" is running |
| P-11 | The package's healthy main text ("сервер принял изменения") would claim acceptance of this device's changes. The prototype uses the contract's §6 sentence ("Current as last checked with the server. This does not mean others have seen it.") | None: the contract already decides this |
| P-12 | The prototype and the fixtures are in `main.js` even with the flag off: about 62 KB of the minified bundle, 26 KB of it the fixtures | 012: keep it as a developer tool for the pilot, or strip it with a build flag before the stable release |
| P-13 | The brief counted 19 fixture states; `states.json` has 20 | None: the tests use the file's count |

## 5. Not covered here

- Real hosts: no `SectionsHost` or `SectionRegistryView` wiring, no editor
  context and no production entries (012/013).
- 200% zoom, reduced motion and mobile layout: the CSS uses no motion and
  no fixed widths, but nothing was measured. The native spec covers light
  and dark only.
- Human comprehension of the layouts: the pilot (pilot-0.3.md) measures it.

## 6. Commands

```sh
pnpm vitest run test/core/pane test/obsidian/pane-renderer.test.ts \
  test/core/ux-contract-fixtures.test.ts test/core/settings.test.ts test/obsidian/plugin.test.ts
# Native (not run in this task; CI after LFCP-03-031):
LFCP_SCREENSHOT_DIR=<dir> pnpm --dir test/native test -- --spec test/native/specs/pane-prototype.e2e.mjs
```
