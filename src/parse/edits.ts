/**
 * Object-style edits: Anthropic's text editor tool (str_replace / create / insert),
 * Claude Code style Edit/Write calls, and similar { path, old, new } shapes.
 */

import type { EditInput, FileOp, Hunk, ParsedPatch } from '../types';
import { bodyLines, toLF } from '../text';
import { parseV4A } from './v4a';

function first<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const v of values) if (v !== undefined && v !== null) return v;
  return undefined;
}

const OPENAI_OPS = new Set(['create_file', 'update_file', 'delete_file']);

export function isEditLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (o.type === 'apply_patch_call' && o.operation) return isEditLike(o.operation);
  if (typeof o.type === 'string' && OPENAI_OPS.has(o.type) && typeof o.path === 'string') return true;
  const hasPath = ['path', 'file_path', 'filePath', 'file'].some((k) => typeof o[k] === 'string');
  const hasBody = ['old_str', 'old_string', 'oldText', 'search', 'file_text', 'content', 'new_str', 'new_string', 'newText', 'command']
    .some((k) => k in o);
  return hasPath && hasBody;
}

export function parseEdits(input: EditInput | EditInput[]): ParsedPatch {
  const list = Array.isArray(input) ? input : [input];
  const ops: FileOp[] = [];
  const warnings: string[] = [];

  list.forEach((item, n) => {
    const e: EditInput = item.type === 'apply_patch_call' && item.operation ? item.operation : item;
    const path = first(e.path, e.file_path, e.filePath, e.file) ?? '';

    // OpenAI Responses API apply_patch operations carry a V4A diff body.
    if (e.type && OPENAI_OPS.has(e.type)) {
      if (e.type === 'delete_file') {
        ops.push({ type: 'delete', path });
        return;
      }
      const diff = toLF(e.diff ?? '');
      const header = e.type === 'create_file' ? `*** Add File: ${path}` : `*** Update File: ${path}`;
      const sub: string[] = [];
      const parsed = parseV4A(`*** Begin Patch\n${header}\n${diff}\n*** End Patch`, sub);
      warnings.push(...sub);
      for (const op of parsed) {
        if (op.type === 'update') pushUpdate(ops, op.path, op.hunks, op.moveTo);
        else ops.push(op);
      }
      if (!parsed.length && e.type === 'create_file') ops.push({ type: 'create', path, content: '' });
      return;
    }

    const command = e.command;
    const oldStr = first(e.old_str, e.old_string, e.oldText, e.search);
    const newStr = toLF(first(e.new_str, e.new_string, e.newText, e.replace) ?? '');
    const content = first(e.file_text, e.content);
    const insertLine = first(e.insert_line, e.insertLine);
    const replaceAll = first(e.replace_all, e.replaceAll) === true;

    if (command === 'delete') {
      ops.push({ type: 'delete', path });
      return;
    }
    if (command === 'create' || command === 'write' || (oldStr === undefined && insertLine === undefined && content !== undefined)) {
      ops.push({ type: 'create', path, content: toLF(content ?? newStr), overwrite: true });
      return;
    }
    if (command === 'insert' || insertLine !== undefined) {
      const line = Number(insertLine ?? 0);
      const text = content !== undefined ? toLF(content) : newStr;
      const hunk: Hunk = {
        mode: 'lines',
        oldLines: [],
        newLines: bodyLines(text),
        insertAfterLine: Number.isFinite(line) ? Math.max(0, Math.floor(line)) : 0,
        ambiguity: 'error',
      };
      pushHunk(ops, path, hunk);
      return;
    }
    if (oldStr === undefined) {
      warnings.push(`Edit ${n + 1} has no old text, content or command; skipped it.`);
      return;
    }
    const oldText = toLF(oldStr);
    if (oldText === '') {
      // Claude Code convention: an empty old_string creates a new file.
      ops.push({ type: 'create', path, content: newStr });
      return;
    }
    const hunk: Hunk = {
      mode: 'text',
      oldText,
      newText: newStr,
      oldLines: bodyLines(oldText),
      newLines: bodyLines(newStr),
      replaceAll,
      ambiguity: 'error',
    };
    pushHunk(ops, path, hunk);
  });

  return { format: 'edits', ops, warnings };
}

function pushHunk(ops: FileOp[], path: string, hunk: Hunk) {
  pushUpdate(ops, path, [hunk]);
}

function pushUpdate(ops: FileOp[], path: string, hunks: Hunk[], moveTo?: string) {
  const prev = ops[ops.length - 1];
  if (!moveTo && prev && prev.type === 'update' && prev.path === path && !prev.moveTo) prev.hunks.push(...hunks);
  else ops.push({ type: 'update', path, moveTo, hunks });
}
