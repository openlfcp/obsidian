import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  isRefPlacement,
  normalizeSettings,
  PROJECT_SERVER,
  SETTINGS_VERSION,
} from "../../src/core/settings";

describe("settings", () => {
  it("default to child-line refs (OBSIDIAN-ARCHITECTURE-01 §12)", () => {
    expect(DEFAULT_SETTINGS.refPlacement).toBe("child-line");
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("garbage")).toEqual(DEFAULT_SETTINGS);
  });

  it("keep valid stored values and drop invalid or unknown ones", () => {
    expect(
      normalizeSettings({ refPlacement: "inline", defaultServer: "wss://a.example/ws" }),
    ).toEqual({
      refPlacement: "inline",
      defaultServer: "wss://a.example/ws",
      showSharingMetadata: false,
      sectionComments: "local",
      sectionsDisabled: false,
      developerPanePrototype: false,
      dismissedHints: [],
      settingsVersion: SETTINGS_VERSION,
    });
    expect(
      normalizeSettings({ refPlacement: "sideways", defaultServer: 42, future: true }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it("0.4.0: sections on unless disabled; the 0.3.x sectionsPreview key, saved false by most installs, is dropped", () => {
    for (const sectionsPreview of [false, true, "yes"]) {
      const s = normalizeSettings({ sectionsPreview });
      expect(s).not.toHaveProperty("sectionsPreview");
      expect(s.sectionsDisabled).toBe(false);
    }
    expect(normalizeSettings({ sectionsDisabled: true }).sectionsDisabled).toBe(true);
    expect(normalizeSettings({ sectionsDisabled: "yes" }).sectionsDisabled).toBe(false);
  });

  it("keep the developer pane prototype off unless data.json turns it on (LFCP-03-007)", () => {
    expect(DEFAULT_SETTINGS.developerPanePrototype).toBe(false);
    expect(normalizeSettings({}).developerPanePrototype).toBe(false);
    expect(normalizeSettings({ developerPanePrototype: "yes" }).developerPanePrototype).toBe(false);
    expect(normalizeSettings({ developerPanePrototype: true }).developerPanePrototype).toBe(true);
  });

  it("offer the project server on a fresh install", () => {
    expect(PROJECT_SERVER).toBe("wss://sync.openlfcp.org/v1/ws");
    expect(DEFAULT_SETTINGS.defaultServer).toBe(PROJECT_SERVER);
    expect(normalizeSettings(undefined).defaultServer).toBe(PROJECT_SERVER);
    expect(normalizeSettings({}).settingsVersion).toBe(2);
  });

  it("migrate an old empty server to the project server and keep a saved one", () => {
    // Before version 2 the default was empty: empty or absent was that default.
    expect(normalizeSettings({ refPlacement: "inline", defaultServer: "" })).toEqual({
      refPlacement: "inline",
      defaultServer: PROJECT_SERVER,
      showSharingMetadata: false,
      sectionComments: "local",
      sectionsDisabled: false,
      developerPanePrototype: false,
      dismissedHints: [],
      settingsVersion: 2,
    });
    expect(normalizeSettings({ refPlacement: "inline" }).defaultServer).toBe(PROJECT_SERVER);
    expect(normalizeSettings({ defaultServer: "wss://own.example/v1/ws" }).defaultServer).toBe(
      "wss://own.example/v1/ws",
    );
  });

  it("keep a server the user cleared or set from version 2 on", () => {
    expect(normalizeSettings({ defaultServer: "", settingsVersion: 2 }).defaultServer).toBe("");
    expect(
      normalizeSettings({ defaultServer: "wss://own.example/v1/ws", settingsVersion: 2 })
        .defaultServer,
    ).toBe("wss://own.example/v1/ws");
    // A cleared value survives a save and a reload.
    const saved = JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, defaultServer: "" }));
    expect(normalizeSettings(saved).defaultServer).toBe("");
    // A wrong type is not a choice.
    expect(normalizeSettings({ defaultServer: 7, settingsVersion: 2 }).defaultServer).toBe(
      PROJECT_SERVER,
    );
  });

  it("upgrade a 0.4 data.json with no hidden tips, every other value as it was (LFCP-03-021)", () => {
    // What 0.4.0 saves: version 2, no dismissedHints.
    const stored = {
      refPlacement: "inline",
      defaultServer: "",
      showSharingMetadata: true,
      sectionComments: "shared",
      sectionsDisabled: false,
      developerPanePrototype: false,
      settingsVersion: 2,
    };
    const s = normalizeSettings(stored);
    expect(s).toEqual({ ...stored, dismissedHints: [] });
    // A save and a reload keep it; nothing else is added or dropped.
    expect(normalizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(DEFAULT_SETTINGS.dismissedHints).toEqual([]);
  });

  it("keep hidden tip IDs, of this version or another, once each; drop anything else", () => {
    expect(
      normalizeSettings({ dismissedHints: ["first-use", "a-tip-of-0-6", "first-use"] })
        .dismissedHints,
    ).toEqual(["first-use", "a-tip-of-0-6"]);
    for (const bad of ["first-use", 3, null, { a: 1 }])
      expect(normalizeSettings({ dismissedHints: bad }).dismissedHints).toEqual([]);
    expect(
      normalizeSettings({ dismissedHints: [7, "", "Not An Id", "x".repeat(49), "invite-link"] })
        .dismissedHints,
    ).toEqual(["invite-link"]);
    const many = Array.from({ length: 100 }, (_, i) => `tip-${i}`);
    expect(normalizeSettings({ dismissedHints: many }).dismissedHints).toHaveLength(64);
    // Hiding tips touches no other setting.
    const hidden = normalizeSettings({ ...DEFAULT_SETTINGS, dismissedHints: ["first-use"] });
    expect({ ...hidden, dismissedHints: [] }).toEqual(DEFAULT_SETTINGS);
  });

  it("recognize exactly the two placements", () => {
    expect(isRefPlacement("child-line")).toBe(true);
    expect(isRefPlacement("inline")).toBe(true);
    expect(isRefPlacement("Inline")).toBe(false);
    expect(isRefPlacement(undefined)).toBe(false);
  });

  it("keep a valid section comments choice and default an invalid one to local", () => {
    expect(normalizeSettings({ sectionComments: "shared" }).sectionComments).toBe("shared");
    expect(normalizeSettings({ sectionComments: "everyone" }).sectionComments).toBe("local");
    expect(normalizeSettings({}).sectionComments).toBe("local");
  });
});
