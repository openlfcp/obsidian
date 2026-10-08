// What the plugin needs from the SDK for shared sections, as one narrow port
// (SDK-SECTIONS-INTEGRATION-01, `sections-integration/1`). The SDK does not
// provide it yet (LFCP-02-012..016); the section engine is written and
// tested against this port and a fake, so that the real binding is an
// adapter of the same shape. Names follow the contract; anything the SDK
// cannot establish is `unknown`, never a default (§2).

import type { SectionNodeKind } from "./parser";

/** A node of the section model as the SDK snapshot shows it. */
export interface ModelNode {
  readonly kind: SectionNodeKind;
  /** The parent node's ID, or null for the section's root. */
  readonly parent: string | null;
  readonly lifecycle: "active" | "deleted";
  /** The Text (paragraph, item, raw), LF line breaks; absent for Tasks. */
  readonly text?: string;
}

/**
 * A model problem (SHARED-SECTIONS-PROFILE-01 §14.2, §14.3): a structural
 * or lifecycle conflict, an isolated node, a colliding ID. Reported with
 * the snapshot; an ACK never clears one (contract §4.3).
 */
export interface SectionProblem {
  readonly code: string;
  readonly nodeIds: readonly string[];
}

/**
 * The section as the SDK's synchronous snapshot shows it, taken in the same
 * continuation as the note's read (the 0.3.2 snapshot rule).
 */
export interface SectionSnapshot {
  /** The local document's heads, sorted, opaque: the base of a text.edit (§7.5). */
  readonly revision: string;
  readonly title: string;
  /** False while the section imports (§4.3): nothing is projected or created. */
  readonly ready: boolean;
  readonly nodes: Readonly<Record<string, ModelNode>>;
  /** Child IDs in visible order, per parent ID; "" is the section's root. */
  readonly order: Readonly<Record<string, readonly string[]>>;
  readonly problems: readonly SectionProblem[];
}
