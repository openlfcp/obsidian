import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isRefPlacement, normalizeSettings } from "../../src/core/settings";

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
    });
    expect(
      normalizeSettings({ refPlacement: "sideways", defaultServer: 42, future: true }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it("recognize exactly the two placements", () => {
    expect(isRefPlacement("child-line")).toBe(true);
    expect(isRefPlacement("inline")).toBe(true);
    expect(isRefPlacement("Inline")).toBe(false);
    expect(isRefPlacement(undefined)).toBe(false);
  });
});
