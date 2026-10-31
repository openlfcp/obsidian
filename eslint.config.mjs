// The Obsidian community Scorecard runs eslint-plugin-obsidianmd's
// recommended config over src/. This reproduces it, so `pnpm lint:obsidian`
// fails on what the Scorecard would report. src/ only: test/ and scripts/
// are not scanned.
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true } },
    // An eslint-disable comment would pass this gate and still count on the
    // Scorecard, which runs its own config: inline config is refused.
    linterOptions: { noInlineConfig: true },
    rules: {
      // The brand list replaces the rule's built-in one (which names
      // "Cursor", a word this plugin uses in its ordinary sense): only the
      // proper nouns the UI actually shows. lfcp:// links are not prose.
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          enforceCamelCaseLower: true,
          brands: ["Obsidian", "Shared Tasks", "OpenLFCP"],
          ignoreRegex: ["^lfcp://"],
        },
      ],
    },
  },
];
