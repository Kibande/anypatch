/** Lenient parser for unified and git diffs as language models write them. */

import type { FileOp, Hunk } from '../types';

interface Section {
  oldPath?: string | null;
  newPath?: string | null;
  gitA?: string;
  gitB?: string;
  isNew?: boolean;
  isDeleted?: boolean;
  renameFrom?: string;
  renameTo?: string;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@+\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@+/;

export function parseUnified(text: string, warnings: string[]): FileOp[] {
  const lines = text.split('\n');
  const ops: FileOp[] = [];
  let cur: Section | null = null;

  const flush = () => {
    if (cur) {
      const op = sectionToOp(cur, warnings);
      if (op) ops.push(op);
    }
    cur = null;
  };
  const section = (): Section => {
    if (!cur) cur = { hunks: [] };
    return cur;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      flush();
      const s = section();
      const paths = parseGitLine(line.slice('diff --git '.length));
      if (paths) {
        s.gitA = paths[0];
        s.gitB = paths[1];
      }
      i++;
      continue;
    }
    if (cur && /^(new file mode|deleted file mode|rename from |rename to |copy from |copy to |similarity index|dissimilarity index|index |old mode|new mode)/.test(line)) {
      const s: Section = cur;
      if (line.startsWith('new file mode')) s.isNew = true;
      else if (line.startsWith('deleted file mode')) s.isDeleted = true;
      else if (line.startsWith('rename from ')) s.renameFrom = unquote(line.slice(12).trim());
      else if (line.startsWith('rename to ')) s.renameTo = unquote(line.slice(10).trim());
      i++;
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      warnings.push(`Skipped binary diff: ${line}`);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const existing = cur as Section | null;
      if (existing && (existing.hunks.length > 0 || existing.oldPath !== undefined)) flush();
      const s = section();
      s.oldPath = parseHeaderPath(line.slice(4));
      s.newPath = parseHeaderPath(lines[i + 1].slice(4));
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const s = section();
      i = parseHunk(lines, i, s, warnings);
      continue;
    }
    i++;
  }
  flush();
  return ops;
}

function parseHunk(lines: string[], i: number, s: Section, warnings: string[]): number {
  const header = lines[i];
  const m = HUNK_HEADER.exec(header);
  const hunk: Hunk = { mode: 'lines', oldLines: [], newLines: [], ambiguity: 'first' };
  let oldCount = -1;
  let newCount = -1;
  if (m) {
    const oldStart = Number(m[1]);
    oldCount = m[2] === undefined ? 1 : Number(m[2]);
    newCount = m[4] === undefined ? 1 : Number(m[4]);
    hunk.lineHint = oldCount === 0 ? oldStart : Math.max(0, oldStart - 1);
  } else if (!/^@@+\s*(@@+.*)?$/.test(header) && !/^@@+\s+[^-]/.test(header)) {
    warnings.push(`Unrecognized hunk header: ${header}`);
  }
  i++;

  let oldSeen = 0;
  let newSeen = 0;
  let bareBlank = 0;
  let last: ' ' | '-' | '+' | null = null;
  let oldNoEol = false;
  let newNoEol = false;
  const countsDone = () => oldCount >= 0 && oldSeen >= oldCount && newSeen >= newCount;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('\\')) {
      if (last === '-') oldNoEol = true;
      else if (last === '+') newNoEol = true;
      else if (last === ' ') {
        oldNoEol = true;
        newNoEol = true;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@') || line.startsWith('diff --git ') || line.startsWith('```')) break;
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ') && (oldCount < 0 || countsDone())) break;

    const c = line[0];
    if (line === '') {
      if (countsDone()) break;
      hunk.oldLines.push('');
      hunk.newLines.push('');
      oldSeen++;
      newSeen++;
      bareBlank++;
      last = ' ';
    } else if (c === ' ') {
      hunk.oldLines.push(line.slice(1));
      hunk.newLines.push(line.slice(1));
      oldSeen++;
      newSeen++;
      bareBlank = 0;
      last = ' ';
    } else if (c === '-') {
      hunk.oldLines.push(line.slice(1));
      oldSeen++;
      bareBlank = 0;
      last = '-';
    } else if (c === '+') {
      hunk.newLines.push(line.slice(1));
      newSeen++;
      bareBlank = 0;
      last = '+';
    } else {
      break;
    }
    i++;
  }

  // Blank lines that trail a hunk are almost always separators, not context.
  if (bareBlank > 0 && (oldCount < 0 || oldSeen > oldCount || newSeen > newCount)) {
    const drop = oldCount < 0 ? bareBlank : Math.min(bareBlank, Math.max(oldSeen - oldCount, newSeen - newCount));
    hunk.oldLines.length -= drop;
    hunk.newLines.length -= drop;
  }

  if (newNoEol) hunk.eofNewline = false;
  else if (oldNoEol) hunk.eofNewline = true;

  if (hunk.oldLines.length || hunk.newLines.length) s.hunks.push(hunk);
  return i;
}

function sectionToOp(s: Section, warnings: string[]): FileOp | null {
  let oldPath = s.oldPath;
  let newPath = s.newPath;
  if (oldPath === undefined && newPath === undefined && s.gitA !== undefined) {
    oldPath = s.isNew ? null : s.gitA;
    newPath = s.isDeleted ? null : s.gitB;
  }
  const strip = (oldPath == null || oldPath.startsWith('a/')) && (newPath == null || newPath.startsWith('b/')) && !(oldPath == null && newPath == null);
  if (strip || s.gitA !== undefined) {
    if (oldPath && oldPath.startsWith('a/')) oldPath = oldPath.slice(2);
    if (newPath && newPath.startsWith('b/')) newPath = newPath.slice(2);
  }
  // Mixed prefixes ("--- a/x" with "+++ x") still mean the same file.
  if (oldPath && newPath && oldPath !== newPath) {
    if (oldPath.startsWith('a/') && oldPath.slice(2) === newPath) oldPath = newPath;
    else if (newPath.startsWith('b/') && newPath.slice(2) === oldPath) newPath = oldPath;
  }
  if (s.renameFrom) oldPath = s.renameFrom;
  if (s.renameTo) newPath = s.renameTo;

  const isNew = oldPath === null || (s.isNew === true && !s.hunks.some((h) => h.oldLines.length));
  const isDeleted = newPath === null || s.isDeleted === true;

  if (isNew && newPath) {
    const body: string[] = [];
    let eofNewline = true;
    for (const h of s.hunks) {
      body.push(...h.newLines);
      if (h.eofNewline === false) eofNewline = false;
    }
    const content = body.length ? body.join('\n') + (eofNewline ? '\n' : '') : '';
    return { type: 'create', path: newPath, content };
  }
  if (isDeleted && oldPath) return { type: 'delete', path: oldPath };

  const path = oldPath ?? newPath ?? '';
  const moveTo = oldPath && newPath && oldPath !== newPath ? newPath : undefined;
  if (!s.hunks.length && !moveTo) {
    if (path) warnings.push(`Diff for ${path} has no hunks; nothing to do.`);
    return null;
  }
  return { type: 'update', path, moveTo, hunks: s.hunks };
}

function parseHeaderPath(raw: string): string | null {
  let s = raw.replace(/\t.*$/, '');
  s = s.replace(/\s+\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?(\s*[+-]\d{4})?\s*$/, '');
  s = s.trim();
  s = unquote(s);
  if (s === '/dev/null' || s === 'dev/null' || s === 'a/dev/null' || s === 'b/dev/null') return null;
  return s;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\tn])/g, (_, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : c));
  }
  return s;
}

/** Split the "a/x b/y" part of a `diff --git` line, handling quoted paths and spaces. */
function parseGitLine(rest: string): [string, string] | null {
  rest = rest.trim();
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end > 0) {
      const a = unquote(rest.slice(0, end + 1));
      const b = unquote(rest.slice(end + 1).trim());
      return [a, b];
    }
  }
  // Prefer splitting where the second half starts with b/ and mirrors the first.
  const candidates: number[] = [];
  for (let k = rest.indexOf(' b/'); k !== -1; k = rest.indexOf(' b/', k + 1)) candidates.push(k);
  for (const k of candidates) {
    const a = rest.slice(0, k);
    const b = rest.slice(k + 1);
    if (a.slice(2) === b.slice(2)) return [a, b];
  }
  if (candidates.length) return [rest.slice(0, candidates[0]), rest.slice(candidates[0] + 1)];
  const parts = rest.split(' ');
  if (parts.length === 2) return [parts[0], parts[1]];
  return null;
}
