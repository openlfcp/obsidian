// The UX fixture states' sections host for the native harness (LFCP-03-025):
// test/support/ux-fixture-host.ts bundled for Obsidian's renderer into
// test/native/fixture-host.bundle.js (scripts/build-native-harness.mjs,
// gitignored). specs/pane-fixture-states.e2e.mjs evaluates it in the app;
// it puts the helpers on `window.__lfcpFixtureHost`. Test only, never shipped.
import { shareCounts, shareWarningText } from "../../../src/core/sections/share";
import { fixtureResource, hostOf, joinedFirst, noteSpec } from "../../support/ux-fixture-host";

(globalThis as unknown as { __lfcpFixtureHost: unknown }).__lfcpFixtureHost = {
  hostOf,
  noteSpec,
  joinedFirst,
  fixtureResource,
  shareCounts,
  shareWarningText,
};
