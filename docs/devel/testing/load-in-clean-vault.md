# Manual check: load the plugin in a clean vault

The unit tests run the adapter against a mock of the `obsidian` API
(`test/mocks/obsidian.ts`). Loading the real plugin in Obsidian is a manual
check, done before each release and whenever the manifest or the adapter
layer changes.

1. Build from a clean checkout:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run build
   ```

   This writes `main.js` next to `manifest.json`.

2. Create an empty vault in Obsidian (version `minAppVersion` from
   `manifest.json` or later), and close Obsidian.

3. Copy the plugin into the vault:

   ```sh
   mkdir -p <vault>/.obsidian/plugins/shared-tasks
   cp main.js manifest.json <vault>/.obsidian/plugins/shared-tasks/
   ```

4. Open the vault, go to **Settings → Community plugins**, turn off
   Restricted mode if asked, and enable **Shared Tasks**.

Expected:

- the plugin enables without an error notice or console error;
- the command palette lists the seven `Shared Tasks:` commands from
  `src/core/commands.ts`, and each shows a "not implemented yet" notice;
- **Settings → Shared Tasks** shows *Ref placement* (Child line by default) and
  *Default server*; a change survives disabling and re-enabling the
  plugin (it is stored in `<vault>/.obsidian/plugins/shared-tasks/data.json`).
