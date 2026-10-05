// `lfcp-ref` markers: MARKDOWN-REFS-01 for any Markdown editor adapter.
// See README.md in this directory.

export type { LineComments, RefComment } from "./comments";
export { joinLines, type Line, splitLines } from "./lines";
export {
  checkObjectType,
  formatObjectRef,
  type ObjectRef,
  type ObjectRefError,
  parseObjectRef,
  sameBinding,
} from "./object-ref";
export {
  type MarkdownProjectionRef,
  type Placement,
  parseTaskLine,
  type Range,
  type RefDiagnostic,
  type RefDiagnosticCode,
  type ScanResult,
  SUPPORTED_TYPES,
  scanRefs,
  type TaskLine,
  type TaskState,
  type UnitParts,
} from "./scanner";
export { attachRef, detachRef, emitUnit, formatRefComment, replaceTaskText } from "./serializer";
export { decodeResourceId, fromBase64Url, isObjectId, isObjectType, toBase64Url } from "./tokens";
