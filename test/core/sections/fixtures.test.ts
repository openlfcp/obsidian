// LFCP-02-047: MARKDOWN-SECTIONS-FIXTURES-01 (spec at spec.lock) through the
// product adapter (test/support/sections-fixtures.ts), compared as the
// spec's verify-markdown.mjs compares: after_files, diagnostics, intents and
// publication, each exactly.

import { describe, expect, it } from "vitest";
import { type FixtureInput, runFixture } from "../../support/sections-fixtures";
import { readSpecJson } from "../../support/spec";

interface Fixture extends FixtureInput {
  readonly expected: {
    readonly after_files: Record<string, string>;
    readonly diagnostics: string[];
    readonly intents: Record<string, unknown>[];
    readonly publication: string;
    readonly private_canaries?: string[];
    readonly payload_contains?: string[];
    readonly payload_excludes?: string[];
    readonly clipboard?: { readonly plain_text?: string };
    readonly command_refused?: boolean;
    readonly physical_shared_deletion?: boolean;
    readonly task_title?: string;
    readonly shared_task_fields_exclude?: string[];
  };
}

/** The fixtures' names of Tasks-local fields, as the Shared Objects Task would name them. */
const TASK_FIELD: Readonly<Record<string, string>> = {
  "priority-sign": "priority",
  created: "created_at",
  start: "start",
  recurrence: "recurrence",
};

const suite = readSpecJson(
  "test-vectors/shared-sections-01/MARKDOWN-SECTIONS-FIXTURES-01.json",
) as {
  identifiers: FixtureInput["identifiers"];
  fixtures: Fixture[];
};

describe("MARKDOWN-SECTIONS-FIXTURES-01 through the product adapter", () => {
  for (const f of suite.fixtures)
    it(`${f.id} (${f.event.kind})`, async () => {
      const r = await runFixture({
        id: f.id,
        identifiers: suite.identifiers,
        before_files: f.before_files,
        event: f.event,
        projection_base: f.projection_base,
      });
      expect(r.after_files, "after_files").toEqual(f.expected.after_files);
      expect(r.diagnostics, "diagnostics").toEqual(f.expected.diagnostics);
      expect(r.intents, "intents").toEqual(f.expected.intents);
      expect(r.publication, "publication").toBe(f.expected.publication);
    });
});

describe("the shared plaintext before encryption (LFCP-02-047 AC3)", () => {
  for (const f of suite.fixtures)
    it(`${f.id}: canaries, payload, clipboard and commands`, async () => {
      const r = await runFixture({
        id: f.id,
        identifiers: suite.identifiers,
        before_files: f.before_files,
        event: f.event,
        projection_base: f.projection_base,
      });
      for (const c of f.expected.private_canaries ?? []) expect(r.payload, c).not.toContain(c);
      for (const c of f.expected.payload_excludes ?? []) expect(r.payload, c).not.toContain(c);
      for (const c of f.expected.payload_contains ?? []) expect(r.payload, c).toContain(c);
      if (f.expected.clipboard?.plain_text !== undefined)
        expect(r.clipboard?.plain_text).toBe(f.expected.clipboard.plain_text);
      if (f.expected.command_refused !== undefined)
        expect(r.commandRefused).toBe(f.expected.command_refused);
      if (f.expected.physical_shared_deletion === false)
        expect(r.payload.split("\n")).not.toContain("node.delete");
      if (f.expected.task_title !== undefined)
        expect(Object.values(r.tasks).map((t) => t.title)).toContain(f.expected.task_title);
      for (const field of f.expected.shared_task_fields_exclude ?? [])
        for (const t of Object.values(r.tasks)) {
          const name = TASK_FIELD[field] ?? field;
          if (field === "priority-sign") expect(t[name], field).toBe("normal");
          else expect(t[name], field).toBeUndefined();
        }
    });
});
