// Plugin settings (OBSIDIAN-ARCHITECTURE-01 §51), independent of Obsidian.
// LFCP-058 defines placeholders only; nothing reads them yet except the
// settings tab.

/**
 * Where a new ref is written (MARKDOWN-REFS-01): on the line after the Task
 * (the Obsidian default, safe with suffix-sensitive task plugins) or at the
 * end of the Task line.
 */
export type RefPlacement = "child-line" | "inline";

export interface Settings {
  /** Placement of refs the plugin writes. Existing refs keep theirs. */
  refPlacement: RefPlacement;
  /** The sync server offered by default when creating a collaboration. */
  defaultServer: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  refPlacement: "child-line",
  defaultServer: "",
};

const PLACEMENTS: readonly RefPlacement[] = ["child-line", "inline"];

export function isRefPlacement(value: unknown): value is RefPlacement {
  return PLACEMENTS.includes(value as RefPlacement);
}

/**
 * Settings from stored data: known fields of the right type are kept,
 * anything else falls back to its default. Stored data may come from an
 * older or newer plugin version, or be hand-edited.
 */
export function normalizeSettings(stored: unknown): Settings {
  const data =
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  return {
    refPlacement: isRefPlacement(data.refPlacement)
      ? data.refPlacement
      : DEFAULT_SETTINGS.refPlacement,
    defaultServer:
      typeof data.defaultServer === "string" ? data.defaultServer : DEFAULT_SETTINGS.defaultServer,
  };
}
