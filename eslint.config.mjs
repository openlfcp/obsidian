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
    rules: {
      // "Shared Tasks" and "OpenLFCP" are proper nouns the rule cannot know.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
];
