// Obsidian runs the plugin in a browser window, where `window` (and
// Obsidian's `activeWindow`) always exist; the adapter uses them for timers,
// the navigator and the clipboard (popout-window friendly, as Obsidian's
// guidelines ask). The unit tests run in Node: this gives them the same
// globals, pointing at Node's global object.
const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
g.activeWindow ??= globalThis;
