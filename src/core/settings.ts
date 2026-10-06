// Plugin settings (OBSIDIAN-ARCHITECTURE-01 §51), independent of Obsidian.
// LFCP-058 defines placeholders only; nothing reads them yet except the
// settings tab.

/**
 * Where a new ref is written (MARKDOWN-REFS-01): on the line after the Task
 * (the Obsidian default, safe with suffix-sensitive task plugins) or at the
 * end of the Task line.
 */
export type RefPlacement = "child-line" | "inline";

/**
 * The public server the OpenLFCP project runs (beta), offered by default
 * when creating a collaboration. Owner decision, 2026-10-06.
 */
export const PROJECT_SERVER = "wss://sync.openlfcp.org/v1/ws";

/**
 * The version of the stored settings. 2: an empty `defaultServer` is the
 * user's choice (no server offered). Before it (no version stored) the
 * default was empty, so an empty or absent value there was only that
 * default and becomes {@link PROJECT_SERVER}.
 */
export const SETTINGS_VERSION = 2;

export interface Settings {
  /** Placement of refs the plugin writes. Existing refs keep theirs. */
  refPlacement: RefPlacement;
  /** The sync server offered by default when creating a collaboration; empty offers none. */
  defaultServer: string;
  /** {@link SETTINGS_VERSION}, stored so a later empty `defaultServer` stays empty. */
  settingsVersion: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  refPlacement: "child-line",
  defaultServer: PROJECT_SERVER,
  settingsVersion: SETTINGS_VERSION,
};

const PLACEMENTS: readonly RefPlacement[] = ["child-line", "inline"];

export function isRefPlacement(value: unknown): value is RefPlacement {
  return PLACEMENTS.includes(value as RefPlacement);
}

/**
 * Settings from stored data: known fields of the right type are kept,
 * anything else falls back to its default. Stored data may come from an
 * older or newer plugin version, or be hand-edited.
 *
 * `defaultServer` from before {@link SETTINGS_VERSION} 2: a saved server
 * is kept, and an empty or absent one (the old default) becomes
 * {@link PROJECT_SERVER}. From version 2 on, an empty one is kept: the
 * user cleared it.
 */
export function normalizeSettings(stored: unknown): Settings {
  const data =
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const versioned = typeof data.settingsVersion === "number" && data.settingsVersion >= 2;
  const server = typeof data.defaultServer === "string" ? data.defaultServer : undefined;
  return {
    refPlacement: isRefPlacement(data.refPlacement)
      ? data.refPlacement
      : DEFAULT_SETTINGS.refPlacement,
    defaultServer:
      server === undefined || (server === "" && !versioned)
        ? DEFAULT_SETTINGS.defaultServer
        : server,
    settingsVersion: SETTINGS_VERSION,
  };
}
