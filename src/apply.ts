/** Applying parsed patches to an in-memory view of the files. */

import type {
  ApplyOptions, EditInput, FileChange, FileOp, FileReader, Hunk, HunkResult, MatchLevel,
  OperationResult, ParsedPatch, PatchIssue, PatchResult,
} from './types';
import { parsePatch, PatchParseError } from './parse/index';
import {
  detectEol, hasBom, isBlank, joinText, looksBinary, normalizeUnicode, splitText, stripBom, toLF,
} from './text';
import {
  findAll, findFuzzy, findNormalized, levelChangesIndent, makeReindenter, pick, scoreWindows, strictLevels,
  type MatchConfig,
} from './match';
import { countChanges, diffArrays } from './diff';

export type PatchInput = string | ParsedPatch | EditInput | EditInput[];
export type FileSource = Record<string, string> | Map<string, string> | FileReader;

interface FileMeta {
  eol: '\n' | '\r\n';
  bom: boolean;
  original: string | null;
}

function isParsed(p: unknown): p is ParsedPatch {
  return !!p && typeof p === 'object' && !Array.isArray(p) && Array.isArray((p as ParsedPatch).ops) && 'format' in (p as object);
}

export function normalizePath(p: string): string {
  let s = p.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

function makeReader(source: FileSource): FileReader {
  if (typeof source === 'function') return source;
  if (source instanceof Map) return (p) => source.get(p);
  return (p) => (Object.prototype.hasOwnProperty.call(source, p) ? source[p] : undefined);
}

function configFrom(options: ApplyOptions): MatchConfig {
  let fuzzyThreshold: number | null = null;
  if (options.fuzzy === true) fuzzyThreshold = 0.9;
  else if (typeof options.fuzzy === 'number' && options.fuzzy > 0) fuzzyThreshold = Math.min(1, options.fuzzy);
  return {
    ignoreWhitespace: options.ignoreWhitespace ?? true,
    normalizeUnicode: options.normalizeUnicode ?? true,
    fuzzyThreshold,
  };
}

/**
 * Apply a patch to a set of files without touching the disk.
 *
 * @param patch  Patch text in any supported format, a ParsedPatch, or str_replace-style edit objects.
 * @param source File contents: a `{ path: content }` record, a Map, or a reader function.
 * @returns What changed, per file and per hunk, plus model-readable errors. Never throws for bad patches.
 */
export function applyPatch(patch: PatchInput, source: FileSource, options: ApplyOptions = {}): PatchResult {
  let parsed: ParsedPatch;
  try {
    parsed = isParsed(patch) ? patch : parsePatch(patch as string | EditInput | EditInput[], options);
  } catch (err) {
    const message = err instanceof PatchParseError ? err.message : `Could not parse the patch: ${(err as Error).message}`;
    return { ok: false, format: null, files: [], operations: [], errors: [{ code: 'PARSE_ERROR', message }], warnings: [] };
  }

  const read = makeReader(source);
  const config = configFrom(options);
  const engine: Engine = {
    config,
    maxTrim: Math.max(0, options.maxContextTrim ?? 2),
    detectApplied: options.detectAlreadyApplied ?? true,
  };
  const warnings = [...parsed.warnings];
  const errors: PatchIssue[] = [];
  const operations: OperationResult[] = [];
  const state = new Map<string, string | null>();
  const meta = new Map<string, FileMeta>();

  if (!parsed.ops.length) {
    errors.push({
      code: 'EMPTY_PATCH',
      message: 'The patch contains no file changes.',
      hint: warnings.length ? warnings.join('\n') : undefined,
    });
  }

  const load = (path: string): { content: string | null } | { error: PatchIssue } => {
    if (state.has(path)) return { content: state.get(path)! };
    let raw: unknown;
    try {
      raw = read(path);
    } catch (err) {
      return { error: { code: 'IO_ERROR', path, message: `Could not read ${path}: ${(err as Error).message}` } };
    }
    if (raw === null || raw === undefined) {
      meta.set(path, { eol: '\n', bom: false, original: null });
      state.set(path, null);
      return { content: null };
    }
    const text = typeof raw === 'string' ? raw : String(raw);
    if (looksBinary(text)) {
      return { error: { code: 'BINARY_FILE', path, message: `${path} is a binary file; it cannot be patched as text.` } };
    }
    meta.set(path, { eol: detectEol(text), bom: hasBom(text), original: text });
    const content = toLF(stripBom(text));
    state.set(path, content);
    return { content };
  };

  for (const op of parsed.ops) {
    const path = normalizePath(op.path || options.defaultPath || '');
    const result: OperationResult = { type: op.type, path, status: 'applied', hunks: [] };
    if (op.type === 'update' && op.moveTo) result.moveTo = normalizePath(op.moveTo);
    operations.push(result);
    const fail = (issue: PatchIssue) => {
      result.status = 'failed';
      errors.push(issue);
    };

    if (!path) {
      fail({
        code: 'NO_PATH',
        message: 'The patch does not say which file to change.',
        hint: hintForMissingPath(parsed.format),
      });
      continue;
    }
    const loaded = load(path);
    if ('error' in loaded) {
      fail(loaded.error);
      continue;
    }
    const current = loaded.content;

    if (op.type === 'create') {
      const content = toLF(op.content);
      if (current !== null && !op.overwrite) {
        if (current === content) {
          warnings.push(`${path} already exists with exactly this content; nothing to do.`);
        } else {
          fail({
            code: 'FILE_EXISTS',
            path,
            message: `Cannot create ${path}: the file already exists.`,
            hint: 'Change the existing file with an update (diff hunk / "*** Update File:" / SEARCH/REPLACE block) instead of creating it.',
          });
        }
        continue;
      }
      state.set(path, content);
      continue;
    }

    if (op.type === 'delete') {
      if (current === null) {
        fail({ code: 'FILE_NOT_FOUND', path, message: `Cannot delete ${path}: the file does not exist.` });
        continue;
      }
      state.set(path, null);
      continue;
    }

    // update
    if (current === null) {
      if (op.hunks.length && op.hunks.every((h) => h.oldLines.length === 0 && h.insertAfterLine === undefined && !(h.mode === 'text' && h.oldText))) {
        // Only insertions into a missing file (empty SEARCH block, "@@ -0,0 +1,n @@"): create it.
        const lines = op.hunks.flatMap((h) => h.newLines);
        state.set(path, joinText(lines, op.hunks[op.hunks.length - 1].eofNewline ?? true));
        result.type = 'create';
        result.hunks = op.hunks.map((_, k) => ({ index: k + 1, status: 'applied', match: 'exact', line: 1 }));
        continue;
      }
      fail({
        code: 'FILE_NOT_FOUND',
        path,
        message: `Cannot update ${path}: the file does not exist.`,
        hint: `Check the path. To create a new file, ${createHint(parsed.format)}`,
      });
      continue;
    }

    const out = applyHunks(current, op.hunks, path, engine);
    result.hunks = out.hunks;
    warnings.push(...out.warnings);
    if (out.errors.length) {
      result.status = 'failed';
      errors.push(...out.errors);
      continue;
    }

    if (result.moveTo && result.moveTo !== path) {
      const dest = load(result.moveTo);
      if ('error' in dest) {
        fail(dest.error);
        continue;
      }
      if (dest.content !== null) {
        fail({ code: 'FILE_EXISTS', path: result.moveTo, message: `Cannot move ${path} to ${result.moveTo}: the destination already exists.` });
        continue;
      }
      const src = meta.get(path)!;
      meta.set(result.moveTo, { eol: src.eol, bom: src.bom, original: null });
      state.set(path, null);
      state.set(result.moveTo, out.text);
    } else {
      state.set(path, out.text);
    }
  }

  const files: FileChange[] = [];
  for (const [path, content] of state) {
    const m = meta.get(path)!;
    const after = content === null ? null : (m.bom ? '﻿' : '') + (m.eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content);
    const before = m.original;
    if (before === after) continue;
    const type = before === null ? 'create' : after === null ? 'delete' : 'update';
    files.push({ path, type, before, after, ...countChanges(before, after) });
  }

  return { ok: errors.length === 0, format: parsed.format, files, operations, errors, warnings };
}

function hintForMissingPath(format: ParsedPatch['format']): string {
  switch (format) {
    case 'search-replace':
      return 'Put the file path on its own line directly above each SEARCH/REPLACE block (or pass defaultPath).';
    case 'v4a':
      return 'Start each file section with "*** Update File: path/to/file".';
    case 'edits':
      return 'Give each edit a "path".';
    default:
      return 'Start the diff with "--- a/path/to/file" and "+++ b/path/to/file" lines (or pass defaultPath).';
  }
}

function createHint(format: ParsedPatch['format']): string {
  switch (format) {
    case 'search-replace':
      return 'use a SEARCH/REPLACE block with an empty SEARCH section.';
    case 'v4a':
      return 'use "*** Add File: path" with every line prefixed by "+".';
    case 'edits':
      return 'use the create command with the full file text.';
    default:
      return 'use "--- /dev/null" and "+++ b/path" with every line prefixed by "+".';
  }
}

// ---------------------------------------------------------------------------
// Hunk application

interface Engine {
  config: MatchConfig;
  maxTrim: number;
  detectApplied: boolean;
}

interface HunksOutcome {
  text: string;
  hunks: HunkResult[];
  errors: PatchIssue[];
  warnings: string[];
}

interface Located {
  start: number;
  level: MatchLevel;
  top: number;
  bottom: number;
  outOfOrder: boolean;
}

type LocateOutcome = Located | { ambiguous: number[] } | null;

function applyHunks(content: string, hunks: Hunk[], path: string, engine: Engine): HunksOutcome {
  let { lines, eofNewline } = splitText(content);
  let cursor = 0;
  let delta = 0;
  const results: HunkResult[] = [];
  const errors: PatchIssue[] = [];
  const warnings: string[] = [];

  hunks.forEach((hunk, k) => {
    const index = k + 1;
    const where = `${path} hunk ${index}`;
    const independent = hunk.ambiguity === 'error';
    const hunkCursor = independent ? 0 : cursor;

    // Exact substring replacement for str_replace-style edits.
    if (hunk.mode === 'text' && hunk.oldText) {
      const text = joinText(lines, eofNewline);
      const r = replaceText(text, hunk, hunkCursor);
      if (r.kind === 'applied') {
        ({ lines, eofNewline } = splitText(r.text));
        if (r.text === '') eofNewline = false;
        cursor = r.cursorLine;
        results.push({ index, status: 'applied', match: 'exact', line: r.line + 1, occurrences: r.occurrences });
        return;
      }
      if (r.kind === 'ambiguous') {
        results.push({ index, status: 'failed' });
        errors.push(ambiguousIssue(path, index, r.lines, true));
        return;
      }
      // Fall through to line matching with loosened comparisons.
    }

    // Pure insertion: nothing to search for.
    if (hunk.oldLines.length === 0) {
      let at: number | undefined;
      let anchorFound = false;
      if (hunk.anchors?.length) {
        const a = seekAnchors(lines, hunk.anchors, hunkCursor, engine.config);
        anchorFound = a.found;
        if (a.found) at = a.cursor;
      }
      if (hunk.insertAfterLine !== undefined) {
        if (hunk.insertAfterLine > lines.length) {
          results.push({ index, status: 'failed' });
          errors.push({
            code: 'NO_MATCH', path, hunk: index,
            message: `Cannot insert after line ${hunk.insertAfterLine}: ${path} has only ${lines.length} lines.`,
          });
          return;
        }
        at = hunk.insertAfterLine;
      } else if (anchorFound) {
        // at already set
      } else if (hunk.atEof) {
        at = lines.length;
      } else if (hunk.lineHint !== undefined) {
        at = Math.min(Math.max(0, hunk.lineHint + delta), lines.length);
      } else if (lines.length === 0) {
        at = 0;
      }
      if (at === undefined) {
        results.push({ index, status: 'failed' });
        errors.push({
          code: 'NO_MATCH', path, hunk: index,
          message: 'This hunk only adds lines and has no unchanged context lines, so there is no way to tell where it goes.',
          hint: 'Include 2-3 unchanged lines from the file around the insertion point.',
        });
        return;
      }
      const touchesEnd = at === lines.length;
      lines.splice(at, 0, ...hunk.newLines);
      if (touchesEnd && hunk.eofNewline !== undefined) eofNewline = hunk.eofNewline;
      cursor = at + hunk.newLines.length;
      delta += hunk.newLines.length;
      results.push({ index, status: 'applied', match: 'exact', line: at + 1 });
      return;
    }

    let searchFrom = hunkCursor;
    if (hunk.anchors?.length) {
      const a = seekAnchors(lines, hunk.anchors, hunkCursor, engine.config);
      if (a.found) searchFrom = a.cursor;
      else warnings.push(`${where}: anchor "@@ ${hunk.anchors.join(' / ')}" not found; searched the whole file.`);
    }
    const hint = hunk.lineHint !== undefined ? hunk.lineHint + delta : undefined;
    const skipExact = hunk.mode === 'text';

    if (hunk.replaceAll) {
      const all = locateAll(lines, hunk.oldLines, engine.config, skipExact);
      if (!all) {
        results.push({ index, status: 'failed' });
        errors.push(noMatchIssue(path, index, lines, hunk.oldLines, true));
        return;
      }
      const { positions, level } = all;
      for (let p = positions.length - 1; p >= 0; p--) {
        const start = positions[p];
        const slice = lines.slice(start, start + hunk.oldLines.length);
        lines.splice(start, hunk.oldLines.length, ...buildReplacement(hunk.oldLines, hunk.newLines, slice, level));
      }
      results.push({ index, status: 'applied', match: level, line: positions[0] + 1, occurrences: positions.length });
      return;
    }

    const found = locate(lines, hunk.oldLines, hunk.newLines, {
      cursor: searchFrom, hint, atEof: hunk.atEof, ambiguity: hunk.ambiguity, skipExact,
    }, engine);

    if (found && 'ambiguous' in found) {
      results.push({ index, status: 'failed' });
      errors.push(ambiguousIssue(path, index, found.ambiguous, hunk.mode === 'text'));
      return;
    }

    if (!found) {
      if (engine.detectApplied && hasRealAddition(hunk.oldLines, hunk.newLines)) {
        const again = locate(lines, hunk.newLines, hunk.newLines, {
          cursor: 0, hint, atEof: hunk.atEof, ambiguity: 'first', skipExact: false, noTrim: true,
        }, { ...engine, config: { ...engine.config, fuzzyThreshold: null } });
        if (again && !('ambiguous' in again)) {
          cursor = again.start + hunk.newLines.length;
          results.push({ index, status: 'already-applied', line: again.start + 1 });
          warnings.push(`${where}: the change is already in the file (line ${again.start + 1}); skipped it.`);
          return;
        }
      }
      results.push({ index, status: 'failed' });
      errors.push(noMatchIssue(path, index, lines, hunk.oldLines, hunk.mode === 'text'));
      return;
    }

    const { start, level, top, bottom } = found;
    const oldL = hunk.oldLines.slice(top, hunk.oldLines.length - bottom);
    const newL = hunk.newLines.slice(top, hunk.newLines.length - bottom);
    const slice = lines.slice(start, start + oldL.length);
    const replacement = buildReplacement(oldL, newL, slice, level);
    const touchesEnd = start + oldL.length === lines.length;
    lines.splice(start, oldL.length, ...replacement);
    if (touchesEnd && hunk.eofNewline !== undefined) eofNewline = hunk.eofNewline;
    cursor = start + replacement.length;
    delta += replacement.length - oldL.length;

    const res: HunkResult = { index, status: 'applied', match: level, line: start + 1 };
    if (top + bottom > 0) res.contextTrimmed = top + bottom;
    results.push(res);
    if (found.outOfOrder && !independent) warnings.push(`${where} matched above the previous hunk (line ${start + 1}); hunks may be out of order.`);
  });

  return { text: joinText(lines, eofNewline), hunks: results, errors, warnings };
}

type TextReplace =
  | { kind: 'applied'; text: string; line: number; cursorLine: number; occurrences: number }
  | { kind: 'ambiguous'; lines: number[] }
  | { kind: 'none' };

function replaceText(text: string, hunk: Hunk, cursorLine: number): TextReplace {
  const oldText = hunk.oldText!;
  const newText = hunk.newText ?? '';
  const positions: number[] = [];
  for (let p = text.indexOf(oldText); p !== -1; p = text.indexOf(oldText, p + oldText.length)) positions.push(p);
  if (!positions.length) return { kind: 'none' };

  const lineOf = (pos: number) => {
    let n = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) n++;
    return n;
  };
  const newlines = (s: string) => s.split('\n').length - 1;

  if (hunk.replaceAll) {
    const out = text.split(oldText).join(newText);
    return { kind: 'applied', text: out, line: lineOf(positions[0]), cursorLine: 0, occurrences: positions.length };
  }
  let chosen = positions[0];
  if (positions.length > 1) {
    if (hunk.ambiguity === 'error') return { kind: 'ambiguous', lines: positions.map(lineOf) };
    chosen = positions.find((p) => lineOf(p) >= cursorLine) ?? positions[0];
  }
  const out = text.slice(0, chosen) + newText + text.slice(chosen + oldText.length);
  const line = lineOf(chosen);
  return { kind: 'applied', text: out, line, cursorLine: line + newlines(newText), occurrences: 1 };
}

interface LocateContext {
  cursor: number;
  hint?: number;
  atEof?: boolean;
  ambiguity: 'first' | 'error';
  skipExact: boolean;
  noTrim?: boolean;
}

function locate(lines: string[], oldL: string[], newL: string[], ctx: LocateContext, engine: Engine): LocateOutcome {
  let shared = 0;
  while (shared < oldL.length && shared < newL.length && oldL[shared] === newL[shared]) shared++;
  let sharedEnd = 0;
  while (
    sharedEnd < oldL.length - shared && sharedEnd < newL.length - shared &&
    oldL[oldL.length - 1 - sharedEnd] === newL[newL.length - 1 - sharedEnd]
  ) sharedEnd++;

  const levels = strictLevels(engine.config).filter(([level]) => !(ctx.skipExact && level === 'exact'));
  const hayCache = new Map<MatchLevel, string[]>();
  const hayFor = (level: MatchLevel, norm: (s: string) => string) => {
    let h = hayCache.get(level);
    if (!h) hayCache.set(level, (h = lines.map(norm)));
    return h;
  };
  const maxTrim = ctx.noTrim ? 0 : engine.maxTrim;

  // Trim combinations, fewest dropped lines first: (0,0), (1,0), (0,1), (1,1), (2,0), ...
  const trims: Array<[number, number]> = [];
  for (let top = 0; top <= Math.min(maxTrim, shared); top++) {
    for (let bottom = 0; bottom <= Math.min(maxTrim, sharedEnd); bottom++) trims.push([top, bottom]);
  }
  trims.sort((x, y) => x[0] + x[1] - (y[0] + y[1]) || Math.max(...x) - Math.max(...y));

  for (const [top, bottom] of trims) {
    const t = top + bottom;
    const needle = oldL.slice(top, oldL.length - bottom);
    if (!needle.length || (t > 0 && needle.every(isBlank))) continue;

    for (const [level, norm] of levels) {
      const positions = findNormalized(hayFor(level, norm), needle.map(norm));
      if (!positions.length) continue;
      const r = pick(positions, {
        cursor: ctx.cursor,
        hint: ctx.hint !== undefined ? ctx.hint + top : undefined,
        atEof: ctx.atEof && bottom === 0,
        ambiguity: ctx.ambiguity,
        needleLength: needle.length,
        fileLength: lines.length,
        requireUnique: t > 0,
      });
      if (r.ok) return { start: r.start, level, top, bottom, outOfOrder: r.outOfOrder };
      if (t === 0) return { ambiguous: r.ambiguous };
      break; // ambiguous after trimming: looser levels will not help; try another trim
    }
  }

  if (engine.config.fuzzyThreshold !== null) {
    const positions = findFuzzy(lines, oldL, engine.config.fuzzyThreshold);
    if (positions.length) {
      const r = pick(positions, {
        cursor: ctx.cursor, hint: ctx.hint, atEof: ctx.atEof, ambiguity: ctx.ambiguity,
        needleLength: oldL.length, fileLength: lines.length, requireUnique: true,
      });
      if (r.ok) return { start: r.start, level: 'fuzzy', top: 0, bottom: 0, outOfOrder: r.outOfOrder };
    }
  }
  return null;
}

function locateAll(lines: string[], needle: string[], config: MatchConfig, skipExact: boolean): { positions: number[]; level: MatchLevel } | null {
  for (const [level, norm] of strictLevels(config)) {
    if (skipExact && level === 'exact') continue;
    const found = findAll(lines, needle, norm);
    if (!found.length) continue;
    const positions: number[] = [];
    let next = 0;
    for (const p of found) {
      if (p >= next) {
        positions.push(p);
        next = p + needle.length;
      }
    }
    return { positions, level };
  }
  return null;
}

/**
 * Lines to write in place of the matched block. Unchanged context lines keep the
 * file's own text; new lines are re-indented when the match ignored indentation.
 */
function buildReplacement(oldL: string[], newL: string[], fileSlice: string[], level: MatchLevel): string[] {
  if (level === 'exact') return newL.slice();
  const reindent = levelChangesIndent(level) ? makeReindenter(oldL, fileSlice) : (l: string) => l;
  const out: string[] = [];
  for (const op of diffArrays(oldL, newL)) {
    if (op.kind === '=') out.push(fileSlice[op.a]);
    else if (op.kind === '+') out.push(reindent(newL[op.b]));
  }
  return out;
}

function seekAnchors(lines: string[], anchors: string[], from: number, config: MatchConfig): { found: boolean; cursor: number } {
  let cursor = from;
  for (const anchor of anchors) {
    let idx = -1;
    for (const [, norm] of strictLevels(config)) {
      const a = norm(anchor);
      for (let i = cursor; i < lines.length; i++) {
        if (norm(lines[i]) === a) {
          idx = i;
          break;
        }
      }
      if (idx !== -1) break;
    }
    if (idx === -1) {
      const a = normalizeUnicode(anchor).trim();
      if (a) {
        for (let i = cursor; i < lines.length; i++) {
          if (normalizeUnicode(lines[i]).includes(a)) {
            idx = i;
            break;
          }
        }
      }
    }
    if (idx === -1) return { found: false, cursor: from };
    cursor = idx + 1;
  }
  return { found: true, cursor };
}

function hasRealAddition(oldL: string[], newL: string[]): boolean {
  return diffArrays(oldL, newL).some((op) => op.kind === '+' && !isBlank(newL[op.b]));
}

// ---------------------------------------------------------------------------
// Model-facing diagnostics

const MAX_SHOWN = 12;

function noMatchIssue(path: string, index: number, lines: string[], needle: string[], textMode: boolean): PatchIssue {
  const parts: string[] = [];
  parts.push(textMode ? 'Text the edit expected to find:' : 'Lines the patch expected (context and removed lines):');
  for (const l of needle.slice(0, MAX_SHOWN)) parts.push(`  | ${l}`);
  if (needle.length > MAX_SHOWN) parts.push(`  | ... (${needle.length - MAX_SHOWN} more lines)`);

  const best = scoreWindows(lines, needle, 1)[0];
  if (best && best.score >= 0.35) {
    const from = best.start;
    const to = Math.min(lines.length, from + Math.max(needle.length, 1));
    const shownTo = Math.min(to, from + MAX_SHOWN + 4);
    const width = String(shownTo).length;
    parts.push(`Closest match in the current file is lines ${from + 1}-${to} (${Math.round(best.score * 100)}% similar); lines marked ">" differ:`);
    for (let i = from; i < shownTo; i++) {
      const differs = (needle[i - from] ?? '').trim() !== lines[i].trim();
      parts.push(`${differs ? '>' : ' '} ${String(i + 1).padStart(width)} | ${lines[i]}`);
    }
    if (shownTo < to) parts.push(`  ... (${to - shownTo} more lines)`);
  } else {
    parts.push('Nothing similar exists in the current file. It may have changed since you read it, or the change belongs in a different file.');
  }
  parts.push('Re-read the file and copy the unchanged and removed lines exactly as they appear now.');
  return {
    code: 'NO_MATCH',
    path,
    hunk: index,
    message: textMode ? 'Could not find the text to replace.' : 'Could not find the lines this hunk changes.',
    hint: parts.join('\n'),
  };
}

function ambiguousIssue(path: string, index: number, at: number[], textMode: boolean): PatchIssue {
  const shown = at.slice(0, 8).map((l) => l + 1);
  const where = shown.join(', ') + (at.length > shown.length ? ', ...' : '');
  return {
    code: 'AMBIGUOUS',
    path,
    hunk: index,
    message: `The ${textMode ? 'text to replace appears' : 'lines to replace appear'} ${at.length} times (at lines ${where}).`,
    hint: `Include more surrounding lines so the match is unique${textMode ? ', or set replace_all to change every occurrence' : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// Convenience

export class PatchApplyError extends Error {
  readonly result: PatchResult;
  constructor(message: string, result: PatchResult) {
    super(message);
    this.name = 'PatchApplyError';
    this.result = result;
  }
}

/**
 * Apply a patch to a single string and return the new string.
 * File paths in the patch are ignored: every hunk is applied to `content`.
 * Throws PatchApplyError (with `.result`) if anything fails.
 */
export function applyToString(content: string, patch: PatchInput, options: ApplyOptions = {}): string {
  const key = '\u0000input';
  let parsed: ParsedPatch;
  try {
    parsed = isParsed(patch) ? patch : parsePatch(patch as string | EditInput | EditInput[], options);
  } catch (err) {
    const result: PatchResult = {
      ok: false, format: null, files: [], operations: [], warnings: [],
      errors: [{ code: 'PARSE_ERROR', message: (err as Error).message }],
    };
    throw new PatchApplyError((err as Error).message, result);
  }
  const ops: FileOp[] = parsed.ops.map((op): FileOp => {
    if (op.type === 'update') return { ...op, path: key, moveTo: undefined };
    if (op.type === 'create') return { ...op, path: key, overwrite: true };
    return { ...op, path: key };
  });
  const result = applyPatch({ ...parsed, ops }, { [key]: content }, options);
  for (const e of result.errors) if (e.path === key) e.path = undefined;
  for (const o of result.operations) o.path = '';
  if (!result.ok) {
    const first = result.errors[0];
    throw new PatchApplyError(
      [first.message, first.hint].filter(Boolean).join('\n'),
      result,
    );
  }
  const change = result.files.find((f) => f.path === key);
  if (!change) return content;
  return change.after ?? '';
}
