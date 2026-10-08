// The product adapter of MARKDOWN-SECTIONS-FIXTURES-01 (LFCP-02-047): the
// interface the spec's verify-markdown.mjs imports with --adapter,
// runFixture(input) -> { after_files, diagnostics, intents, publication },
// run on the plugin's production code: the section parser, the engine and
// the editor rules, over a model built from the fixture's before files
// (the fake SDK port with a real Shared Objects replica for Task fields).
// Expected outputs are never read here: only the fixture's inputs.

import { fromBase64url, principalId, resourceId } from "@openlfcp/core";
import { SharedObjectsReplica } from "@openlfcp/shared-objects";
import { planShare } from "../../src/core/collab/markdown";
import { parseTaskText } from "../../src/core/projection/task-text";
import { MemorySectionBaseStore, markdownState } from "../../src/core/sections/base";
import { sectionContext } from "../../src/core/sections/context";
import { applyChanges, type PassContext, SectionEngine } from "../../src/core/sections/engine";
import { MemorySectionJournalStore } from "../../src/core/sections/journal";
import type { LineRange, SectionNode } from "../../src/core/sections/parser";
import { parseSections, scanSectionRefs } from "../../src/core/sections/parser";
import type { SectionIntent } from "../../src/core/sections/port";
import {
  classifyRemoval,
  detachSection,
  keepRefWithTask,
  readableSection,
} from "../../src/core/sections/rules";
import { FakeSectionPort } from "../core/sections/fake-port";

export interface FixtureInput {
  readonly id: string;
  readonly identifiers: { readonly resource: string; readonly section: string };
  readonly before_files: Readonly<Record<string, string>>;
  readonly projection_base: "trusted" | "unknown";
  readonly event: {
    readonly kind: string;
    readonly observed_files?: Readonly<Record<string, string>>;
    readonly settings?: {
      readonly section_comments?: "local" | "shared";
      readonly binding_placement?: "child-line" | "inline";
    };
    readonly allocated_ids?: readonly string[];
    readonly task_id?: string;
    readonly model_diagnostics?: readonly string[];
    readonly remote_intents?: readonly Record<string, unknown>[];
    readonly user_event?: string | null;
  };
}

export type FixtureIntent = Record<string, unknown>;

export interface FixtureResult {
  readonly after_files: Record<string, string>;
  readonly diagnostics: string[];
  readonly intents: FixtureIntent[];
  readonly publication: "none" | "semantic" | "suspended";
  /**
   * What the section shares, in plaintext before encryption (AC3): the
   * batches committed to the SDK, and the model's texts and Task objects.
   */
  readonly payload: string;
  /**
   * What a copy puts on the clipboard: the readable section (§10, MS25), or
   * a selected Task title as source text (MS15; the rendered DOM's rich text
   * is the native harness's to check).
   */
  readonly clipboard?: { readonly plain_text: string };
  /** Whether a 0.1 command on the Task was refused inside the section (MS37). */
  readonly commandRefused?: boolean;
  /** The shared Task objects, by ID. */
  readonly tasks: Record<string, Record<string, unknown>>;
}

const ME = principalId(new Uint8Array(32).fill(4));
const SECTION_MARK = "lfcp-section:";

/** Our intent in the fixtures' form (type, id, parent_id, title, text, dates, before). */
function fixtureIntent(
  i: SectionIntent,
  sectionId: string,
  nextOf: (id: string) => string | undefined,
): FixtureIntent {
  const parentId = (p: string) => p;
  switch (i.intent) {
    case "section.set_title":
      return { type: i.intent, id: sectionId, title: i.title };
    case "task.create_in_section": {
      const t = i.task as Record<string, unknown>;
      const next = nextOf(i.task.id);
      return {
        type: i.intent,
        id: i.task.id,
        parent_id: parentId(i.parent),
        title: t.title,
        ...(typeof t.due === "string" ? { due: t.due } : {}),
        ...(next === undefined ? {} : { before: next }),
      };
    }
    case "paragraph.create":
    case "item.create":
    case "raw.create": {
      const next = nextOf(i.id);
      return {
        type: i.intent,
        id: i.id,
        parent_id: parentId(i.parent),
        text: i.text,
        ...(next === undefined ? {} : { before: next }),
      };
    }
    case "task.complete":
      return {
        type: i.intent,
        id: i.id,
        ...(i.completionDate === undefined ? {} : { completion_date: i.completionDate }),
      };
    case "node.delete":
    case "node.restore":
    case "task.reopen":
      return { type: i.intent, id: i.id };
    default:
      return { type: i.intent, ...(i as object) };
  }
}

/** The one insertion that turns `before` into `after`, or null. */
function singleInsertion(before: string, after: string) {
  if (after.length <= before.length) return null;
  let p = 0;
  while (p < before.length && before[p] === after[p]) p++;
  let insert = after.slice(p, p + after.length - before.length);
  if (after.slice(p + insert.length) !== before.slice(p)) return null;
  // The same insertion as an editor makes it: a new line typed at the end of
  // the line before ("\n- [ ] "), not at the start of the next one.
  while (p > 0 && insert.endsWith("\n") && before[p - 1] === "\n") {
    insert = `\n${insert.slice(0, -1)}`;
    p--;
  }
  return { from: p, to: p, insert };
}

/** Lines of `before` an edit removed, by a line diff (longest common subsequence). */
function removedLines(before: string, after: string): LineRange[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
  const kept = new Set<number>();
  for (let i = 0, j = 0; i < a.length && j < b.length; )
    if (a[i] === b[j]) {
      kept.add(i);
      i++;
      j++;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))
      i++;
    else j++;
  return a.flatMap((_, i) => (kept.has(i) ? [] : [{ from: i, to: i }]));
}

/** Bound nodes of `before` whose every line the edit removed: deletions (§7, rules.ts). */
function removedNodes(before: string, after: string): Set<string> {
  const removed = removedLines(before, after);
  const out = new Set<string>();
  const walk = (ns: readonly SectionNode[]) => {
    for (const n of ns) {
      if (n.id !== null && classifyRemoval(n, removed) === "delete") out.add(n.id);
      walk(n.children);
    }
  };
  for (const sec of parseSections(before).sections) walk(sec.nodes);
  return out;
}

export async function runFixture(input: FixtureInput): Promise<FixtureResult> {
  const R = input.identifiers.resource;
  const S = input.identifiers.section;
  const settings = input.event.settings ?? {};
  const observed = input.event.observed_files ?? input.before_files;
  const port = new FakeSectionPort();
  const { replica } = SharedObjectsReplica.create({
    resource: resourceId(fromBase64url(R)),
    principal: ME,
  });
  port.onTaskIntents = (intents) => {
    for (const i of intents) replica.apply(i as never);
  };

  // The model and the Task objects, from the first before file with the section.
  const primary = Object.values(input.before_files).find((t) => t.includes(SECTION_MARK));
  const primarySection = primary === undefined ? undefined : parseSections(primary).sections[0];
  if (primary !== undefined && primarySection !== undefined) {
    port.host(R, S, markdownState(primary, primarySection).state);
    const scan = scanSectionRefs(primary);
    for (const p of scan.projections) {
      const state = scan.tasks.find((t) => t.task.line === p.taskLine);
      if (state === undefined || replica.task(p.objectId) !== undefined) continue;
      for (const i of planShare(state, ME, p.objectId as never).intents) replica.apply(i);
    }
  }

  const ids = [...(input.event.allocated_ids ?? [])];
  let fallback = 0;
  const engine = new SectionEngine({
    port,
    journal: new MemorySectionJournalStore(),
    bases: new MemorySectionBaseStore(),
    newNodeId: () =>
      ids.shift() ?? `00000000-0000-7000-8000-${(fallback++).toString(16).padStart(12, "0")}`,
    newOperationId: () => `op-${fallback++}`,
    createdBy: ME,
    newProjectionId: () => `projection-${fallback++}`,
    tasks: (_r, taskId) => {
      const view = replica.task(taskId);
      return view === undefined ? undefined : { view };
    },
    newTask: (line, taskId) => {
      const state = scanSectionRefs(line).tasks[0];
      const create =
        state === undefined ? undefined : planShare(state, ME, taskId as never).intents[0];
      if (create?.intent !== "task.create") throw new Error("not a Task line");
      return create.task;
    },
    refPlacement: () => settings.binding_placement ?? "child-line",
    sectionComments: () => settings.section_comments ?? "local",
  });
  const ctx: PassContext = {
    caretLine: null,
    deletedIds: new Set(),
    origin: "other",
    external: input.event.kind === "external_plugin_edit",
  };

  // A trusted base: what the note showed at its last reconciliation.
  if (input.projection_base === "trusted")
    for (const [path, text] of Object.entries(input.before_files))
      if (text.includes(SECTION_MARK)) {
        const seed = await engine.pass(path, text, { ...ctx, external: false });
        await engine.written(seed, text);
      }

  // The event's effect on the model.
  const model = port.sections.get(R);
  if (input.event.kind === "remote_complete" && input.event.task_id !== undefined) {
    const t = replica.task(input.event.task_id)?.task;
    if (t !== undefined) replica.apply({ intent: "task.complete", id: t.id });
    port.remote(R, () => {});
  }
  if (input.event.kind === "remote_structure_conflict" && model !== undefined)
    port.remote(R, (s) => {
      s.problems = (input.event.model_diagnostics ?? []).map((code) => ({ code, nodeIds: [] }));
    });
  if (input.event.kind === "remote_insert" && model !== undefined)
    port.remote(R, (s) => {
      for (const i of input.event.remote_intents ?? []) {
        const kind = String(i.type).replace(".create", "") as "raw" | "paragraph" | "item";
        const parent = i.parent_id === S ? null : (i.parent_id as string);
        const key = parent ?? "";
        s.state = {
          ...s.state,
          nodes: { ...s.state.nodes, [i.id as string]: { kind, parent, text: i.text as string } },
          order: { ...s.state.order, [key]: [...(s.state.order[key] ?? []), i.id as string] },
        };
      }
    });

  const after: Record<string, string> = {};
  const diagnostics: string[] = [];
  let suspended = false;
  const changesBefore = port.changes.length;
  const note = (code: string) => {
    if (!diagnostics.includes(code)) diagnostics.push(code);
  };

  for (const [path, observedText] of Object.entries(observed)) {
    let text = observedText;
    if (input.event.kind === "detach_section") {
      const s = parseSections(text).sections[0];
      after[path] = s === undefined ? text : detachSection(text, s);
      continue;
    }
    if (!text.includes("lfcp-")) {
      after[path] = text;
      continue;
    }
    // An editor edit names the bound nodes it removed with every line (§7);
    // an external cut and paste has no transaction mapping (MS18).
    const before = input.before_files[path];
    let caretLine: number | null = null;
    if (input.event.kind === "editor_enter" && before !== undefined) {
      // The editor's transaction, recovered from the two texts (one insertion),
      // and the rule that keeps a child-line ref with its Task (MS27, MS28).
      const change = singleInsertion(before, text);
      const kept = change === null ? null : keepRefWithTask(before, change);
      if (kept !== null) {
        text = applyChanges(before, [kept]);
        caretLine = text.slice(0, kept.from + 1).split("\n").length - 1;
      }
    }
    const deletedIds =
      before === undefined || input.event.kind === "external_cut_paste"
        ? new Set<string>()
        : removedNodes(before, text);
    const pass = await engine.pass(path, text, { ...ctx, deletedIds, caretLine });
    const out = applyChanges(text, pass.changes);
    await engine.written(pass, out);
    after[path] = out;
    // The diagnostics of the note as the adapter leaves it.
    const scan = parseSections(out);
    for (const d of scan.diagnostics) if (d.severity !== "info") note(d.code);
    for (const d of scanSectionRefs(out).diagnostics) {
      const inSection = scan.sections.some((s) => d.line > s.startLine && d.line < s.endLine);
      // A section diagnostic on the same line restates it in the section's terms.
      const restated = scan.diagnostics.some((x) => x.line === d.line);
      if (inSection && !restated) note(d.code);
    }
    if (scan.diagnostics.some((d) => d.severity === "error")) suspended = true;
    for (const r of pass.sections) {
      if (r.skipped === "base-unknown") {
        note("PROJECTION_BASE_UNKNOWN");
        suspended = true;
      }
      if (r.skipped === "blocked") suspended = true;
      if (r.lost.length > 0) {
        note("NODE_BINDING_LOST");
        suspended = true;
      }
      if (r.remote?.kind === "patch" && r.remote.frozen) {
        for (const p of port.snapshot(R, S)?.problems ?? []) note(p.code);
        suspended = true;
      }
    }
  }

  // Intents of the event, in the fixtures' form; `before` from the resulting order.
  const order = port.sections.get(R)?.state.order ?? {};
  // `before` names an existing node the new one precedes, not one created with it.
  const created = new Set(
    port.changes
      .slice(changesBefore)
      .flatMap((c) =>
        c.intents.flatMap((i) =>
          i.intent === "task.create_in_section"
            ? [i.task.id]
            : i.intent.endsWith(".create") && "id" in i
              ? [i.id]
              : [],
        ),
      ),
  );
  const nextOf = (id: string) => {
    for (const list of Object.values(order)) {
      const at = list.indexOf(id);
      if (at >= 0) return list.slice(at + 1).find((n) => !created.has(n));
    }
    return undefined;
  };
  const intents = port.changes
    .slice(changesBefore)
    .flatMap((c) => c.intents.map((i) => fixtureIntent(i, S, nextOf)));
  const publication = intents.length > 0 ? "semantic" : suspended ? "suspended" : "none";

  // The shared plaintext: committed batches, the model, the Task objects.
  const tasks: Record<string, Record<string, unknown>> = {};
  for (const id of Object.keys(port.sections.get(R)?.state.nodes ?? {})) {
    const t = replica.task(id)?.task;
    if (t !== undefined) tasks[id] = t as unknown as Record<string, unknown>;
  }
  // Every string value, as the plaintext it is (not JSON-escaped), with the
  // intent names kept so that a deletion stays visible.
  const strings: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) for (const x of v) collect(x);
    else if (v !== null && typeof v === "object") for (const x of Object.values(v)) collect(x);
  };
  collect({
    batches: port.changes.map((c) => c.intents),
    model: port.sections.get(R)?.state,
    tasks,
  });
  const payload = strings.join("\n");
  const extra: { clipboard?: { plain_text: string }; commandRefused?: boolean } = {};
  const first = Object.values(observed)[0] ?? "";
  const firstSection = parseSections(first).sections[0];
  if (input.event.kind === "copy_readable_section" && firstSection !== undefined)
    extra.clipboard = { plain_text: readableSection(first, firstSection) };
  if (input.event.kind === "copy_rendered") {
    const t = scanSectionRefs(first).tasks[0];
    if (t !== undefined) extra.clipboard = { plain_text: parseTaskText(t.taskText).title };
  }
  if (input.event.kind === "detach_task_command" && input.event.task_id !== undefined) {
    const p = scanSectionRefs(first).projections.find((x) => x.objectId === input.event.task_id);
    extra.commandRefused =
      p !== undefined && sectionContext(first, { from: p.taskLine, to: p.taskLine }) === "inside";
  }
  return { after_files: after, diagnostics, intents, publication, payload, tasks, ...extra };
}
