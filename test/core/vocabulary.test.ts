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
  // LFCP-03-042: the palette's join, invitation and status flows, the import
  // preview of 0.1 shared Tasks, the plain texts of the server's codes and the
  // Resource status view.
  "src/core/collab/commands.ts",
  "src/obsidian/ui/import-section.ts",
  "src/core/collab/messages.ts",
  "src/core/collab/view.ts",
  // The runtime's refusal texts (NEEDS_NEWER_VERSION reaches a section's join and status).
  "src/core/lfcp/runtime.ts",
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
  // A 0.1 collaboration joined without a name; a section falls back to its shared title (N5).
  { file: "src/core/collab/service.ts", text: /^"Shared collaboration"$/ },
  // LFCP-03-042. The palette flows of 0.1 Resources keep the 0.1 words: "Create
  // collaboration" and its name, server and progress; a 0.1 Resource joined without a
  // name, or already held; the 0.1 Task inserts.
  { file: "src/core/collab/commands.ts", text: /^"\(unnamed collaboration\)"$/ },
  { file: "src/core/collab/commands.ts", text: /^"Create a new collaboration…"$/ },
  { file: "src/core/collab/commands.ts", text: /^"Create collaboration"$/ },
  {
    file: "src/core/collab/commands.ts",
    text: /^"A name for this collaboration on this device\. Only you see it\."$/,
  },
  { file: "src/core/collab/commands.ts", text: /^"The server that relays this collaboration\./ },
  { file: "src/core/collab/commands.ts", text: /^"Creating the collaboration"$/ },
  {
    file: "src/core/collab/commands.ts",
    text: /^`Shared Tasks: joined "\$\{name\.trim\(\) \|\| "Shared/,
  },
  {
    file: "src/core/collab/commands.ts",
    text: /^"Shared Tasks: this device is already in that collaboration\."$/,
  },
  {
    file: "src/core/collab/commands.ts",
    text: /use "Insert all tasks from collaboration" to place/,
  },
  {
    file: "src/core/collab/commands.ts",
    text: /^"Shared Tasks: (?:this collaboration has no shared tasks yet|every task of this collaboration is already in this note)\."$/,
  },
  // The palette command's name, unchanged (§2, §3): how to find the join in the palette.
  {
    file: "src/core/collab/commands.ts",
    text: /^'Shared Tasks: nothing is shared on this device yet\. .*\("Join collaboration"\), first\.'$/,
  },
  // The import of 0.1 shared Tasks into a new section: their sources are 0.1
  // collaborations, as the contract's `legacy-tasks` text says (§4.2).
  {
    file: "src/obsidian/ui/import-section.ts",
    text: /from a collaboration this device does not hold/,
  },
  { file: "src/obsidian/ui/import-section.ts", text: /was deleted in its collaboration\.`$/ },
  {
    file: "src/obsidian/ui/import-section.ts",
    text: /The existing collaborations are not changed/,
  },
  { file: "src/obsidian/ui/import-section.ts", text: /^"Some source collaborations have local/ },
  // Resource status: a 0.1 Resource's noun and its unnamed title; a section's are
  // "section" and "Shared section". Its technical rows name the protocol's terms (§2).
  { file: "src/core/collab/view.ts", text: /^"(?:a )?collaboration"$/ },
  { file: "src/core/collab/view.ts", text: /^"Collaboration"$/ },
  { file: "src/core/collab/view.ts", text: /^"(?:Resource ID|Control Head|Data Epoch)"$/ },
  // The runtime's storage and SDK identifiers, and its internal error reasons for a
  // Resource it cannot open (protocol words, not surface wording; LFCP-03-042 report).
  { file: "src/core/lfcp/runtime.ts", text: /^"(?:put-epoch|epoch-reconciled)"$/ },
  {
    file: "src/core/lfcp/runtime.ts",
    text: /^"(?:unknown Resource|no known route for this Resource|this Resource's Control Chain is not usable|no key for this Resource's current Data Epoch yet|the Resource was not stored)"$/,
  },
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
