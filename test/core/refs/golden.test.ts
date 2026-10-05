// Golden fixtures: test/fixtures/refs/<name>.md → <name>.json, the expected
// scan (MARKDOWN-REFS-01 at the spec.lock pin). mr-* fixtures are the `md`
// examples of MARKDOWN-REFS-01 itself, checked against the spec below.
//
// UPDATE_GOLDEN=1 pnpm test rewrites the JSON files; review every change.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  emitUnit,
  replaceTaskText,
  type ScanResult,
  scanRefs,
  toBase64Url,
} from "../../../src/core/refs";
import { openSpec } from "../../support/spec";

const DIR = new URL("../../fixtures/refs/", import.meta.url);
const names = readdirSync(DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.slice(0, -3))
  .sort();
const read = (name: string) => readFileSync(new URL(`${name}.md`, DIR), "utf8");

/** The scan as stable JSON: Resource IDs as base64url, ranges per line. */
function toJson(scan: ScanResult) {
  return {
    projections: scan.projections.map((p) => ({
      resource: toBase64Url(p.resourceId),
      objectType: p.objectType,
      objectId: p.objectId,
      placement: p.placement,
      taskLine: p.taskLine,
      refLine: p.refLine,
      rawRef: p.rawRef,
      canonical: p.canonical,
      taskText: p.taskText,
      comment: { line: p.comment.line, start: p.comment.start, end: p.comment.end },
    })),
    diagnostics: scan.diagnostics.map((d) => ({
      code: d.code,
      line: d.line,
      start: d.start,
      end: d.end,
    })),
    tasks: scan.tasks.map((t) => ({ line: t.task.line, binding: t.binding, taskText: t.taskText })),
  };
}

describe("golden fixtures", () => {
  it.each(names)("%s", (name) => {
    const actual = toJson(scanRefs(read(name)));
    const path = new URL(`${name}.json`, DIR);
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });

  it.each(names)("%s: ranges are UTF-16 offsets of the exact text", (name) => {
    const text = read(name);
    const scan = scanRefs(text);
    for (const d of scan.diagnostics) expect(text.slice(d.offsetStart, d.offsetEnd)).toBe(d.text);
    for (const p of scan.projections) {
      expect(text.slice(p.comment.offsetStart, p.comment.offsetEnd)).toBe(p.comment.text);
      expect(p.comment.offsetEnd - p.comment.offsetStart).toBe(p.comment.end - p.comment.start);
    }
  });

  it.each(names)(
    "%s: every unit re-emits byte for byte in its placement (MR§29 case 14)",
    (name) => {
      const text = read(name);
      for (const p of scanRefs(text).projections) {
        expect(emitUnit(p)).toBe(text.slice(p.unit.offsetStart, p.unit.offsetEnd));
        expect(replaceTaskText(text, p, p.taskText)).toBe(text);
      }
    },
  );
});

describe("MARKDOWN-REFS-01 examples", () => {
  it("mr-* fixtures are exactly the spec's md examples at the lock", () => {
    const spec = openSpec().read("integration/MARKDOWN-REFS-01.md").split("\n");
    const examples = new Map<string, string>();
    const counts = new Map<string, number>();
    let section = "";
    for (let i = 0; i < spec.length; i++) {
      const heading = /^##+ (\d+(?:\.\d+)?)\.? /.exec(spec[i] ?? "");
      if (heading?.[1]) section = heading[1];
      const fence = /^(`{3,})md$/.exec(spec[i] ?? "");
      if (!fence) continue;
      const body: string[] = [];
      for (i++; spec[i] !== fence[1]; i++) body.push(spec[i] ?? "");
      const n = (counts.get(section) ?? 0) + 1;
      counts.set(section, n);
      examples.set(`mr-s${section.replace(".", "-")}-${n}`, `${body.join("\n")}\n`);
    }
    const fixtures = names.filter((n) => n.startsWith("mr-"));
    expect(fixtures).toEqual([...examples.keys()].sort());
    for (const [name, body] of examples) expect(read(name), name).toBe(body);
  });
});
