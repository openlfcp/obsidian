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
  readonly access: "writer" | "reader" | "unavailable-key" | "unknown" | "revoked";
  /** Control actions requested and not committed (SI14): shown as pending, never as done. */
  readonly pendingControl: readonly string[];
  readonly connection: "offline" | "connecting" | "connected" | "failed";
  readonly catchUp: "not-started" | "receiving" | "current-at-checkpoint" | "unknown";
  readonly problems: readonly ModelProblemFacts[];
  readonly batches: readonly BatchFacts[];
  /** Whether a server acceptance mapping exists for this server and SDK (§4, SI19). */
  readonly acceptanceEvidence: "available" | "unavailable";
  readonly projections: readonly ProjectionFacts[];
}

/** One reason the state is what it is; all of them stay in the details card. */
export type Condition =
  | { readonly kind: "save-failed"; readonly batchIds: readonly string[] }
  | { readonly kind: "access"; readonly access: StatusFacts["access"] }
  | { readonly kind: "invalid-profile" }
  | { readonly kind: "rejected"; readonly batchIds: readonly string[]; readonly code: string }
  | { readonly kind: "source"; readonly projectionId: string; readonly source: SourceFacts }
  | { readonly kind: "structural-conflict"; readonly nodeIds: readonly string[] }
  | { readonly kind: "scalar-conflict"; readonly nodeIds: readonly string[] }
  | { readonly kind: "loading" }
  | { readonly kind: "catching-up" }
  | { readonly kind: "local-edit" }
  | { readonly kind: "offline" }
  | { readonly kind: "pending"; readonly batches: number }
  | { readonly kind: "control-pending"; readonly actions: readonly string[] }
  | { readonly kind: "evidence-unavailable" };

export interface StatusView {
  readonly state: StatusState;
  /** Every condition found, in priority order; the first decided the state. */
  readonly conditions: readonly Condition[];
  /** Local batches durable and not yet accepted: the "N local updates waiting" count. */
  readonly pendingBatches: number;
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
  /** The tooltip of the primary state (§6). */
  readonly label: string;
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
  if (facts.access === "revoked" || facts.access === "unavailable-key")
    c.push({ kind: "access", access: facts.access });
  if (facts.replica === "invalid-profile") c.push({ kind: "invalid-profile" });
  const rejected = facts.batches.filter((b) => b.rejection !== undefined);
  if (rejected.length > 0)
    c.push({
      kind: "rejected",
      batchIds: rejected.map((b) => b.id),
      code: rejected[0]?.rejection?.code ?? "",
    });
  // 3. Broken or unknown source binding, unsupported syntax, divergence.
  for (const p of facts.projections)
    if (BROKEN_SOURCE.has(p.source))
      c.push({ kind: "source", projectionId: p.id, source: p.source });
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
  const catching =
    facts.catchUp !== "current-at-checkpoint" ||
    facts.projections.some((p) => p.application === "patch-pending");
  if (!loading && catching) c.push({ kind: "catching-up" });
  // 6. Uncommitted source changes, a local commit in progress.
  if (
    facts.projections.some((p) => p.source === "editing" || p.source === "parsing") ||
    facts.batches.some((b) => !b.durable && b.failed !== true)
  )
    c.push({ kind: "local-edit" });
  // 7. Offline or a failed connection.
  if (facts.connection === "offline" || facts.connection === "failed") c.push({ kind: "offline" });
  // 8. Pending updates, control actions, evidence unavailable.
  const waiting = facts.batches.filter(pending);
  if (waiting.length > 0) c.push({ kind: "pending", batches: waiting.length });
  if (facts.pendingControl.length > 0)
    c.push({ kind: "control-pending", actions: facts.pendingControl });
  if (waiting.length > 0 && facts.acceptanceEvidence === "unavailable")
    c.push({ kind: "evidence-unavailable" });

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
  return {
    state,
    conditions: c,
    pendingBatches: waiting.length,
    acceptedBatches: facts.batches.filter(accepted).length,
    pendingNodeIds,
    unattributed: waiting.some((b) => b.nodeIds.length === 0),
    projectionPaused: facts.problems.some((p) => p.kind === "structural"),
    projections,
    readOnly,
    label: STATE_LABEL[state],
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
    case "invalid-profile":
    case "rejected":
    case "source":
    case "structural-conflict":
    case "scalar-conflict":
      return "ATTENTION";
    case "loading":
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
  /** A local batch, new or updated (by its ID: a retry of the same batch is the same batch). */
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
      const old = f.batches[known] as BatchFacts;
      // The same batch again: its units and acceptances only grow.
      const merged: BatchFacts = {
        ...event.batch,
        unitIds: [...new Set([...old.unitIds, ...event.batch.unitIds])],
        acceptedUnitIds: [...new Set([...old.acceptedUnitIds, ...event.batch.acceptedUnitIds])],
      };
      const batches = f.batches.map((b, i) => (i === known ? merged : b));
      return { ...store, facts: { ...f, batches } };
    }
  }
}

/** The view of a store: unknown catch-up while a snapshot is awaited. */
export function storeView(store: StatusStore): StatusView {
  return statusView(store.needsSnapshot ? { ...store.facts, catchUp: "unknown" } : store.facts);
}
