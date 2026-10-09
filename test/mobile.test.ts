// LFCP-02-095 (V3): the plugin stays in the catalog for mobile
// (isDesktopOnly false), and the shared sections path uses no desktop-only
// API (Node built-ins, Electron, process, Buffer), so it loads on Obsidian
// mobile, where sections are read-only (runtime-sections.test.ts). A static
// check of the sources; the manual device steps are in
// docs/devel/testing/mobile-sections-checklist.md.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const SECTION_PATH = [
  "src/core/sections",
  "src/core/status",
  "src/core/lfcp",
  "src/core/diagnostics.ts",
  "src/core/diagnostics-collect.ts",
  "src/obsidian/sections-host.ts",
  "src/obsidian/section-editor.ts",
  "src/obsidian/section-status.ts",
  "src/obsidian/section-clipboard.ts",
  "src/obsidian/live-region.ts",
  "src/obsidian/lfcp-env.ts",
  "src/obsidian/ui",
];
const DESKTOP_ONLY =
  /require\(|from "(?:node:|fs|path|os|electron|child_process)|\bprocess\.|\bBuffer\.|__dirname/;

function files(path: string): string[] {
  const full = join(root, path);
  if (statSync(full).isFile()) return [path];
  return readdirSync(full).flatMap((f) => files(join(path, f)));
}

describe("mobile (LFCP-02-095)", () => {
  it("stays available on mobile: isDesktopOnly is false", () => {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it("the shared sections path uses no desktop-only API", () => {
    const sources = SECTION_PATH.flatMap(files).filter((f) => f.endsWith(".ts"));
    expect(sources.length).toBeGreaterThan(30);
    const found = sources.flatMap((f) =>
      readFileSync(join(root, f), "utf8")
        .split("\n")
        .flatMap((line, i) => (DESKTOP_ONLY.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
