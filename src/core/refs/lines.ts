// Physical lines of a Markdown text with their line endings kept, so edits
// can reassemble the text byte for byte (CRLF, LF and CR all preserved).

export interface Line {
  /** The line's text, without its line ending. */
  readonly text: string;
  /** The line ending: "\r\n", "\n", "\r", or "" for a last line without one. */
  readonly eol: string;
}

/** Split `text` into physical lines. Joining text + eol restores `text`. */
export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  const re = /\r\n|\n|\r/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    lines.push({ text: text.slice(start, m.index), eol: m[0] });
    start = m.index + m[0].length;
  }
  if (start < text.length || lines.length === 0) lines.push({ text: text.slice(start), eol: "" });
  return lines;
}

export function joinLines(lines: readonly Line[]): string {
  return lines.map((l) => l.text + l.eol).join("");
}

/** The width of leading whitespace, tabs advancing to the next multiple of 4. */
export function indentWidth(text: string): number {
  let width = 0;
  for (const c of text) {
    if (c === " ") width += 1;
    else if (c === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

export function isBlank(text: string): boolean {
  return /^[ \t]*$/.test(text);
}
