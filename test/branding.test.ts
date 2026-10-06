// The plugin is "Shared Tasks" in every user-facing text (POST-011, owner
// decision before 0.2.0); "OpenLFCP" names only the protocol, the project
// and its server. Comments are not user-facing and are skipped.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

/** Code lines naming OpenLFCP on purpose: the project and its server. */
const ALLOWED = ["Hosted by the OpenLFCP project (beta)", "the OpenLFCP project server (beta)"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("branding", () => {
  it("names the plugin Shared Tasks, never OpenLFCP, in its texts", () => {
    const found: string[] = [];
    for (const file of sources(SRC))
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
          if (code.includes("OpenLFCP") && !ALLOWED.some((a) => code.includes(a)))
            found.push(`${file.slice(SRC.length)}:${i + 1}: ${code}`);
        });
    expect(found).toEqual([]);
  });
});
