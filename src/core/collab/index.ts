// The collaboration commands' Obsidian-free core (LFCP-065).

export {
  attachToTask,
  detachExact,
  planShare,
  type SharePlan,
  type TaskAt,
  taskAt,
  unitPlacement,
} from "./markdown";
export { codeOf, plainCode, plainError } from "./messages";
export { DEFAULT_CLAIM_LIMIT, INVITE_PRESETS, type InvitePreset } from "./presets";
export {
  CollabError,
  Collaboration,
  type CollabRuntime,
  type ConflictView,
  type CreatedCollaboration,
  type HostOutcome,
  type Invitation,
  type JoinOutcome,
  type JoinStage,
  type ResourceStatus,
  type TaskChoice,
} from "./service";
