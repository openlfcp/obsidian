// The editor's cost per keystroke in a shared section (LFCP-02-067): the
// section editor's transaction filters and hints (section-editor.ts) on a
// W200 note bound as a shared section, against the same keystroke on a
// plain editor state. Each sample applies one keystroke to the same start
// state. On purpose only: LFCP_PERF=1 pnpm perf -t editor.
//
//   LFCP_PERF=1 LFCP_PERF_OUT=<file.json> pnpm perf -t editor

import { writeFileSync } from "node:fs";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  formatBoundary,
  formatNodeMarker,
  parseSectionRef,
  type SectionRef,
} from "../../src/core/sections/grammar";
import { sectionEditorExtension } from "../../src/obsidian/section-editor";
import { WORKLOADS, type WorkloadSpec, workloadNote } from "./workloads";

const RUN = process.env.LFCP_PERF === "1";
const R = "yMMEHNHocAnDmj_loC9IErjKJzPzqmwBF1MNTPw8wkE";
const S = parseSectionRef(`lfcp1:${R}#section:019a2f85-7b31-7c42-b85a-fc843e2f4001`) as SectionRef;
let n = 0x100;
const nextId = () => `019a2f85-7b31-7c42-b85a-fc843e2f${(n++).toString(16).padStart(4, "0")}`;

/** The workload's note with its section bound as a shared one: boundaries, refs and markers. */
function boundNote(spec: WorkloadSpec): string {
  const src = workloadNote(spec).split("\n");
  const from = src.indexOf("## Workload");
  const to = src.indexOf("## After");
  const out = src.slice(0, from + 1);
  out.push(formatBoundary("start", S));
  for (const line of src.slice(from + 1, to)) {
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    if (/^\s*- \[.\] /.test(line)) {
      out.push(line, `${indent}  <!-- lfcp-ref: lfcp1:${R}#task:${nextId()} -->`);
    } else if (/^\s*- /.test(line)) {
      out.push(formatNodeMarker("item", nextId(), indent), line);
    } else if (line.trim() !== "") {
      out.push(formatNodeMarker("paragraph", nextId(), indent), line);
    } else out.push(line);
  }
  out.push(formatBoundary("end", S), ...src.slice(to));
  return out.join("\n");
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

/** One keystroke `spec(state)`, applied `samples` times to the same start state, with and without the section editor. */
function measure(
  doc: string,
  at: (doc: string) => number,
  spec: (pos: number) => TransactionSpec,
  samples: number,
) {
  const sectioned = EditorState.create({
    doc,
    extensions: sectionEditorExtension({ engine: () => null }).extension,
  });
  const plain = EditorState.create({ doc });
  const pos = at(doc);
  const run = (state: EditorState) => {
    const s = state.update({ selection: EditorSelection.cursor(pos) }).state;
    const times: number[] = [];
    for (let i = 0; i < samples + 50; i++) {
      const t0 = performance.now();
      s.update(spec(pos)).state;
      const dt = performance.now() - t0;
      if (i >= 50) times.push(dt);
    }
    return times;
  };
  const p = run(plain);
  const e = run(sectioned);
  const r = (xs: number[]) => ({
    p50: +quantile(xs, 0.5).toFixed(4),
    p95: +quantile(xs, 0.95).toFixed(4),
    max: +Math.max(...xs).toFixed(4),
  });
  return {
    plain: r(p),
    section: r(e),
    filterP50: +(quantile(e, 0.5) - quantile(p, 0.5)).toFixed(4),
  };
}

describe.skipIf(!RUN)("editor cost per keystroke in a shared section (LFCP-02-067)", () => {
  it("editor W200", () => {
    const doc = boundNote(WORKLOADS.W200 as WorkloadSpec);
    const lineStart = (d: string, i: number) =>
      d
        .split("\n")
        .slice(0, i)
        .reduce((a, l) => a + l.length + 1, 0);
    const lines = doc.split("\n");
    const mid = Math.floor(lines.length / 2);
    const taskLine = lines.findIndex((l, i) => i > mid && /^- \[ \] /.test(l));
    const paraLine = lines.findIndex(
      (l, i) =>
        i > mid && l !== "" && !l.startsWith("<!--") && !/^\s*-/.test(l) && !l.startsWith("  "),
    );
    const markerLine = paraLine - 1;
    const type = (pos: number): TransactionSpec => ({
      changes: { from: pos, insert: "x" },
      selection: EditorSelection.cursor(pos + 1),
      userEvent: "input.type",
    });
    const backspace = (pos: number): TransactionSpec => ({
      changes: { from: pos - 1, to: pos },
      selection: EditorSelection.cursor(pos - 1),
      userEvent: "delete.backward",
    });
    const results = {
      doc: { bytes: Buffer.byteLength(doc), lines: lines.length },
      // Typing at the end of a Task's title (its ref on the next line).
      typeTask: measure(
        doc,
        (d) => lineStart(d, taskLine) + (lines[taskLine]?.length ?? 0),
        type,
        2000,
      ),
      // Typing in a root paragraph's text (its marker on the line above).
      typeParagraph: measure(doc, (d) => lineStart(d, paraLine) + 5, type, 2000),
      // Backspace at the start of a Task line under a ref line: the guard refuses it.
      backspaceTaskStart: measure(doc, (d) => lineStart(d, taskLine + 2), backspace, 2000),
      // Typing on a marker line itself (source mode): every keystroke looks for glued bindings.
      typeOnMarker: measure(
        doc,
        (d) => lineStart(d, markerLine) + (lines[markerLine]?.length ?? 0),
        type,
        500,
      ),
    };
    console.log(`PERF ${JSON.stringify({ name: "editor W200", ...results })}`);
    if (process.env.LFCP_PERF_OUT !== undefined)
      writeFileSync(process.env.LFCP_PERF_OUT, JSON.stringify(results, null, 2));
    expect(results.typeTask.section.p50).toBeGreaterThan(0);
  });
});
