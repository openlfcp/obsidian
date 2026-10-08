// The plugin's own writes to section projections (LFCP-02-042,
// SDK-SECTIONS-INTEGRATION-01 §7.6). Pure; not wired in.
//
// Feedback is prevented by the base, not by ignoring events: a write
// (a remote patch, a marker insertion) records the base it leads to, and the
// next pass compares the note with it three-way (base.ts), so the write's
// own content yields no intent and anything else in the same note (the
// user's typing, the Tasks plugin's ✅) does. Nothing is suppressed for a
// time window or while a write is in flight.
//
// A write is known by its operation ID (an editor transaction carries it as
// an annotation) or by the exact content it produces (a file event, which
// carries nothing). The host confirms a write once it landed (the editor
// transaction was dispatched, the file's read-modify-write resolved) or
// abandons it (stale revision, failed write). Before that, an external
// write can replace the file first; reconciling against the new base then
// would read the old values as the user's edits and send them back,
// reverting the remote change (the 0.3.1 revert race). So while a write is
// pending, each node is compared with whichever base the note shows for it
// (`pendingBase`), and a node changed from both with the base the write's
// fate decides.

import { contentHash } from "../projection/guard";
import { type NodeState, ROOT, type SectionState } from "./base";

export interface GeneratedWrite {
  readonly operationId: string;
  readonly projectionId: string;
  readonly path: string;
  /** The note's revision the write was planned against (SHA-256). */
  readonly before: string;
  /** The note's revision once written (SHA-256 of the content it produces). */
  readonly after: string;
  /** The projection's base before the write, and once it is written. */
  readonly prior: SectionState;
  readonly next: SectionState;
  /** The host saw the write land; until then it may still be lost. */
  readonly confirmed: boolean;
}

/** How many pending writes one path keeps; older ones are dropped. */
const PER_PATH = 8;

/** Writes the plugin made and has not seen come back yet, per path. */
export class GeneratedWrites {
  readonly #pending = new Map<string, GeneratedWrite[]>();

  /** Records a write about to be made: `content` is the note it produces. */
  record(
    w: Omit<GeneratedWrite, "after" | "confirmed"> & { readonly content: string },
  ): GeneratedWrite {
    const { content, ...rest } = w;
    const write: GeneratedWrite = { ...rest, after: contentHash(content), confirmed: false };
    const list = this.#pending.get(w.path) ?? [];
    list.push(write);
    while (list.length > PER_PATH) list.shift();
    this.#pending.set(w.path, list);
    return write;
  }

  /**
   * An editor transaction annotated with `operationId`: the plugin's own,
   * when recorded. It is consumed with every older write of its path.
   */
  ownTransaction(operationId: string): GeneratedWrite | undefined {
    for (const [path, list] of this.#pending) {
      const at = list.findIndex((w) => w.operationId === operationId);
      if (at >= 0) return this.#consume(path, at);
    }
    return undefined;
  }

  /**
   * A file event: the write whose exact content this is (consumed, with
   * every older write of the path), or undefined when the content is not
   * one the plugin produced: someone else wrote, or wrote on top.
   */
  observe(path: string, content: string): GeneratedWrite | undefined {
    const list = this.#pending.get(path);
    if (list === undefined) return undefined;
    const hash = contentHash(content);
    for (let at = list.length - 1; at >= 0; at--)
      if (list[at]?.after === hash) return this.#consume(path, at);
    return undefined;
  }

  /** The write landed (dispatched, or the file write resolved). */
  confirm(operationId: string): void {
    for (const [path, list] of this.#pending)
      this.#pending.set(
        path,
        list.map((w) => (w.operationId === operationId ? { ...w, confirmed: true } : w)),
      );
  }

  /** The write was not made (a stale revision, a failed write): it is forgotten. */
  abandon(operationId: string): void {
    for (const [path, list] of this.#pending) {
      const rest = list.filter((w) => w.operationId !== operationId);
      if (rest.length === 0) this.#pending.delete(path);
      else this.#pending.set(path, rest);
    }
  }

  /** Writes still pending for a projection, oldest first. */
  pendingFor(projectionId: string): GeneratedWrite[] {
    return [...this.#pending.values()].flat().filter((w) => w.projectionId === projectionId);
  }

  /** The note was deleted: its pending writes go. */
  forget(path: string): void {
    this.#pending.delete(path);
  }

  rename(oldPath: string, newPath: string): void {
    const list = this.#pending.get(oldPath);
    if (list === undefined) return;
    this.#pending.delete(oldPath);
    this.#pending.set(
      newPath,
      list.map((w) => ({ ...w, path: newPath })),
    );
  }

  #consume(path: string, at: number): GeneratedWrite {
    const list = this.#pending.get(path) as GeneratedWrite[];
    const write = list[at] as GeneratedWrite;
    const rest = list.slice(at + 1);
    if (rest.length === 0) this.#pending.delete(path);
    else this.#pending.set(path, rest);
    return write;
  }
}

const same = (a: NodeState | undefined, b: NodeState | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.kind === b.kind &&
  a.parent === b.parent &&
  a.text === b.text &&
  a.line === b.line;

/**
 * The base to reconcile `note` against while `write` is pending: per node
 * (and for the title), the write's base where the note shows the written
 * value, the prior base where it shows the prior one. A node changed from
 * both was edited: on top of the write once it is confirmed (so the edit
 * does not repeat the remote change), else over the prior value (so a lost
 * write never becomes an intent that reverts the remote change).
 */
export function pendingBase(write: GeneratedWrite, note: SectionState): SectionState {
  const { prior, next } = write;
  const nodes: Record<string, NodeState> = {};
  const ids = new Set([...Object.keys(prior.nodes), ...Object.keys(next.nodes)]);
  const kept = new Set<string>();
  for (const id of ids) {
    const was = prior.nodes[id];
    const will = next.nodes[id];
    const now = note.nodes[id];
    if (will === undefined) {
      // Removed by the write: still a base while the note shows it.
      if (was !== undefined && now !== undefined) {
        nodes[id] = was;
        kept.add(id);
      }
      continue;
    }
    nodes[id] =
      same(now, will) || was === undefined
        ? will
        : same(now, was)
          ? was
          : write.confirmed
            ? will
            : was;
  }
  const order: Record<string, readonly string[]> =
    kept.size === 0 ? { ...next.order } : { ...prior.order };
  if (kept.size > 0)
    for (const [parent, list] of Object.entries(order))
      if (parent !== ROOT && nodes[parent] === undefined) delete order[parent];
      else order[parent] = list.filter((id) => nodes[id] !== undefined);
  const title =
    note.title === next.title
      ? next.title
      : note.title === prior.title
        ? prior.title
        : write.confirmed
          ? next.title
          : prior.title;
  return { title, nodes, order };
}
