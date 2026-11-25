/** Line diffing (Myers O(ND)) and unified diff output. */

import { splitText, toLF } from './text';

export type DiffOp =
  | { kind: '='; a: number; b: number }
  | { kind: '-'; a: number }
  | { kind: '+'; b: number };

const MAX_EDIT_DISTANCE = 4000;

/** Shortest edit script turning `a` into `b`. */
export function diffArrays(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: '=', a: i, b: i });

  const middle = myers(a, b, start, endA, start, endB);
  if (middle) {
    ops.push(...middle);
  } else {
    for (let i = start; i < endA; i++) ops.push({ kind: '-', a: i });
    for (let j = start; j < endB; j++) ops.push({ kind: '+', b: j });
  }

  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ kind: '=', a: i, b: j });
  return ops;
}

function myers(
  a: readonly string[], b: readonly string[],
  a0: number, a1: number, b0: number, b1: number,
): DiffOp[] | null {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 && m === 0) return [];
  if (n === 0) return Array.from({ length: m }, (_, j) => ({ kind: '+' as const, b: b0 + j }));
  if (m === 0) return Array.from({ length: n }, (_, i) => ({ kind: '-' as const, a: a0 + i }));

  const max = n + m;
  const limit = Math.min(max, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;

  outer: for (let d = 0; d <= limit; d++) {
    // Snapshot v[-(d+1) .. d+1] as it stood before step d.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found === -1) return null;

  const rev: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d];
    const at = (k: number) => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      rev.push({ kind: '=', a: a0 + x, b: b0 + y });
    }
    if (d > 0) {
      if (x === prevX) rev.push({ kind: '+', b: b0 + y - 1 });
      else rev.push({ kind: '-', a: a0 + x - 1 });
    }
    x = prevX;
    y = prevY;
  }
  return rev.reverse();
}

/** Count added and removed lines between two versions (null = file absent). */
export function countChanges(before: string | null, after: string | null): { added: number; removed: number } {
  const a = before === null ? [] : withEofSentinel(toLF(before));
  const b = after === null ? [] : withEofSentinel(toLF(after));
  let added = 0;
  let removed = 0;
  for (const op of diffArrays(a, b)) {
    if (op.kind === '+') added++;
    else if (op.kind === '-') removed++;
  }
  return { added, removed };
}

const NO_EOL = '\u0000anypatch-no-eol';

function withEofSentinel(text: string): string[] {
  const { lines, eofNewline } = splitText(text);
  if (!eofNewline && lines.length) lines[lines.length - 1] += NO_EOL;
  return lines;
}

export interface UnifiedDiffOptions {
  /** Path shown on the `---` line (default: `newPath`, or "file"). */
  oldPath?: string;
  /** Path shown on the `+++` line (default: `oldPath`). */
  newPath?: string;
  /** Lines of context around each change (default 3). */
  context?: number;
  /** Prefix paths with a/ and b/ like git (default true). */
  gitPrefixes?: boolean;
}

/**
 * Create a unified diff between two versions of a file.
 * Pass null for `before` (new file) or `after` (deleted file).
 * Returns "" when the versions are identical.
 */
export function createUnifiedDiff(
  before: string | null,
  after: string | null,
  options: UnifiedDiffOptions = {},
): string {
  const context = Math.max(0, options.context ?? 3);
  const oldName = options.oldPath ?? options.newPath ?? 'file';
  const newName = options.newPath ?? oldName;
  const prefix = options.gitPrefixes ?? true;
  const a = before === null ? [] : withEofSentinel(toLF(before));
  const b = after === null ? [] : withEofSentinel(toLF(after));
  const ops = diffArrays(a, b);
  if (!ops.some((op) => op.kind !== '=')) return '';

  const out: string[] = [];
  out.push(`--- ${before === null ? '/dev/null' : (prefix ? 'a/' : '') + oldName}`);
  out.push(`+++ ${after === null ? '/dev/null' : (prefix ? 'b/' : '') + newName}`);

  // Group ops into hunks separated by more than 2*context unchanged lines.
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i].kind === '=') i++;
    if (i >= ops.length) break;
    let hunkStart = i;
    let ctx = 0;
    while (hunkStart > 0 && ctx < context && ops[hunkStart - 1].kind === '=') {
      hunkStart--;
      ctx++;
    }
    let j = i;
    let hunkEnd = i;
    while (j < ops.length) {
      if (ops[j].kind !== '=') {
        hunkEnd = j + 1;
        j++;
        continue;
      }
      let run = 0;
      while (j + run < ops.length && ops[j + run].kind === '=') run++;
      if (j + run >= ops.length || run > 2 * context) {
        hunkEnd = Math.min(j + context, j + run);
        break;
      }
      j += run;
    }
    const slice = ops.slice(hunkStart, hunkEnd);

    let oldStart = -1;
    let newStart = -1;
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    // Position of the first line on each side for empty-side headers.
    let aPos = 0;
    let bPos = 0;
    for (let p = 0; p < hunkStart; p++) {
      const op = ops[p];
      if (op.kind !== '+') aPos++;
      if (op.kind !== '-') bPos++;
    }
    const emit = (mark: string, line: string) => {
      if (line.endsWith(NO_EOL)) {
        body.push(mark + line.slice(0, -NO_EOL.length));
        body.push('\\ No newline at end of file');
      } else {
        body.push(mark + line);
      }
    };
    for (const op of slice) {
      if (op.kind === '=') {
        if (oldStart < 0) oldStart = op.a;
        if (newStart < 0) newStart = op.b;
        oldCount++;
        newCount++;
        emit(' ', a[op.a]);
      } else if (op.kind === '-') {
        if (oldStart < 0) oldStart = op.a;
        oldCount++;
        emit('-', a[op.a]);
      } else {
        if (newStart < 0) newStart = op.b;
        newCount++;
        emit('+', b[op.b]);
      }
    }
    const oldHead = oldCount === 0 ? `${aPos},0` : oldCount === 1 ? `${oldStart + 1}` : `${oldStart + 1},${oldCount}`;
    const newHead = newCount === 0 ? `${bPos},0` : newCount === 1 ? `${newStart + 1}` : `${newStart + 1},${newCount}`;
    out.push(`@@ -${oldHead} +${newHead} @@`);
    out.push(...body);
    i = hunkEnd;
  }
  return out.join('\n') + '\n';
}
