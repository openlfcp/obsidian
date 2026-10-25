// LFCP-03-020 (UX contract §2, §6 F1, F-08, F-10): the words of the section
// surfaces. The pane, the card, the insert and share dialogs and the editor
// cues use the product vocabulary; protocol terms stay in the card's
// collapsed technical details; nothing claims delivery to a peer (the ✓✓
// mark means "shared"). A source scan of their string literals, so a new
// label that drifts is caught before a native run. Every file of src/ is
// scanned (LFCP-03-046): a text another file words and a surface imports
// is caught too; what may keep a word is allowed file by file, with why.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const dir = (d: string, prefix = "") =>
  readdirSync(join(ROOT, d))
    .filter((f) => f.endsWith(".ts") && f.startsWith(prefix))
    .map((f) => `${d}/${f}`);

/** Every TypeScript file under `d`, recursively. */
const tree = (d: string): string[] =>
  readdirSync(join(ROOT, d))
    .sort()
    .flatMap((f) => {
      const p = `${d}/${f}`;
      if (statSync(join(ROOT, p)).isDirectory()) return tree(p);
      return p.endsWith(".ts") ? [p] : [];
    });

/** The files that draw or word a section surface (each must hold texts). */
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

/** Every source file: the surfaces and whatever words a text they show. */
const SCANNED = tree("src");

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
  // UX-03, UX-04: a 0.1 link or Resource met where a shared section was asked for says what it is.
  { file: "src/core/collab/messages.ts", text: /an older task collaboration/ },
  { file: "src/core/pane/model.ts", text: /an older task collaboration, which is not a section/ },
  {
    file: "src/core/sections/insert.ts",
    text: /an older task collaboration, which is not a section/,
  },
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
  // UX-02: the legacy invite picker names the 0.1 kind of what it lists, and says where a section is invited to.
  {
    file: "src/core/collab/commands.ts",
    text: /^`\$\{e\.profile === SECTIONS_PROFILE_ID \? "Section" : "Task collaboration"\}/,
  },
  { file: "src/core/collab/commands.ts", text: /there is no task collaboration on this device/ },
  { file: "src/core/collab/commands.ts", text: /^"Invite to a task collaboration…"$/ },
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
  // LFCP-03-046: the rest of src/.
  // The 0.1 palette commands' IDs and names, unchanged (§2, §3).
  { file: "src/core/commands.ts", text: /^"(?:create|join)-collaboration"$/ },
  {
    file: "src/core/commands.ts",
    text: /^"Legacy: (?:Create task collaboration|Join task collaboration|Insert all tasks from task collaboration|Invite to task collaboration)"$/,
  },
  // The diagnostics report: a support text that names the protocol's terms (§2).
  { file: "src/core/diagnostics.ts", text: /^`Collaborations: \$\{/ },
  { file: "src/core/diagnostics.ts", text: /· data epoch \$\{/ },
  // The plugin running in another window (the writer lock), as in plugin.ts.
  {
    file: "src/core/lfcp/install.ts",
    text: /^"Another Shared Tasks instance holds this vault's data\."$/,
  },
  // A 0.1 Task ref whose Resource this device does not hold: a diagnostic, never announced.
  {
    file: "src/core/projection/engine.ts",
    text: /^"This Resource is not known on this device; nothing is sent\."$/,
  },
  // A 0.1 Task's withdrawn change (a 0.1 notice; candidate for plain words, LFCP-03-046 report).
  {
    file: "src/core/projection/render.ts",
    text: /^`An earlier change was withdrawn \(a Key Epoch cutoff\)/,
  },
  // A malformed ref's parse error (diagnostics), not a surface text.
  { file: "src/core/refs/object-ref.ts", text: /^"a Resource ID has 32 bytes"$/ },
  // The 0.1 shared Tasks a range holds: the contract's own `legacy-tasks` words (§4.2).
  {
    file: "src/core/sections/share.ts",
    text: /already shared in another collaboration\. Import creates new shared tasks; existing collaborations continue separately\.`$/,
  },
  {
    file: "src/core/sections/target.ts",
    text: /^"Tasks in the selection are already shared in another collaboration\."$/,
  },
  // An SDK event type, not a word the user reads.
  { file: "src/obsidian/sections-host.ts", text: /^"epoch-reconciled"$/ },
  // The default server's setting: offered by "Create collaboration" (0.1) and by
  // "Share section…"; its 0.1 wording is a candidate for rewording (LFCP-03-046 report).
  {
    file: "src/obsidian/settings-tab.ts",
    text: /^"The sync server offered when you create a collaboration\. It is not your identity and does not own your collaborations\./,
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
  it("reads every surface file, and every file of src/", () => {
    expect(SURFACES.length).toBeGreaterThan(10);
    for (const f of SURFACES) expect(literals(f).length).toBeGreaterThan(0);
    expect(SCANNED.length).toBeGreaterThan(100);
    for (const f of SURFACES) expect(SCANNED).toContain(f);
    expect(SCANNED).toContain("src/core/sections/repair.ts");
  });

  it("uses no protocol term or delivery claim outside the allowed places", () => {
    const found: string[] = [];
    for (const file of SCANNED)
      for (const text of literals(file))
        if (
          FORBIDDEN.some((w) => w.test(text)) &&
          !ALLOWED.some((a) => a.file === file && a.text.test(text))
        )
          found.push(`${file}: ${text.slice(0, 120)}`);
    expect(found).toEqual([]);
  });

  it("allows nothing that is not there: each allowance still matches a text", () => {
    const stale = ALLOWED.filter(
      (a) => !literals(a.file).some((t) => a.text.test(t) && FORBIDDEN.some((w) => w.test(t))),
    ).map((a) => `${a.file}: ${a.text}`);
    expect(stale).toEqual([]);
  });
});
