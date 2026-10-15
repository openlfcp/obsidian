// LFCP-03-020 (UX contract §2, §6 F1, F-08, F-10): the words of the section
// surfaces. The pane, the card, the insert and share dialogs and the editor
// cues use the product vocabulary; protocol terms stay in the card's
// collapsed technical details; nothing claims delivery to a peer (the ✓✓
// mark means "shared"). A source scan of their string literals, so a new
// label that drifts is caught before a native run.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const dir = (d: string, prefix = "") =>
  readdirSync(join(ROOT, d))
    .filter((f) => f.endsWith(".ts") && f.startsWith(prefix))
    .map((f) => `${d}/${f}`);

/** The files that draw or word a section surface. */
const SURFACES = [
  ...dir("src/core/pane"),
  ...dir("src/obsidian/ui", "pane-"),
  "src/core/status/card.ts",
  "src/core/status/badge.ts",
  "src/core/actions/catalog.ts",
  "src/core/actions/descriptors.ts",
  "src/core/sections/preview-display.ts",
  "src/core/sections/presentation.ts",
  "src/obsidian/ui/section-card.ts",
  "src/obsidian/ui/insert-section.ts",
  "src/obsidian/ui/share-section.ts",
  // LFCP-03-023: the executor, the dispatcher, the join and invitation flows and the
  // plugin's notices and command names reach the same surfaces.
  "src/core/sections/actions.ts",
  "src/core/actions/dispatcher.ts",
  "src/core/collab/join-flow.ts",
  "src/core/collab/service.ts",
  "src/obsidian/plugin.ts",
];

/** Words a section surface does not use (UX contract §2, §6, §10). */
const FORBIDDEN = [
  /\bResource\b(?! status)/,
  /Control Head/i,
  /Data Epoch/i,
  /\bepoch\b/i,
  /operation ID/i,
  /\bcollaboration/i,
  /\binstance\b/,
  /\bmirror\b/,
  /\bACL\b/,
  /\bpermissions\b/,
  /\bdeliver(?:ed|y)\b/i,
  /\b(?:seen|read|received) by\b/i,
];

/** Allowed exactly here, and why. */
const ALLOWED: readonly { readonly file: string; readonly text: RegExp }[] = [
  // Technical details of the card: collapsed, never in the pane (§2).
  { file: "src/core/status/card.ts", text: /^`Resource: \$\{/ },
  // The 0.1 shared Tasks a range holds: the contract's own `legacy-tasks` words (§4.2).
  {
    file: "src/core/pane/model.ts",
    text: /already shared in another collaboration\. Share section…/,
  },
  // The 0.1 palette command IDs, unchanged (§2, §3).
  { file: "src/core/actions/dispatcher.ts", text: /^"join-collaboration"$/ },
  { file: "src/obsidian/plugin.ts", text: /^"(?:create|join)-collaboration"$/ },
  // An SDK event type, not a word the user reads.
  { file: "src/obsidian/plugin.ts", text: /^"epoch-reconciled"$/ },
  // The plugin running in another window (the writer lock), not a copy of a section.
  {
    file: "src/obsidian/plugin.ts",
    text: /^"another Shared Tasks instance holds this vault's data/,
  },
  // Said only when the Resource joined is a 0.1 collaboration, not a shared section.
  { file: "src/core/collab/join-flow.ts", text: /already in that collaboration\./ },
  // "Create collaboration" (0.1 only): its name and its hosting later.
  { file: "src/core/collab/service.ts", text: /^"Give the collaboration a name\."$/ },
  {
    file: "src/core/collab/service.ts",
    text: /The collaboration works on this device; host it later/,
  },
  // The invitation's noun for a 0.1 Resource; a shared section's is "section".
  { file: "src/core/collab/service.ts", text: /^"collaboration"$/ },
  // A 0.1 collaboration joined without a name, and a join not settled yet (its profile
  // unknown until it is): candidate for a later wording task (LFCP-03-023 report).
  { file: "src/core/collab/service.ts", text: /^"Shared collaboration"$/ },
  // A Resource not found in the registry: its profile is unknown (same candidate).
  { file: "src/core/collab/service.ts", text: /^"This collaboration is not on this device\."$/ },
];

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function literals(file: string): string[] {
  const src = readFileSync(join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return src.match(LITERAL) ?? [];
}

describe("the vocabulary of the section surfaces (LFCP-03-020, LFCP-03-023)", () => {
  it("reads every surface file", () => {
    expect(SURFACES.length).toBeGreaterThan(10);
    for (const f of SURFACES) expect(literals(f).length).toBeGreaterThan(0);
  });

  it("uses no protocol term or delivery claim outside the allowed places", () => {
    const found: string[] = [];
    for (const file of SURFACES)
      for (const text of literals(file))
        if (
          FORBIDDEN.some((w) => w.test(text)) &&
          !ALLOWED.some((a) => a.file === file && a.text.test(text))
        )
          found.push(`${file}: ${text.slice(0, 120)}`);
    expect(found).toEqual([]);
  });
});
