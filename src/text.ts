/** Text helpers shared by the parsers and the matcher. */

export interface SplitText {
  lines: string[];
  /** Whether the text ended with a newline. */
  eofNewline: boolean;
}

export function toLF(text: string): string {
  return text.indexOf('\r') === -1 ? text : text.replace(/\r\n/g, '\n');
}

export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = text.indexOf('\r\n');
  if (crlf === -1) return '\n';
  const lf = text.indexOf('\n');
  return lf === crlf + 1 ? '\r\n' : '\n';
}

export function hasBom(text: string): boolean {
  return text.charCodeAt(0) === 0xfeff;
}

export function stripBom(text: string): string {
  return hasBom(text) ? text.slice(1) : text;
}

/** Split LF text into lines, recording whether it ended with a newline. */
export function splitText(text: string): SplitText {
  if (text === '') return { lines: [], eofNewline: true };
  const lines = text.split('\n');
  const eofNewline = lines[lines.length - 1] === '';
  if (eofNewline) lines.pop();
  return { lines, eofNewline };
}

export function joinText(lines: string[], eofNewline: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (eofNewline ? '\n' : '');
}

/** Split a search/replace body into lines; a single trailing newline does not add an empty line. */
export function bodyLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const UNICODE_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '…': '...',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
  '​': '', '‌': '', '‍': '', '﻿': '',
};
const UNICODE_RE = /[‘’‚‛′“”„‟″‐-―−…  -‍  　﻿]/g;

/** Map typographic punctuation and exotic spaces to ASCII. */
export function normalizeUnicode(s: string): string {
  return s.replace(UNICODE_RE, (ch) => UNICODE_MAP[ch] ?? ch);
}

export function leadingWhitespace(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

export function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** Dice coefficient over character bigrams, in [0, 1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const c = counts.get(bg);
    if (c) {
      overlap++;
      counts.set(bg, c - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/** True if the string looks like binary data rather than text. */
export function looksBinary(s: string): boolean {
  const n = Math.min(s.length, 8000);
  for (let i = 0; i < n; i++) if (s.charCodeAt(i) === 0) return true;
  return false;
}
