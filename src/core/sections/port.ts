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

/** A Text edit in Unicode scalar positions (SSP §10). */
export interface ScalarEdit {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
}

/** A new Task's fields, as 0.1's task.create carries them (planShare builds them). */
export interface NewSectionTask {
  readonly id: string;
  readonly title: string;
  readonly [field: string]: unknown;
}

/**
 * The profile's intents (SHARED-SECTIONS-PROFILE-01 §11) the section engine
 * sends, in this contract's field names. `after` is the bound sibling before
 * the node, or null for the first child; `parent` null is the section root.
 * Every new ID is the plugin's (UUIDv7, allocated before the commit).
 */
export type SectionIntent =
  | { readonly intent: "section.set_title"; readonly title: string }
  | {
      readonly intent: "text.edit";
      readonly id: string;
      readonly edits: readonly ScalarEdit[];
      /** The modelRevision the indices were computed against (§7.5). */
      readonly base: string;
    }
  | {
      readonly intent: "node.move";
      readonly id: string;
      readonly parent: string | null;
      readonly after: string | null;
    }
  | { readonly intent: "node.delete" | "node.restore"; readonly id: string }
  | {
      readonly intent: "paragraph.create" | "item.create" | "raw.create";
      readonly id: string;
      readonly parent: string | null;
      readonly after: string | null;
      readonly text: string;
    }
  | {
      readonly intent: "task.create_in_section";
      readonly task: NewSectionTask;
      readonly parent: string | null;
      readonly after: string | null;
    };

/** A durable local commit's receipt (contract §3.2). */
export interface Receipt {
  readonly operationId: string;
  readonly unitIds: readonly string[];
  readonly affectedNodeIds: readonly string[];
  /** The local document's heads after the commit: the projection's new base revision. */
  readonly modelRevision: string;
  /** SHA-256 of the batch's canonical form (§3.3). */
  readonly intentsHash: string;
  readonly durable: true;
}

/** Codes of a batch refused before commit (contract §3.6); the profile's own codes too. */
export type CommitRefusalCode =
  | "STALE_BASE"
  | "OPERATION_ID_REUSED"
  | "NOT_WRITABLE"
  | "SECTION_IMPORTING"
  | (string & {});

/** A batch refused before commit: nothing was written and there is no receipt. */
export class CommitRefused extends Error {
  constructor(
    readonly code: CommitRefusalCode,
    readonly nodeId?: string,
  ) {
    super(`commit refused: ${code}`);
    this.name = "CommitRefused";
  }
}

/** Write access from the validated Control state (contract §6). */
export interface WriteAccess {
  readonly allowed: boolean;
  readonly reason?: "not-member" | "read-only" | "key-unavailable" | "revoked" | "unknown";
  readonly controlHead?: string;
  readonly verifiedAt?: number;
}

/**
 * The SDK as the section engine uses it. `commit` resolves only once the
 * batch is durable, refuses with CommitRefused, and throws anything else
 * when the outcome is unknown (the caller then asks `receiptOf`).
 */
export interface SectionPort {
  snapshot(resource: string, sectionId: string): SectionSnapshot | undefined;
  commit(
    resource: string,
    intents: readonly SectionIntent[],
    options: { readonly operationId: string },
  ): Promise<Receipt>;
  /** Definitive, across restarts: undefined means no part of the batch was committed (§3.4). */
  receiptOf(resource: string, operationId: string): Promise<Receipt | undefined>;
  releaseReceipt(resource: string, operationId: string): Promise<void>;
  canWrite(resource: string): WriteAccess;
}
