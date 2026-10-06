# Documentation navigator

| Document | For | What it covers |
| --- | --- | --- |
| [OBSIDIAN-ARCHITECTURE-01.md](OBSIDIAN-ARCHITECTURE-01.md) | everyone | Architecture of the Obsidian adapter |
| [architecture/local-state.md](architecture/local-state.md) | developers | Where LFCP state, secrets and the install marker live, eviction, the Automerge wasm choice (LFCP-059) |
| [architecture/projection.md](architecture/projection.md) | developers | Markdown → Shared Object projection: glyphs, owned fields, conflicts, re-association, echo guard (LFCP-061) |
| [architecture/collaboration.md](architecture/collaboration.md) | developers | The collaboration commands: SDK flows, invite presets, secrets, exact-byte detach, offline and blocked states (LFCP-065) |
| [demos/two-vault-demo.md](demos/two-vault-demo.md) | everyone | The canonical two-vault demo in real Obsidian, step by step with expected results (LFCP-072) |
| [assets/shared-tasks-demo.gif](assets/shared-tasks-demo.gif) | everyone | The demo animation shown in the README: a task ticked in one vault updates in the other (synthetic notes) |
| [guides/choosing-a-server.md](guides/choosing-a-server.md) | everyone | Choosing a sync server: the project server wss://sync.openlfcp.org as the default, why the choice is permanent, running your own |
| [devel/testing/two-vault-e2e.md](devel/testing/two-vault-e2e.md) | developers | The two-vault E2E against the real server: running it, what it proves, the harness (LFCP-066) |
| [devel/testing/security-vertical-slice.md](devel/testing/security-vertical-slice.md) | release | The MVP 0.1 security/privacy release gate (LFCP-071): every security boundary in one live scenario |
| [devel/testing/load-in-clean-vault.md](devel/testing/load-in-clean-vault.md) | developers | Manual check: load the built plugin in a clean vault |
| [devel/testing/platform-smoke.md](devel/testing/platform-smoke.md) | release | Desktop platform smoke (LFCP-068): the CI matrix and the manual checklist per OS |
| [devel/testing/platform-smoke-runs.md](devel/testing/platform-smoke-runs.md) | release | Records of platform smoke runs per OS, with the current status by platform (LFCP-068) |
| [devel/release.md](devel/release.md) | release | Releasing the plugin: the bare version tag, the release workflow, the owner's tag and BRAT steps (POST-011) |
| [devel/community-submission.md](devel/community-submission.md) | release | Draft community directory submission: the community-plugins.json entry, the PR text, the owner's checklist (POST-011) |
| [releases/0.2.0.md](releases/0.2.0.md) | everyone | Release notes of Shared Tasks 0.2.0: the rename, the default server, install, upgrading from 0.1.0 (the GitHub release body) |
| [../src/core/refs/README.md](../src/core/refs/README.md) | developers | The `lfcp-ref` parser: output contract, MR-A1 to MR-A4 readings, adapter choices |

The Markdown ref grammar is normative and lives in
`spec: integration/MARKDOWN-REFS-01.md`.
