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
