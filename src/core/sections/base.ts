// Three-way bases for shared sections (LFCP-02-037). Pure; not wired in.
//
// As for 0.1 Tasks ([projection.md](../../../docs/architecture/projection.md)),
// a section projection keeps a base: what the note showed at its last
// reconciliation. A difference between the note and the base is the user's
// edit; a difference between the shared state and the base is a remote
// change to render. The shared state compared is the one taken with the
// note's read (the 0.3.2 snapshot rule), never a later one.
//
// Bases are stored per projection ID, not per path (review finding OP-24):
// a note can hold several projections, and a rename must not lose them.

import { splitLines } from "../refs/lines";
import type { SectionRef } from "./grammar";
import type { ParsedSection, SectionNode, SectionNodeKind } from "./parser";
import { nodeSource } from "./source-map";
import { diffText, type TextEdit } from "./text";

/** One bound node as a state compares it. */
export interface NodeState {
  readonly kind: SectionNodeKind;
  /** The parent node's ID, or null for the section's root. */
  readonly parent: string | null;
  /** The Text (paragraph, item, raw); absent for Tasks (their fields are compared by the 0.1 planner). */
  readonly text?: string;
  /**
   * A Task's line as the note showed it (its inline ref included): a remote
   * change is rendered onto the line only while it is unchanged (remote.ts).
   */
  readonly line?: string;
}

/** A section as the note, the base or the shared state shows it. */
export interface SectionState {
  readonly title: string;
  readonly nodes: Readonly<Record<string, NodeState>>;
  /** Child IDs in order, per parent ID; "" is the section's root. */
  readonly order: Readonly<Record<string, readonly string[]>>;
}

/** New content in the note without a binding yet (§7: the adapter decides new vs lost). */
export interface UnboundNode {
  readonly kind: SectionNodeKind;
  readonly parent: string | null;
  /** The bound sibling it follows, or null for the first child. */
  readonly after: string | null;
  readonly text?: string;
  /** 0-based first line, for the adapter's transaction mapping. */
  readonly line: number;
}

export const ROOT = "";

/**
 * The parent of a bound node whose parent in the note has no binding yet
 * (a new item the user indented existing nodes under). It is not a move
 * until that parent is bound, and the node is not missing either.
 */
export const UNBOUND_PARENT = "\u0000unbound";

/** The note's state of a parsed section, and its unbound candidates. */
export function markdownState(
  markdown: string,
  section: ParsedSection,
): { state: SectionState; unbound: UnboundNode[] } {
  const nodes: Record<string, NodeState> = {};
  const order: Record<string, string[]> = {};
  const unbound: UnboundNode[] = [];
  const lines = splitLines(markdown);
  const walk = (children: readonly SectionNode[], parent: string | null) => {
    let after: string | null = null;
    for (const n of children) {
      const text = nodeSource(markdown, n)?.text;
      if (n.id === null) {
        // A new node under a new node binds once its parent has an ID.
        if (parent !== UNBOUND_PARENT)
          unbound.push({
            kind: n.kind,
            parent,
            after,
            ...(text === undefined ? {} : { text }),
            line: n.lines.from,
          });
        walk(n.children, UNBOUND_PARENT);
        continue;
      }
      const line = n.kind === "task" ? lines[n.lines.from]?.text : undefined;
      nodes[n.id] = {
        kind: n.kind,
        parent,
        ...(text === undefined ? {} : { text }),
        ...(line === undefined ? {} : { line }),
      };
      const key = parent ?? ROOT;
      if (parent !== UNBOUND_PARENT) order[key] = [...(order[key] ?? []), n.id];
      after = n.id;
      walk(n.children, n.id);
    }
  };
  walk(section.nodes, null);
  return { state: { title: section.heading.title, nodes, order }, unbound };
}

/** What a pass sends, as profile intents in the adapter's terms (SSP §11). */
export interface SectionPlan {
  /** section.set_title */
  readonly title?: string;
  /** text.edit, against the base Text (or the shared one at first sight). */
  readonly textEdits: readonly { readonly nodeId: string; readonly edit: TextEdit }[];
  /** node.move: a new placement under `parent`, after `after`. */
  readonly moves: readonly {
    readonly nodeId: string;
    readonly parent: string | null;
    readonly after: string | null;
  }[];
  /**
   * Bound in the base, absent from the note. Not a delete by itself
   * (MARKDOWN-SECTIONS-01 §7): the adapter decides from the transaction,
   * else NODE_BINDING_LOST.
   */
  readonly missing: readonly string[];
  /** A node whose kind in the note differs from the shared state: never edited (NODE_KIND_MISMATCH). */
  readonly kindMismatch: readonly string[];
}

/** The bound sibling before `id` under `parent` in `state`. */
function predecessor(state: SectionState, parent: string | null, id: string): string | null {
  const siblings = state.order[parent ?? ROOT] ?? [];
  const at = siblings.indexOf(id);
  return at > 0 ? (siblings[at - 1] as string) : null;
}

/**
 * The user's edits in `note` against `base`. With no base (first sight of
 * the projection), the note is compared with `shared`, the state taken with
 * the note's read: what differs is the user's intent, what equals it is not.
 */
export function planSection(
  base: SectionState | undefined,
  note: SectionState,
  shared: SectionState,
): SectionPlan {
  const from = base ?? shared;
  const textEdits: { nodeId: string; edit: TextEdit }[] = [];
  const moves: { nodeId: string; parent: string | null; after: string | null }[] = [];
  const kindMismatch: string[] = [];
  for (const [id, n] of Object.entries(note.nodes)) {
    const was = from.nodes[id];
    const now = shared.nodes[id];
    if ((now !== undefined && now.kind !== n.kind) || (was !== undefined && was.kind !== n.kind)) {
      kindMismatch.push(id);
      continue;
    }
    if (was === undefined) continue; // not known to this projection yet: render or bind, not an edit
    if (n.text !== undefined && was.text !== undefined) {
      const edit = diffText(was.text, n.text);
      if (edit !== null) textEdits.push({ nodeId: id, edit });
    }
    // Every bound node is a candidate; reduceMoves keeps those the user moved.
    // Under a parent without a binding yet, there is no placement to send.
    if (n.parent === UNBOUND_PARENT) continue;
    moves.push({ nodeId: id, parent: n.parent, after: predecessor(note, n.parent, id) });
  }
  // With no base, nothing was shown here before: nothing can be missing.
  const missing =
    base === undefined ? [] : Object.keys(base.nodes).filter((id) => note.nodes[id] === undefined);
  return {
    ...(note.title !== from.title ? { title: note.title } : {}),
    textEdits,
    moves: reduceMoves(moves, note, from),
    missing,
    kindMismatch,
  };
}

/**
 * Keeps only the moves that explain the new order: a sibling that merely
 * shifted because another one moved is not moved itself.
 */
function reduceMoves(
  moves: readonly { nodeId: string; parent: string | null; after: string | null }[],
  note: SectionState,
  from: SectionState,
) {
  const reparented = moves.filter((m) => from.nodes[m.nodeId]?.parent !== m.parent);
  const reordered = moves.filter((m) => from.nodes[m.nodeId]?.parent === m.parent);
  const out = [...reparented];
  const byParent = new Map<string, typeof reordered>();
  for (const m of reordered) {
    const key = m.parent ?? ROOT;
    byParent.set(key, [...(byParent.get(key) ?? []), m]);
  }
  for (const [key, ms] of byParent) {
    // The longest run of siblings that kept their relative order stays; the rest moved.
    const target = (note.order[key] ?? []).filter(
      (id) => from.nodes[id]?.parent === (key === ROOT ? null : key),
    );
    const original = (from.order[key] ?? []).filter((id) => target.includes(id));
    const keep = new Set(longestCommonSubsequence(original, target));
    for (const m of ms) if (!keep.has(m.nodeId)) out.push(m);
  }
  return out;
}

export function longestCommonSubsequence(a: readonly string[], b: readonly string[]): string[] {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (dp[i] as number[])[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i] as string);
      i++;
      j++;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number))
      i++;
    else j++;
  }
  return out;
}

/** Where a projection is, locally (never shared): the note and the section it shows. */
export interface ProjectionLocator {
  readonly path: string;
  readonly section: SectionRef;
}

/** A projection's stored base: its locator and the state at its last reconciliation. */
export interface StoredBase {
  readonly locator: ProjectionLocator;
  readonly state: SectionState;
  /** The model revision it was reconciled with (contract §7.3). */
  readonly revision?: string;
  /**
   * Per node, the model revision at which the model's Text equals the
   * base's: the `base` of the node's next text.edit. Absent: `revision`.
   * Null: no such revision is known (a merged value the note does not show
   * yet), so the node's Text edits wait until it is projected.
   */
  readonly nodeRevisions?: Readonly<Record<string, string | null>>;
}

/** Bases by projection ID (local state, never synced; OP-24). */
export interface SectionBaseStore {
  load(projectionId: string): Promise<StoredBase | undefined>;
  save(projectionId: string, base: StoredBase | null): Promise<void>;
  /** The projections recorded for a note (a rename updates their locators, not their IDs). */
  projectionsOf(path: string): Promise<string[]>;
}

/** The local-state key of a projection's base. */
export const sectionBaseKey = (projectionId: string): string => `section-base:${projectionId}`;

/** A new projection ID: random, local only. */
export const newProjectionId = (): string => crypto.randomUUID();

/** In memory, for tests and until the install database adapter (LFCP-02-038). */
export class MemorySectionBaseStore implements SectionBaseStore {
  readonly #bases = new Map<string, StoredBase>();

  async load(projectionId: string): Promise<StoredBase | undefined> {
    return this.#bases.get(projectionId);
  }

  async save(projectionId: string, base: StoredBase | null): Promise<void> {
    if (base === null) this.#bases.delete(projectionId);
    else this.#bases.set(projectionId, base);
  }

  async projectionsOf(path: string): Promise<string[]> {
    return [...this.#bases]
      .filter(([, b]) => b.locator.path === path)
      .map(([id]) => id)
      .sort();
  }

  /** A note was renamed: its projections keep their IDs and bases. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    for (const [id, b] of this.#bases)
      if (b.locator.path === oldPath)
        this.#bases.set(id, { ...b, locator: { ...b.locator, path: newPath } });
  }
}
