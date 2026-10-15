// The sync status of a shared section or Task, as one pure reducer
// (LFCP-02-057, OBSIDIAN-SYNC-INDICATORS-01 §2–§6, §10). Independent,
// verified facts go in; one view model comes out: the primary state by the
// documented priority, and every condition kept for the details card. It
// never writes anything: a status change makes no intent, no source edit
// and no history entry.
//
// Facts arrive as events (applyEvent): complete snapshots, ordered patches,
// unit acceptances and rejections, local batches. An event from another
// Resource session is ignored; a gap in the patch order asks for a new
// snapshot and shows the state as unknown meanwhile; an acceptance applies
// to exactly the units it names, so a duplicate changes nothing and an old
// one never clears a newer edit.

import type { HeldCause, HeldEdits, HeldPersistence } from "./held";
import type { HeldCheck } from "./held-checks";

/** The state keys of §6. */
export type StatusState =
  | "LOADING"
  | "LOCAL_EDIT"
  | "LOCAL_DURABLE"
  | "SENDING"
  | "ACCEPTED_CATCHING_UP"
  | "CURRENT"
  | "OFFLINE"
  | "EVIDENCE_UNKNOWN"
  | "ATTENTION"
  | "LOCAL_SAVE_FAILED"
  | "READ_ONLY_CURRENT";

/** One durable (or failed) local semantic commit, by its stable ID (§3, §4). */
export interface BatchFacts {
  readonly id: string;
  /** Nodes whose fields, Text or placement it changes; empty when not attributable. */
  readonly nodeIds: readonly string[];
  /** Committed to local storage (model, actor, outbound, journal). */
  readonly durable: boolean;
  /** The local commit failed: nothing of it is saved for sync (SI17). */
  readonly failed?: boolean;
  /** Its Data Units, all of which the server must accept. */
  readonly unitIds: readonly string[];
  readonly acceptedUnitIds: readonly string[];
  readonly rejection?: { readonly code: string; readonly unitIds: readonly string[] };
  /** False for pending work without a stable batch identity: it is not counted (§4). */
  readonly stable?: boolean;
}

export type SourceFacts =
  | "clean"
  | "editing"
  | "parsing"
  | "unsupported"
  | "binding-error"
  | "base-unknown"
  | "diverged";

/** One local projection of the section in a note (§3). */
export interface ProjectionFacts {
  readonly id: string;
  readonly source: SourceFacts;
  readonly application: "current" | "patch-pending" | "blocked" | "unavailable";
  /** Edits this projection holds back, not sent, and why (F-04). */
  readonly held?: HeldEdits;
}

export interface ModelProblemFacts {
  /** Structural or lifecycle (placement conflict, cycle, retained recovery) or a scalar conflict. */
  readonly kind: "structural" | "scalar";
  readonly code: string;
  readonly nodeIds: readonly string[];
}

export interface StatusFacts {
  /** The Resource session the facts belong to (route and control context). */
  readonly session: string;
  /** Local monotonic event generation, not a shared clock. */
  readonly revision: number;
  readonly replica: "not-loaded" | "importing" | "loaded" | "invalid-profile";
  /**
   * "refused": the server refuses this client the Resource (LFCP-02-115) and
   * says no reason, so it is shown as refused, never as revoked or waiting.
   */
  readonly access:
    | "writer"
    | "reader"
    | "unavailable-key"
    | "unknown"
    | "revoked"
    /** Never a member here (another identity, a Resource not shared with it): not "revoked" (F-C05). */
    | "not-member"
    | "refused";
  /**
   * The access answer's freshness (§6, F-C05): when the Control state it
   * comes from was verified (null: never), and whether that view is current
   * with the server's. Absent: not known yet.
   */
  readonly accessVerifiedAt?: number | null;
  readonly accessCurrent?: boolean | null;
  /** Control actions requested and not committed (SI14): shown as pending, never as done. */
  readonly pendingControl: readonly string[];
  /** The Control view is behind the server's (027): access is being checked. */
  readonly accessChecking?: boolean;
  /**
   * The section's connection (LFCP-03-005, F-C06): "connected" while its
   * Resource is open in a session; "connecting" and "failed" only from the
   * session's own transitions (an attempt under way; an attempt that ended
   * before READY); "offline" otherwise, with `connectionQualifier` saying
   * why when something did.
   */
  readonly connection: "offline" | "connecting" | "connected" | "failed";
  /** Why not connected (offline or failed); null: a failed attempt, no cause known; absent: no evidence. */
  readonly connectionQualifier?: ConnectionQualifier | null;
  /**
   * The server refuses the Resource for good (its code): not a connection
   * problem, so never shown as offline.
   */
  readonly refusal?: string;
  readonly catchUp: "not-started" | "receiving" | "current-at-checkpoint" | "unknown";
  readonly problems: readonly ModelProblemFacts[];
  readonly batches: readonly BatchFacts[];
  /** Whether a server acceptance mapping exists for this server and SDK (§4, SI19). */
  readonly acceptanceEvidence: "available" | "unavailable";
  readonly projections: readonly ProjectionFacts[];
  /**
   * Own offline work a Key Epoch cut off (§19.1, stale-work.ts): operations
   * being re-applied, and those waiting for the user's review.
   */
  readonly staleWork?: { readonly pending: number; readonly review: number };
  /**
   * Whether every note that holds a copy of the section was checked for
   * held edits since the start (LFCP-03-003, held-checks.ts): "pending",
   * some note not passed yet; "failed", its pass failed, so whether it
   * holds edits is unknown. Either way the section is never current.
   * Absent: checked.
   */
  readonly heldCheck?: HeldCheck;
}

/**
 * Why a section is not connected, from evidence only (LFCP-03-005):
 * - "no-evidence": its session reported no transition yet, or it has none (local only);
 * - "not-syncing": the session is READY, the section's Resource is not open
 *   on it (closed, blocked on a key or a Control fork, refused);
 * - "lost": it was connected, the connection went down; reconnecting;
 * - "network-offline": the system said the network is gone;
 * - "not-responding": the connection answered nothing and was dropped (liveness.ts).
 */
export type ConnectionQualifier =
  | "no-evidence"
  | "not-syncing"
  | "lost"
  | "network-offline"
  | "not-responding";

/** One reason the state is what it is; all of them stay in the details card. */
export type Condition =
  | { readonly kind: "save-failed"; readonly batchIds: readonly string[] }
  | { readonly kind: "access"; readonly access: StatusFacts["access"] }
  | { readonly kind: "server-refused"; readonly code: string }
  | { readonly kind: "invalid-profile" }
  | { readonly kind: "rejected"; readonly batchIds: readonly string[]; readonly code: string }
  | { readonly kind: "stale-work"; readonly pending: number; readonly review: number }
  | { readonly kind: "source"; readonly projectionId: string; readonly source: SourceFacts }
  | { readonly kind: "structural-conflict"; readonly nodeIds: readonly string[] }
  | { readonly kind: "scalar-conflict"; readonly nodeIds: readonly string[] }
  | { readonly kind: "loading" }
  /** Some note with a copy of the section was not checked for held edits yet (LFCP-03-003). */
  | { readonly kind: "held-unchecked" }
  /** Checking a note with a copy of the section failed: its held edits are unknown (LFCP-03-003). */
  | { readonly kind: "held-unknown" }
  | { readonly kind: "access-checking" }
  | { readonly kind: "catching-up" }
  | { readonly kind: "local-edit" }
  | { readonly kind: "offline" }
  /** The session is connecting (a real transition, LFCP-03-005): not current until it is up. */
  | { readonly kind: "connecting" }
  | { readonly kind: "pending"; readonly batches: number }
  | { readonly kind: "control-pending"; readonly actions: readonly string[] }
  | { readonly kind: "evidence-unavailable" };

export interface StatusView {
  readonly state: StatusState;
  /** Every condition found, in priority order; the first decided the state. */
  readonly conditions: readonly Condition[];
  /** Local batches durable and not yet accepted: the "N local updates waiting" count. */
  readonly pendingBatches: number;
  /** Every pending batch has a stable identity, so the count may be shown (§4). */
  readonly pendingCounted: boolean;
  /** Batches the server accepted, kept even while something else needs attention. */
  readonly acceptedBatches: number;
  /** Nodes with an unaccepted batch (§4: the union of their batches). */
  readonly pendingNodeIds: ReadonlySet<string>;
  /** Some pending batch has no node attribution: show section-level progress only. */
  readonly unattributed: boolean;
  /** No structural writes into the note while the model has a structural problem (SI08). */
  readonly projectionPaused: boolean;
  /** Per projection: its own state (a broken one does not drag a healthy one, SI12). */
  readonly projections: Readonly<Record<string, StatusState>>;
  readonly readOnly: boolean;
  /**
   * Edits held in notes, not sent (F-04): per projection, how many, why and
   * where. While any is held the section is never shown as current.
   */
  readonly held: readonly HeldEdits[];
  /** The tooltip of the primary state (§6). */
  readonly label: string;
  /** The separate sync facts a pane or card shows side by side (LFCP-03-003). */
  readonly sync: SyncFacts;
  /** This vault's access and its freshness, kept apart from the state (LFCP-03-005). */
  readonly access: AccessFacts;
  /** The section's connection (LFCP-03-005): never guessed, see StatusFacts.connection. */
  readonly connection: StatusFacts["connection"];
  /** Why not connected; null while connected or connecting, or for a failed attempt with no known cause. */
  readonly connectionQualifier: ConnectionQualifier | null;
  /** The server's code when it refuses the Resource for good; null otherwise. */
  readonly refusal: string | null;
}

/**
 * This vault's access to a section as a pane shows it (LFCP-03-005,
 * F-C05): each denial its own value (read-only is "reader"; revoked,
 * not-member, refused and unavailable-key stay apart), with the as-of of
 * the Control view it comes from. Unknown stays unknown (null), never a
 * default.
 */
export interface AccessFacts {
  readonly access: StatusFacts["access"];
  /** When the Control state the answer comes from was verified (local ms); null: never, or not known. */
  readonly verifiedAt: number | null;
  /** That view is current with the server's; false: behind it; null: no server said yet, or not known. */
  readonly current: boolean | null;
  /** Access is being checked with the server now (the view is behind it). */
  readonly checking: boolean;
}

/**
 * Held local source, the outbound queue and the shared model as separate
 * facts (LFCP-03-003, OBSIDIAN-UX-ARCHITECTURE-03 §5): never added up, and
 * an unknown count stays unknown.
 */
export interface SyncFacts {
  /** Durable local batches the server has not accepted yet, and their Data Units. */
  readonly queue: {
    readonly batches: number;
    /** Every waiting batch has a stable identity, so `batches` may be shown. */
    readonly counted: boolean;
    readonly units: number;
  };
  /** Edits held in notes, not sent and not queued. */
  readonly held: {
    /** Projections holding edits; null while some note was not checked yet. */
    readonly projections: number | null;
    /** Edits held; null when some copy's edits cannot be counted, or a note was not checked. */
    readonly edits: number | null;
    readonly causes: readonly HeldCause[];
    /**
     * Whether the notes holding them are saved to disk: "unsaved" when some
     * is not, "unknown" when some was not checked; null when nothing is held.
     */
    readonly persistence: HeldPersistence | null;
  };
  /**
   * Local saving of this vault's changes: failed (a commit failed), unconfirmed
   * (a commit in progress, or held edits not known to be on disk), confirmed.
   */
  readonly localPersistence: "confirmed" | "unconfirmed" | "failed";
  /**
   * Per projection (copy in a note): its own state, what it holds back and
   * whether that copy alone is current, for a pane's list of places.
   */
  readonly projections: readonly ProjectionSync[];
  /** The shared model as this device last checked it, whatever the notes hold. */
  readonly sharedModel: "accepted" | "catching-up" | "unknown";
  /**
   * The whole section is current: nothing held, unchecked, queued or
   * failing, and the shared model caught up. A pane says "current" only
   * when this holds.
   */
  readonly current: boolean;
}

export const STATE_LABEL: Readonly<Record<StatusState, string>> = {
  LOADING: "Loading shared section",
  LOCAL_EDIT: "Local changes are being processed",
  LOCAL_DURABLE: "Saved locally; waiting to sync",
  SENDING: "Sending local updates",
  ACCEPTED_CATCHING_UP: "Local updates accepted; receiving changes",
  CURRENT: "No pending local changes; current as last checked",
  OFFLINE: "Offline; local updates will wait",
  EVIDENCE_UNKNOWN: "Server confirmation unavailable",
  ATTENTION: "Needs your attention",
  LOCAL_SAVE_FAILED: "Changes are not safely saved for sync",
  READ_ONLY_CURRENT: "Shared section · read-only",
};

/** Offline with no evidence of it (no session reported a transition): not checked, never "Offline". */
export const NOT_CHECKED_LABEL = "Not checked with the server yet; local updates will wait";

const accepted = (b: BatchFacts) =>
  b.durable && b.unitIds.length > 0 && b.unitIds.every((u) => b.acceptedUnitIds.includes(u));
const pending = (b: BatchFacts) =>
  b.durable && !b.failed && b.rejection === undefined && !accepted(b);

const BROKEN_SOURCE: ReadonlySet<SourceFacts> = new Set([
  "unsupported",
  "binding-error",
  "base-unknown",
  "diverged",
]);

/** The view of `facts` (§5): pure; the same facts give the same view. */
export function statusView(facts: StatusFacts): StatusView {
  const c: Condition[] = [];
  // 1. Local persistence failure.
  const failed = facts.batches.filter((b) => b.failed === true);
  if (failed.length > 0) c.push({ kind: "save-failed", batchIds: failed.map((b) => b.id) });
  // 2. Access, key or control rejection; an invalid profile.
  if (
    facts.access === "revoked" ||
    facts.access === "not-member" ||
    facts.access === "refused" ||
    facts.access === "unavailable-key"
  )
    c.push({ kind: "access", access: facts.access });
  // An access refusal already says why; another refusal says its own.
  else if (facts.refusal !== undefined) c.push({ kind: "server-refused", code: facts.refusal });
  if (facts.replica === "invalid-profile") c.push({ kind: "invalid-profile" });
  const rejected = facts.batches.filter((b) => b.rejection !== undefined);
  if (rejected.length > 0)
    c.push({
      kind: "rejected",
      batchIds: rejected.map((b) => b.id),
      code: rejected[0]?.rejection?.code ?? "",
    });
  // Own work cut off by a Key Epoch: never current until re-applied or reviewed.
  if (facts.staleWork !== undefined && facts.staleWork.pending + facts.staleWork.review > 0)
    c.push({ kind: "stale-work", ...facts.staleWork });
  // 3. Broken or unknown source binding, unsupported syntax, divergence.
  for (const p of facts.projections)
    if (BROKEN_SOURCE.has(p.source))
      c.push({ kind: "source", projectionId: p.id, source: p.source });
    // Edits held back are never current (F-04), whatever the source says.
    else if (p.held !== undefined)
      c.push({ kind: "source", projectionId: p.id, source: "diverged" });
  // A note whose check failed may hold edits nobody can count: a problem, not progress.
  if (facts.heldCheck === "failed") c.push({ kind: "held-unknown" });
  // 4. Structural or lifecycle conflicts, then scalar conflicts.
  const nodes = (kind: ModelProblemFacts["kind"]) =>
    facts.problems.filter((p) => p.kind === kind).flatMap((p) => p.nodeIds);
  if (facts.problems.some((p) => p.kind === "structural"))
    c.push({ kind: "structural-conflict", nodeIds: nodes("structural") });
  if (facts.problems.some((p) => p.kind === "scalar"))
    c.push({ kind: "scalar-conflict", nodeIds: nodes("scalar") });
  // 5. Loading, unknown state, catch-up or projection in progress.
  const loading =
    facts.replica === "not-loaded" || facts.replica === "importing" || facts.access === "unknown";
  if (loading) c.push({ kind: "loading" });
  // Refused or removed, the Control view cannot catch up: nothing is being checked.
  if (
    facts.accessChecking === true &&
    facts.access !== "refused" &&
    facts.access !== "revoked" &&
    facts.access !== "not-member"
  )
    c.push({ kind: "access-checking" });
  const catching =
    facts.catchUp !== "current-at-checkpoint" ||
    facts.projections.some((p) => p.application === "patch-pending");
  // Catch-up is in progress only in a session: while not connected nothing
  // is caught up, and the offline condition (7) speaks, with the saved and
  // pending facts (SI03, SI09; orchestrator decision 2026-10-09 on §5). A
  // replica not loaded stays LOADING (above); CURRENT still needs a verified catch-up.
  if (!loading && catching && facts.connection === "connected") c.push({ kind: "catching-up" });
  // 6. Uncommitted source changes, a local commit in progress.
  if (
    facts.projections.some((p) => p.source === "editing" || p.source === "parsing") ||
    facts.batches.some((b) => !b.durable && b.failed !== true)
  )
    c.push({ kind: "local-edit" });
  // 7. Offline or a failed connection.
  if (
    facts.refusal === undefined &&
    facts.access !== "refused" &&
    (facts.connection === "offline" || facts.connection === "failed")
  )
    c.push({ kind: "offline" });
  // 8. Pending updates, control actions, evidence unavailable.
  const waiting = facts.batches.filter(pending);
  if (waiting.length > 0) c.push({ kind: "pending", batches: waiting.length });
  if (facts.pendingControl.length > 0)
    c.push({ kind: "control-pending", actions: facts.pendingControl });
  if (waiting.length > 0 && facts.acceptanceEvidence === "unavailable")
    c.push({ kind: "evidence-unavailable" });
  // A note not checked yet may hold edits: never current, but last, so
  // offline, sending and the rest still speak first.
  if (facts.heldCheck === "pending") c.push({ kind: "held-unchecked" });
  // A connection being made (LFCP-03-005): nothing is checked with the
  // server until it is up, so never current; last, like the check above.
  if (
    facts.refusal === undefined &&
    facts.access !== "refused" &&
    facts.connection === "connecting"
  )
    c.push({ kind: "connecting" });

  const readOnly = facts.access === "reader";
  const allAccepted = facts.batches.length > 0 && facts.batches.every(accepted);
  const connected = facts.connection === "connected";
  const state = primary(c, { readOnly, allAccepted, connected });
  const pendingNodeIds = new Set(waiting.flatMap((b) => b.nodeIds));
  const projections: Record<string, StatusState> = {};
  for (const p of facts.projections) {
    // A projection's own source and application; the Resource's other conditions apply to all.
    const own = c.filter(
      (x) =>
        !(x.kind === "source" && x.projectionId !== p.id) &&
        !(
          x.kind === "catching-up" &&
          p.application !== "patch-pending" &&
          facts.catchUp === "current-at-checkpoint"
        ),
    );
    projections[p.id] = primary(own, { readOnly, allAccepted, connected });
  }
  const held = facts.projections.flatMap((p) => (p.held === undefined ? [] : [p.held]));
  return {
    state,
    conditions: c,
    pendingBatches: waiting.length,
    pendingCounted: waiting.every((b) => b.stable !== false),
    acceptedBatches: facts.batches.filter(accepted).length,
    pendingNodeIds,
    unattributed: waiting.some((b) => b.nodeIds.length === 0),
    projectionPaused: facts.problems.some((p) => p.kind === "structural"),
    projections,
    readOnly,
    held,
    label:
      c[0]?.kind === "access-checking"
        ? "Access being checked with the server"
        : c[0]?.kind === "held-unchecked"
          ? "Checking notes for edits not sent"
          : c[0]?.kind === "connecting"
            ? "Connecting to the server"
            : c[0]?.kind === "offline" && facts.connection === "failed"
              ? "Could not connect to the server; local updates will wait"
              : c[0]?.kind === "offline" &&
                  (facts.connectionQualifier === undefined ||
                    facts.connectionQualifier === "no-evidence")
                ? NOT_CHECKED_LABEL
                : STATE_LABEL[state],
    sync: syncFacts(facts, c, state, waiting, held, projections),
    access: {
      access: facts.access,
      verifiedAt: facts.accessVerifiedAt ?? null,
      current: facts.accessCurrent ?? null,
      checking: c.some((x) => x.kind === "access-checking"),
    },
    connection: facts.connection,
    connectionQualifier:
      facts.connection === "connected" || facts.connection === "connecting"
        ? null
        : facts.connectionQualifier === undefined
          ? "no-evidence"
          : facts.connectionQualifier,
    refusal: facts.refusal ?? null,
  };
}

/** One copy's sync facts (LFCP-03-003). */
export interface ProjectionSync {
  readonly id: string;
  readonly state: StatusState;
  /** What it holds back, not sent; null: nothing (or not checked yet: see `checked`). */
  readonly held: HeldEdits | null;
  /** Its note was checked for held edits since the start. */
  readonly checked: boolean;
  /** This copy is current: its state quiet, nothing held, its note checked. */
  readonly current: boolean;
}

/** The separate sync facts of a view (LFCP-03-003): pure. */
function syncFacts(
  facts: StatusFacts,
  c: readonly Condition[],
  state: StatusState,
  waiting: readonly BatchFacts[],
  held: readonly HeldEdits[],
  states: Readonly<Record<string, StatusState>>,
): SyncFacts {
  const kinds = new Set(c.map((x) => x.kind));
  const checked = facts.heldCheck === undefined || facts.heldCheck === "checked";
  const persistence: HeldPersistence | null = !checked
    ? "unknown"
    : held.length === 0
      ? null
      : held.some((h) => h.persistence === "unsaved")
        ? "unsaved"
        : held.every((h) => h.persistence === "saved")
          ? "saved"
          : "unknown";
  const sharedModel: SyncFacts["sharedModel"] =
    facts.replica !== "loaded" || facts.catchUp === "unknown" || facts.catchUp === "not-started"
      ? "unknown"
      : facts.catchUp === "receiving" ||
          facts.projections.some((p) => p.application === "patch-pending")
        ? facts.connection === "connected"
          ? "catching-up"
          : "unknown"
        : "accepted";
  const localPersistence: SyncFacts["localPersistence"] = kinds.has("save-failed")
    ? "failed"
    : kinds.has("local-edit") || (persistence !== null && persistence !== "saved")
      ? "unconfirmed"
      : "confirmed";
  return {
    queue: {
      batches: waiting.length,
      counted: waiting.every((b) => b.stable !== false),
      units: waiting.reduce(
        (n, b) => n + b.unitIds.filter((u) => !b.acceptedUnitIds.includes(u)).length,
        0,
      ),
    },
    held: {
      projections: checked ? held.length : null,
      edits:
        !checked || held.some((h) => h.count === null)
          ? null
          : held.reduce((n, h) => n + (h.count ?? 0), 0),
      causes: [...new Set(held.map((h) => h.cause))],
      persistence,
    },
    projections: facts.projections.map((p) => {
      const own = states[p.id] ?? state;
      return {
        id: p.id,
        state: own,
        held: p.held ?? null,
        checked,
        current:
          (own === "CURRENT" || own === "READ_ONLY_CURRENT") && checked && p.held === undefined,
      };
    }),
    localPersistence,
    sharedModel,
    current:
      (state === "CURRENT" || state === "READ_ONLY_CURRENT") &&
      checked &&
      held.length === 0 &&
      waiting.length === 0 &&
      localPersistence === "confirmed" &&
      sharedModel === "accepted",
  };
}

/** The state of the first condition (§5 order), or the quiet one. */
function primary(
  c: readonly Condition[],
  o: { readonly readOnly: boolean; readonly allAccepted: boolean; readonly connected: boolean },
): StatusState {
  const first = c[0];
  if (first === undefined) return o.readOnly ? "READ_ONLY_CURRENT" : "CURRENT";
  switch (first.kind) {
    case "save-failed":
      return "LOCAL_SAVE_FAILED";
    case "access":
    case "server-refused":
    case "invalid-profile":
    case "rejected":
    case "stale-work":
    case "source":
    case "held-unknown":
    case "structural-conflict":
    case "scalar-conflict":
      return "ATTENTION";
    case "loading":
    case "held-unchecked":
    case "access-checking":
    case "connecting":
      return "LOADING";
    case "catching-up":
      return o.allAccepted ? "ACCEPTED_CATCHING_UP" : "LOADING";
    case "local-edit":
      return "LOCAL_EDIT";
    case "offline":
      return "OFFLINE";
    case "pending":
    case "control-pending":
      if (c.some((x) => x.kind === "evidence-unavailable")) return "EVIDENCE_UNKNOWN";
      // Saved here; sending once the session is up.
      return o.connected ? "SENDING" : "LOCAL_DURABLE";
    case "evidence-unavailable":
      return "EVIDENCE_UNKNOWN";
  }
}

/**
 * Nodes under `ancestor` with pending work, for a folded parent's aggregate
 * cue (SI13): the parent itself is pending only if a batch names it.
 */
export function pendingUnder(
  view: StatusView,
  descendants: readonly string[],
): { readonly any: boolean; readonly nodeIds: readonly string[] } {
  const nodeIds = descendants.filter((id) => view.pendingNodeIds.has(id));
  return { any: nodeIds.length > 0, nodeIds };
}

// ---- Events ----

export type StatusEvent =
  /** A complete snapshot: replaces everything, clears a gap. */
  | { readonly kind: "snapshot"; readonly facts: StatusFacts }
  /** An ordered patch: revision must follow the store's. */
  | {
      readonly kind: "patch";
      readonly session: string;
      readonly revision: number;
      readonly change: Partial<Omit<StatusFacts, "session" | "revision">>;
    }
  /** The server accepted these units (exact IDs). */
  | { readonly kind: "accepted"; readonly session: string; readonly unitIds: readonly string[] }
  | {
      readonly kind: "rejected";
      readonly session: string;
      readonly unitIds: readonly string[];
      readonly code: string;
    }
  /** A local batch as the SDK reports it now, new or replacing the one with its ID. */
  | { readonly kind: "batch"; readonly session: string; readonly batch: BatchFacts };

export interface StatusStore {
  readonly facts: StatusFacts;
  /** A patch was missed: show unknown until a snapshot comes (§3). */
  readonly needsSnapshot: boolean;
}

/** The store after `event`: pure. */
export function applyEvent(store: StatusStore, event: StatusEvent): StatusStore {
  if (event.kind === "snapshot") return { facts: event.facts, needsSnapshot: false };
  // Evidence of another Resource session is obsolete here.
  if (event.session !== store.facts.session) return store;
  const f = store.facts;
  switch (event.kind) {
    case "patch": {
      if (event.revision <= f.revision) return store;
      if (event.revision !== f.revision + 1)
        return {
          facts: { ...f, revision: event.revision, catchUp: "unknown" },
          needsSnapshot: true,
        };
      return { ...store, facts: { ...f, ...event.change, revision: event.revision } };
    }
    case "accepted": {
      const ids = new Set(event.unitIds);
      const batches = f.batches.map((b) => {
        const add = b.unitIds.filter((u) => ids.has(u) && !b.acceptedUnitIds.includes(u));
        return add.length === 0 ? b : { ...b, acceptedUnitIds: [...b.acceptedUnitIds, ...add] };
      });
      return { ...store, facts: { ...f, batches } };
    }
    case "rejected": {
      const ids = new Set(event.unitIds);
      const batches = f.batches.map((b) =>
        b.unitIds.some((u) => ids.has(u))
          ? { ...b, rejection: { code: event.code, unitIds: b.unitIds.filter((u) => ids.has(u)) } }
          : b,
      );
      return { ...store, facts: { ...f, batches } };
    }
    case "batch": {
      const known = f.batches.findIndex((b) => b.id === event.batch.id);
      if (known < 0) return { ...store, facts: { ...f, batches: [...f.batches, event.batch] } };
      // The SDK is the source of truth: the batch as reported now replaces it,
      // so units the server lost make it pending again (ADR 0008).
      const batches = f.batches.map((b, i) => (i === known ? event.batch : b));
      return { ...store, facts: { ...f, batches } };
    }
  }
}

/** The view of a store: unknown catch-up while a snapshot is awaited. */
export function storeView(store: StatusStore): StatusView {
  return statusView(store.needsSnapshot ? { ...store.facts, catchUp: "unknown" } : store.facts);
}
