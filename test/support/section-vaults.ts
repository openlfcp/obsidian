// Vaults with shared sections on the real section replica, offline: each
// with the engine and the port as sections-host wires them, its notes by
// path, and the Markdown edits a person makes to move a Task (cut, paste,
// indent). Changes between vaults are exchanged by hand (reconnect).

import type { Receipt } from "@openlfcp/client";
import { type PrincipalId, principalId, resourceId, toBase64url } from "@openlfcp/core";
import { type SectionIntent as SdkIntent, SectionReplica } from "@openlfcp/shared-objects/sections";
import { InMemoryLfcpStorage } from "@openlfcp/storage";
import { expect } from "vitest";
import { SdkSectionPort } from "../../src/core/lfcp/section-port";
import { MemorySectionBaseStore } from "../../src/core/sections/base";
import { applyChanges, type PassContext, SectionEngine } from "../../src/core/sections/engine";
import { formatBoundary, parseSectionRef, type SectionRef } from "../../src/core/sections/grammar";
import { MemorySectionJournalStore } from "../../src/core/sections/journal";
import { newSectionTask } from "../../src/core/sections/task-fields";

export const id = (n: number) =>
  `019a2f85-7b31-7c42-b85a-fc843e2f4${n.toString(16).padStart(3, "0")}`;
export const A_ME = principalId(new Uint8Array(32).fill(4));
export const B_ME = principalId(new Uint8Array(32).fill(5));

/** A shared section: its Resource (bytes and base64url), its ID and its ref. */
export interface Shared {
  readonly rid: ReturnType<typeof resourceId>;
  readonly R: string;
  readonly sid: string;
  readonly ref: SectionRef;
}

export function shared(fill: number, sid: string): Shared {
  const rid = resourceId(new Uint8Array(32).fill(fill));
  const R = toBase64url(rid);
  return { rid, R, sid, ref: parseSectionRef(`lfcp1:${R}#section:${sid}`) as SectionRef };
}

/** The section of the tests (Resource 7, section ID 1). */
export const PLAN = shared(7, id(1));
export const PATH = "Plan.md";

/**
 * One vault: a replica per Resource, the port over them, and the engine as
 * sections-host wires it. New node IDs are allocated from `firstNode`.
 */
export function vault(
  name: string,
  me: PrincipalId,
  replicas: Map<string, SectionReplica>,
  firstNode = 100,
) {
  let unit = 0;
  const replicaOf = (r: string) => {
    const replica = replicas.get(r);
    if (replica === undefined) throw new Error(`${name} has no replica of ${r}`);
    return replica;
  };
  const port = new SdkSectionPort({
    profile: (r) => {
      const replica = replicas.get(toBase64url(r));
      return replica === undefined ? undefined : ({ replica } as never);
    },
    commit: async (r, intents, o): Promise<Receipt> => {
      const replica = replicaOf(toBase64url(r));
      const change = replica.commit(intents as readonly SdkIntent[]);
      return {
        operationId: o.operationId,
        unitIds: [new Uint8Array(32).fill(++unit)] as never,
        affectedNodeIds: change?.affectedNodeIds ?? [],
        modelRevision: replica.revision(),
        intentsHash: `${name}-${unit}`,
        durable: true,
      };
    },
    storage: new InMemoryLfcpStorage(),
    canWrite: async () => ({ allowed: true, reason: null, controlHead: null, verifiedAt: null }),
  });
  let node = firstNode;
  let op = 0;
  let projection = 0;
  const engine = new SectionEngine({
    port,
    journal: new MemorySectionJournalStore(),
    bases: new MemorySectionBaseStore(),
    newNodeId: () => id(node++),
    newOperationId: () => `${name}-op-${++op}`,
    createdBy: me,
    newProjectionId: () => `${name}-projection-${++projection}`,
    tasks: (r, taskId) => ({ view: port.taskView(r, taskId) }),
    newTask: (line, taskId) => newSectionTask(line, me, taskId),
  });
  const notes = new Map<string, string>();
  /** One pass on `md` at `path`, written as the host writes it; the note is what it leaves. */
  const pass = async (md: string, ctx: Partial<PassContext> = {}, path = PATH) => {
    const p = await engine.pass(path, md, {
      caretLine: null,
      deletedIds: new Set(),
      origin: "other",
      ...ctx,
    });
    const out = applyChanges(md, p.changes);
    notes.set(path, out);
    await engine.written(p, out);
    return p.sections[0];
  };
  return {
    replicas,
    replica: (s: Shared = PLAN) => replicaOf(s.R),
    pass,
    note: (path = PATH) => notes.get(path) ?? "",
    model: (s: Shared = PLAN) => port.snapshot(s.R, s.sid),
  };
}

export type Vault = ReturnType<typeof vault>;

export const lines = (md: string) => md.split("\n");

/** How many lines show the Task titled `title`. */
export const count = (md: string, title: string) =>
  lines(md).filter((l) => l.includes(`[ ] ${title}`)).length;

/** The lines of the Task titled `title` with its ref and nested lines: [from, to). */
export function block(md: string, title: string): [number, number] {
  const L = lines(md);
  const from = L.findIndex((l) => l.includes(`[ ] ${title}`));
  if (from < 0) throw new Error(`no Task "${title}"`);
  const indent = /^[ \t]*/.exec(L[from] ?? "")?.[0].length ?? 0;
  let to = from + 1;
  while (
    to < L.length &&
    /^[ \t]/.test(L[to] ?? "") &&
    (/^[ \t]*/.exec(L[to] ?? "")?.[0].length ?? 0) > indent
  )
    to++;
  return [from, to];
}

/** `md` with the Task `title` (and its ref and nested lines) cut. */
export function cut(md: string, title: string): string {
  const L = lines(md);
  const [from, to] = block(md, title);
  return [...L.slice(0, from), ...L.slice(to)].join("\n");
}

/** `after` with the lines of `title` from `before` pasted after the Task `parent`'s block, at `indent`. */
export function paste(
  before: string,
  after: string,
  title: string,
  parent: string,
  indent = "",
): string {
  const [from, to] = block(before, title);
  const pasted = lines(before)
    .slice(from, to)
    .map((l) => indent + l);
  const L = lines(after);
  const [, end] = block(after, parent);
  return [...L.slice(0, end), ...pasted, ...L.slice(end)].join("\n");
}

/** The ID of the Task titled `title`, from its ref (child line or inline). */
export function taskId(md: string, title: string): string {
  const [from, to] = block(md, title);
  const found = lines(md)
    .slice(from, to)
    .join("\n")
    .match(/#task:([0-9a-f-]{36})/);
  if (found?.[1] === undefined) throw new Error(`"${title}" has no ref`);
  return found[1];
}

/** A note with the section `s` holding `body`, a private line before and after. */
export function sectionNote(s: Shared, title: string, body: readonly string[]): string {
  return [
    "Intro",
    `## ${title}`,
    formatBoundary("start", s.ref),
    ...body,
    formatBoundary("end", s.ref),
    "",
  ].join("\n");
}

/**
 * Vault A shares `body` in section `s` (typed into an empty section, then
 * bound), and vault B, with A's changes, shows the same note.
 */
export async function twoVaults(body: readonly string[], s: Shared = PLAN) {
  const ra = SectionReplica.empty({ resource: s.rid, principal: A_ME });
  ra.commit([{ intent: "section.create", sectionId: s.sid, title: "Plan", createdBy: A_ME }]);
  const a = vault("A", A_ME, new Map([[s.R, ra]]));
  const empty = sectionNote(s, "Plan", []);
  await a.pass(empty);
  await a.pass(sectionNote(s, "Plan", body));
  // Children of a new node bind on a later pass: until the note is stable.
  for (let i = 0, before = ""; i < 5 && a.note() !== before; i++) {
    before = a.note();
    await a.pass(before);
  }
  const rb = SectionReplica.empty({ resource: s.rid, principal: B_ME });
  rb.receiveChanges(ra.changes());
  const b = vault("B", B_ME, new Map([[s.R, rb]]), 500);
  await b.pass(a.note());
  expect(b.note()).toBe(a.note());
  return { a, b };
}

/** The network comes back: each replica receives the other's changes, then each note is passed twice. */
export async function reconnect(a: Vault, b: Vault, paths: readonly string[] = [PATH]) {
  for (const [r, ra] of a.replicas) {
    const rb = b.replicas.get(r);
    if (rb === undefined) continue;
    const fromA = ra.changes();
    ra.receiveChanges(rb.changes());
    rb.receiveChanges(fromA);
  }
  for (const v of [a, b])
    for (const path of paths) {
      await v.pass(v.note(path), {}, path);
      await v.pass(v.note(path), {}, path);
    }
}

/** Whether the model of `v` reports a placement conflict for `nodeId`. */
export const placementConflict = (v: Vault, nodeId: string, s: Shared = PLAN) =>
  v
    .model(s)
    ?.problems.some((p) => p.code === "PLACEMENT_CONFLICT" && p.nodeIds.includes(nodeId)) === true;
