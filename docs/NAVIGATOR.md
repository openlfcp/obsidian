# Documentation navigator

| Document | For | What it covers |
| --- | --- | --- |
| [OBSIDIAN-ARCHITECTURE-01.md](OBSIDIAN-ARCHITECTURE-01.md) | everyone | Architecture of the Obsidian adapter |
| [architecture/local-state.md](architecture/local-state.md) | developers | Where LFCP state, secrets and the install marker live, eviction, the Automerge wasm choice (LFCP-059) |
| [architecture/projection.md](architecture/projection.md) | developers | Markdown → Shared Object projection: glyphs, owned fields, conflicts, re-association, echo guard (LFCP-061) |
| [architecture/collaboration.md](architecture/collaboration.md) | developers | The collaboration commands: SDK flows, invite presets, secrets, exact-byte detach, offline and blocked states (LFCP-065) |
| [devel/testing/load-in-clean-vault.md](devel/testing/load-in-clean-vault.md) | developers | Manual check: load the built plugin in a clean vault |
| [../src/core/refs/README.md](../src/core/refs/README.md) | developers | The `lfcp-ref` parser: output contract, MR-A1 to MR-A4 readings, adapter choices |

The Markdown ref grammar is normative and lives in
`spec: integration/MARKDOWN-REFS-01.md`.
