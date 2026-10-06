# Documentation navigator

| Document | For | What it covers |
| --- | --- | --- |
| [OBSIDIAN-ARCHITECTURE-01.md](OBSIDIAN-ARCHITECTURE-01.md) | everyone | Architecture of the Obsidian adapter |
| [architecture/local-state.md](architecture/local-state.md) | developers | Where LFCP state, secrets and the install marker live, eviction, the Automerge wasm choice (LFCP-059) |
| [architecture/projection.md](architecture/projection.md) | developers | Markdown → Shared Object projection: glyphs, owned fields, conflicts, re-association, echo guard (LFCP-061) |
| [architecture/collaboration.md](architecture/collaboration.md) | developers | The collaboration commands: SDK flows, invite presets, secrets, exact-byte detach, offline and blocked states (LFCP-065) |
| [demos/two-vault-demo.md](demos/two-vault-demo.md) | everyone | The canonical two-vault demo in real Obsidian, step by step with expected results (LFCP-072) |
| [guides/choosing-a-server.md](guides/choosing-a-server.md) | everyone | Choosing a sync server: the project server wss://sync.openlfcp.org as the default, why the choice is permanent, running your own |
| [devel/testing/two-vault-e2e.md](devel/testing/two-vault-e2e.md) | developers | The two-vault E2E against the real server: running it, what it proves, the harness (LFCP-066) |
| [devel/testing/security-vertical-slice.md](devel/testing/security-vertical-slice.md) | release | The MVP 0.1 security/privacy release gate (LFCP-071): every security boundary in one live scenario |
| [devel/testing/load-in-clean-vault.md](devel/testing/load-in-clean-vault.md) | developers | Manual check: load the built plugin in a clean vault |
| [devel/testing/platform-smoke.md](devel/testing/platform-smoke.md) | release | Desktop platform smoke (LFCP-068): the CI matrix and the manual checklist per OS |
| [devel/testing/platform-smoke-runs.md](devel/testing/platform-smoke-runs.md) | release | Records of platform smoke runs per OS, with the current status by platform (LFCP-068) |
| [../src/core/refs/README.md](../src/core/refs/README.md) | developers | The `lfcp-ref` parser: output contract, MR-A1 to MR-A4 readings, adapter choices |

The Markdown ref grammar is normative and lives in
`spec: integration/MARKDOWN-REFS-01.md`.
