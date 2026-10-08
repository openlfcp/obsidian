// Text positions for shared sections (LFCP-02-036). The editor and the
// note use UTF-16 offsets (JavaScript strings, CodeMirror); the profile's
// Text intents use Unicode scalar positions (SHARED-SECTIONS-PROFILE-01 §10).
// Conversions are exact and refuse lone surrogates, which are invalid in
// shared text (§4).

/** A scalar position or length that a UTF-16 offset cannot express (inside a surrogate pair). */
export class TextPositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextPositionError";
  }
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Whether `text` is valid Unicode: no lone surrogate. */
export function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isHigh(c)) {
      if (!isLow(text.charCodeAt(i + 1))) return false;
      i++;
    } else if (isLow(c)) return false;
  }
  return true;
}

/** The number of Unicode scalars in `text`. */
export function scalarLength(text: string): number {
  return utf16ToScalar(text, text.length);
}

/** The scalar position of UTF-16 `offset` in `text`. Throws inside a pair or on a lone surrogate. */
export function utf16ToScalar(text: string, offset: number): number {
  if (offset < 0 || offset > text.length)
    throw new TextPositionError(`offset ${offset} out of range`);
  let scalars = 0;
  for (let i = 0; i < offset; i++) {
    const c = text.charCodeAt(i);
    if (isHigh(c)) {
      if (!isLow(text.charCodeAt(i + 1))) throw new TextPositionError("lone surrogate");
      if (i + 1 === offset) throw new TextPositionError(`offset ${offset} splits a surrogate pair`);
      i++;
    } else if (isLow(c)) throw new TextPositionError("lone surrogate");
    scalars++;
  }
  return scalars;
}

/** The UTF-16 offset of scalar position `index` in `text`. */
export function scalarToUtf16(text: string, index: number): number {
  if (index < 0) throw new TextPositionError(`index ${index} out of range`);
  let scalars = 0;
  let i = 0;
  while (scalars < index) {
    if (i >= text.length) throw new TextPositionError(`index ${index} out of range`);
    const c = text.charCodeAt(i);
    if (isHigh(c)) {
      if (!isLow(text.charCodeAt(i + 1))) throw new TextPositionError("lone surrogate");
      i += 2;
    } else if (isLow(c)) throw new TextPositionError("lone surrogate");
    else i++;
    scalars++;
  }
  return i;
}

/** One Text edit in scalar positions: delete `deleteCount` scalars at `index`, then insert `insert`. */
export interface TextEdit {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
}

/**
 * The single edit that turns `before` into `after`: the longest common
 * prefix and suffix are kept (in scalars, never splitting a pair). Null
 * when they are equal.
 */
export function diffText(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  const a = Array.from(before);
  const b = Array.from(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { index: start, deleteCount: endA - start, insert: b.slice(start, endB).join("") };
}

/** Applies a scalar edit to `text` (for tests and rebuilding expected Text). */
export function applyTextEdit(text: string, edit: TextEdit): string {
  const s = Array.from(text);
  if (edit.index + edit.deleteCount > s.length) throw new TextPositionError("edit out of range");
  return [...s.slice(0, edit.index), edit.insert, ...s.slice(edit.index + edit.deleteCount)].join(
    "",
  );
}
