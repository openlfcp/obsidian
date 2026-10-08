# Documentation navigator

| Document | For | What it covers |
| --- | --- | --- |
| [OBSIDIAN-ARCHITECTURE-01.md](OBSIDIAN-ARCHITECTURE-01.md) | everyone | Architecture of the Obsidian adapter |
| [architecture/local-state.md](architecture/local-state.md) | developers | Where LFCP state, secrets and the install marker live, eviction, the Automerge wasm choice (LFCP-059) |
| [architecture/projection.md](architecture/projection.md) | developers | Markdown → Shared Object projection: glyphs, owned fields, conflicts, re-association, echo guard (LFCP-061) |
| [architecture/collaboration.md](architecture/collaboration.md) | developers | The collaboration commands: SDK flows, invite presets, secrets, exact-byte detach, offline and blocked states (LFCP-065) |
| [architecture/decisions/0001-codemirror-transactions-for-sections.md](architecture/decisions/0001-codemirror-transactions-for-sections.md) | developers | ADR 0001 (proposed, MVP 0.2): CodeMirror transactions for shared sections in open notes, the file path for the rest; spikes S1–S6 |
| [demos/two-vault-demo.md](demos/two-vault-demo.md) | everyone | The canonical two-vault demo in real Obsidian, step by step with expected results (LFCP-072) |
| [assets/shared-tasks-demo.gif](assets/shared-tasks-demo.gif) | everyone | The demo animation shown in the README: a task ticked in one vault updates in the other (synthetic notes) |
| [guides/user-guide.md](guides/user-guide.md) | everyone | Step-by-step user guide: install, create, share, invite, join, many tasks at once, offline, conflicts, troubleshooting |
| [guides/choosing-a-server.md](guides/choosing-a-server.md) | everyone | Choosing a sync server: the project server wss://sync.openlfcp.org as the default, why the choice is permanent, running your own |
| [devel/testing/two-vault-e2e.md](devel/testing/two-vault-e2e.md) | developers | The two-vault E2E against the real server: running it, what it proves, the harness (LFCP-066) |
| [devel/testing/security-vertical-slice.md](devel/testing/security-vertical-slice.md) | release | The MVP 0.1 security/privacy release gate (LFCP-071): every security boundary in one live scenario |
| [devel/testing/load-in-clean-vault.md](devel/testing/load-in-clean-vault.md) | developers | Manual check: load the built plugin in a clean vault |
| [devel/testing/ime-checklist.md](devel/testing/ime-checklist.md) | release | Manual IME check in a shared note before the first 0.4 beta (the condition of ADR 0001) |
| [devel/testing/native-harness.md](devel/testing/native-harness.md) | developers | The native harness (LFCP-02-096): the built plugin in a real, sandboxed Obsidian from the CLI; safety rules, cache, pinned versions |
| [devel/testing/obsidian-host-facts.md](devel/testing/obsidian-host-facts.md) | developers | Obsidian host facts MVP 0.2 depends on (LFCP-02-005 evidence): minAppVersion was a beta, tabs by default, comments visible in Live Preview |
| [devel/testing/platform-smoke.md](devel/testing/platform-smoke.md) | release | Desktop platform smoke (LFCP-068): the CI matrix and the manual checklist per OS |
| [devel/testing/platform-smoke-runs.md](devel/testing/platform-smoke-runs.md) | release | Records of platform smoke runs per OS, with the current status by platform (LFCP-068) |
| [devel/release.md](devel/release.md) | release | Releasing the plugin: the bare version tag, the release workflow, the owner's tag and BRAT steps (POST-011) |
| [devel/community-submission.md](devel/community-submission.md) | release | Draft community directory submission: the community-plugins.json entry, the PR text, the owner's checklist (POST-011) |
| [releases/0.3.2.md](releases/0.3.2.md) | everyone | Release notes of Shared Tasks 0.3.2 (draft): the fix for a collaborator's change undone right after sharing (the GitHub release body) |
| [releases/0.3.1.md](releases/0.3.1.md) | everyone | Release notes of Shared Tasks 0.3.1: smaller main.js, declarative settings, three attested release files, the SDK from npm (the GitHub release body) |
| [releases/0.3.0.md](releases/0.3.0.md) | everyone | Release notes of Shared Tasks 0.3.0: share selected tasks, insert all tasks from a collaboration, created_at (the GitHub release body) |
| [releases/0.2.1.md](releases/0.2.1.md) | everyone | Release notes of Shared Tasks 0.2.1: the refused-collaboration notice, offline hosting, review clean-ups (the GitHub release body) |
| [releases/0.2.0.md](releases/0.2.0.md) | everyone | Release notes of Shared Tasks 0.2.0: the rename, the default server, install, upgrading from 0.1.0 (the GitHub release body) |
| [../src/core/refs/README.md](../src/core/refs/README.md) | developers | The `lfcp-ref` parser: output contract, MR-A1 to MR-A4 readings, adapter choices |

The Markdown ref grammar is normative and lives in
`spec: integration/MARKDOWN-REFS-01.md`.
