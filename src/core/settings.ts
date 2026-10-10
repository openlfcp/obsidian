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

/**
 * Comments inside a shared section (MARKDOWN-SECTIONS-01 §4.5, spec
 * d5ac669): kept local and never shared (the default), or shared as raw
 * blocks. A comment already bound as a raw block stays shared either way.
 */
export type SectionComments = "local" | "shared";

const SECTION_COMMENTS: readonly SectionComments[] = ["local", "shared"];

export function isSectionComments(value: unknown): value is SectionComments {
  return SECTION_COMMENTS.includes(value as SectionComments);
}

export interface Settings {
  /**
   * Placement of refs the plugin writes, for standalone Tasks and inside
   * shared sections (§4.1, spec e14b3d0). Existing refs keep theirs.
   */
  refPlacement: RefPlacement;
  /** The sync server offered by default when creating a collaboration; empty offers none. */
  defaultServer: string;
  /** Show the binding lines of shared sections in Live Preview (hidden by default, M5). */
  showSharingMetadata: boolean;
  /** New comments in shared sections: local (default) or shared. */
  sectionComments: SectionComments;
  /**
   * Turns shared sections off (data.json only, not in the settings tab).
   * Sections are on in every 0.4 build; a new key, so the `sectionsPreview:
   * false` most 0.3.x installs saved does not turn them off.
   */
  sectionsDisabled: boolean;
  /** {@link SETTINGS_VERSION}, stored so a later empty `defaultServer` stays empty. */
  settingsVersion: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  refPlacement: "child-line",
  defaultServer: PROJECT_SERVER,
  showSharingMetadata: false,
  sectionComments: "local",
  sectionsDisabled: false,
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
    showSharingMetadata:
      typeof data.showSharingMetadata === "boolean"
        ? data.showSharingMetadata
        : DEFAULT_SETTINGS.showSharingMetadata,
    sectionComments: isSectionComments(data.sectionComments)
      ? data.sectionComments
      : DEFAULT_SETTINGS.sectionComments,
    // 0.4.0: the 0.3.x `sectionsPreview` key is dropped; sections are on unless disabled.
    sectionsDisabled: data.sectionsDisabled === true,
    settingsVersion: SETTINGS_VERSION,
  };
}
