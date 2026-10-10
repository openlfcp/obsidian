# Documentation navigator

| Document | For | What it covers |
| --- | --- | --- |
| [OBSIDIAN-ARCHITECTURE-01.md](OBSIDIAN-ARCHITECTURE-01.md) | everyone | Architecture of the Obsidian adapter |
| [architecture/diagnostics.md](architecture/diagnostics.md) | developers | The diagnostics export (LFCP-02-065): what the local report holds and leaves out, the detailed option, failure handling |
| [architecture/local-state.md](architecture/local-state.md) | developers | Where LFCP state, secrets and the install marker live, eviction, the Automerge wasm choice (LFCP-059) |
| [architecture/projection.md](architecture/projection.md) | developers | Markdown → Shared Object projection: glyphs, owned fields, conflicts, re-association, echo guard (LFCP-061) |
| [architecture/collaboration.md](architecture/collaboration.md) | developers | The collaboration commands: SDK flows, invite presets, secrets, exact-byte detach, offline and blocked states (LFCP-065) |
| [architecture/section-parser.md](architecture/section-parser.md) | developers | The shared-section parser (MVP 0.2, not wired yet): modules, reuse of the 0.1 scanner, fail-closed boundaries, raw blocks, the private tail |
| [architecture/decisions/0001-codemirror-transactions-for-sections.md](architecture/decisions/0001-codemirror-transactions-for-sections.md) | developers | ADR 0001 (proposed, MVP 0.2): CodeMirror transactions for shared sections in open notes, the file path for the rest; spikes S1–S6 |
| [demos/two-vault-demo.md](demos/two-vault-demo.md) | everyone | The canonical two-vault demo in real Obsidian, step by step with expected results (LFCP-072) |
| [assets/shared-tasks-demo.gif](assets/shared-tasks-demo.gif) | everyone | The demo animation shown in the README: a task ticked in one vault updates in the other (synthetic notes) |
| [guides/user-guide.md](guides/user-guide.md) | everyone | Step-by-step user guide: install, create, share, invite, join, many tasks at once, offline, conflicts, troubleshooting |
| [guides/shared-sections.md](guides/shared-sections.md) | everyone | Shared sections (preview): turn it on, share, invite, join and insert, what the marks mean, offline, conflicts, copying, removing access, detaching, repair, limits |
| [guides/choosing-a-server.md](guides/choosing-a-server.md) | everyone | Choosing a sync server: the project server wss://sync.openlfcp.org as the default, why the choice is permanent, running your own |
| [devel/testing/mobile-sections-checklist.md](devel/testing/mobile-sections-checklist.md) | developers, owner | Manual checks of read-only shared sections on one mobile device (LFCP-02-095, V3) |
| [devel/testing/two-vault-e2e.md](devel/testing/two-vault-e2e.md) | developers | The two-vault E2E against the real server: running it, what it proves, the harness (LFCP-066) |
| [devel/testing/security-vertical-slice.md](devel/testing/security-vertical-slice.md) | release | The MVP 0.1 security/privacy release gate (LFCP-071): every security boundary in one live scenario |
| [devel/testing/load-in-clean-vault.md](devel/testing/load-in-clean-vault.md) | developers | Manual check: load the built plugin in a clean vault |
| [devel/testing/ime-checklist.md](devel/testing/ime-checklist.md) | release | Manual IME check in a shared note before the first 0.4 beta (the condition of ADR 0001) |
| [devel/testing/native-harness.md](devel/testing/native-harness.md) | developers | The native harness (LFCP-02-096): the built plugin in a real, sandboxed Obsidian from the CLI; safety rules, cache, pinned versions |
| [devel/testing/obsidian-host-facts.md](devel/testing/obsidian-host-facts.md) | developers | Obsidian host facts MVP 0.2 depends on (LFCP-02-005 evidence): minAppVersion was a beta, tabs by default, comments visible in Live Preview |
| [devel/testing/platform-smoke.md](devel/testing/platform-smoke.md) | release | Desktop platform smoke (LFCP-068): the CI matrix and the manual checklist per OS |
| [devel/testing/platform-smoke-runs.md](devel/testing/platform-smoke-runs.md) | release | Records of platform smoke runs per OS, with the current status by platform (LFCP-068) |
| [devel/reports/section-performance-headless.md](devel/reports/section-performance-headless.md) | developers | Headless performance of shared sections on W20–W2000 (LFCP-02-067/068): results against the budgets, the plugin fixes, the SDK remediation |
| [devel/reports/legacy-client-and-other-profiles.md](devel/reports/legacy-client-and-other-profiles.md) | developers | LFCP-02-004 evidence: how 0.3.x meets a collaboration of another profile, what 0.3.2 changes, minimum version and downgrade |
| [devel/reports/marker-hiding-spike.md](devel/reports/marker-hiding-spike.md) | developers | LFCP-02-048 spike: hiding binding lines in Live Preview (state field, block decorations), Reading view, cost at W200, the recommendation |
| [devel/reports/host-and-platform-baseline.md](devel/reports/host-and-platform-baseline.md) | developers | LFCP-02-005 evidence: environments, host facts, baselines, the platform matrix (V4) and a proposal for the native harness in CI |
| [devel/reports/native-ux-status-acceptance.md](devel/reports/native-ux-status-acceptance.md) | developers | LFCP-02-066 evidence: native acceptance of shared sections UX and statuses (UX01–UX18, SI01–SI20), the defects found and fixed, the two-vault checklist filled from an automated run |
| [devel/reports/sections-fixtures-and-privacy.md](devel/reports/sections-fixtures-and-privacy.md) | developers | LFCP-02-047 evidence: the Markdown fixture corpus through the product adapter (48/48, also by the spec's verifier), what it changed, the shared plaintext checks |
| [devel/release.md](devel/release.md) | release | Releasing the plugin: the bare version tag, the release workflow, the owner's tag and BRAT steps (POST-011) |
| [devel/community-submission.md](devel/community-submission.md) | release | Draft community directory submission: the community-plugins.json entry, the PR text, the owner's checklist (POST-011) |
| [releases/0.4.0-beta.1.md](releases/0.4.0-beta.1.md) | everyone | Draft release notes of Shared Tasks 0.4.0-beta.1, the first beta with shared sections: BRAT install, no way back to 0.3.x, what to report |
| [releases/0.4.0.md](releases/0.4.0.md) | everyone | Release notes of Shared Tasks 0.4.0 (draft): shared sections, status marks, conflicts, removing access, detach, diagnostics, limits, updating from 0.3 (the GitHub release body) |
| [releases/0.4-compatibility.md](releases/0.4-compatibility.md) | everyone | Shared Tasks 0.4: upgrade and downgrade, the compatibility matrix and the release-notes text |
| [releases/0.3.4.md](releases/0.3.4.md) | everyone | Release notes of Shared Tasks 0.3.4: the security fix for a change a collaborator could send that stopped a collaboration on the devices that received it (the GitHub release body) |
| [releases/0.3.3.md](releases/0.3.3.md) | everyone | Release notes of Shared Tasks 0.3.3: the security fix for changes a collaborator could send that made a collaboration fail to open, and recovery without reinstalling (the GitHub release body) |
| [releases/0.3.2.md](releases/0.3.2.md) | everyone | Release notes of Shared Tasks 0.3.2: Obsidian 1.13.4, joining newer collaborations safely, the revert fix, a server that repairs itself (the GitHub release body) |
| [releases/0.3.1.md](releases/0.3.1.md) | everyone | Release notes of Shared Tasks 0.3.1: smaller main.js, declarative settings, three attested release files, the SDK from npm (the GitHub release body) |
| [releases/0.3.0.md](releases/0.3.0.md) | everyone | Release notes of Shared Tasks 0.3.0: share selected tasks, insert all tasks from a collaboration, created_at (the GitHub release body) |
| [releases/0.2.1.md](releases/0.2.1.md) | everyone | Release notes of Shared Tasks 0.2.1: the refused-collaboration notice, offline hosting, review clean-ups (the GitHub release body) |
| [releases/0.2.0.md](releases/0.2.0.md) | everyone | Release notes of Shared Tasks 0.2.0: the rename, the default server, install, upgrading from 0.1.0 (the GitHub release body) |
| [../src/core/refs/README.md](../src/core/refs/README.md) | developers | The `lfcp-ref` parser: output contract, MR-A1 to MR-A4 readings, adapter choices |

The Markdown ref grammar is normative and lives in
`spec: integration/MARKDOWN-REFS-01.md`.
