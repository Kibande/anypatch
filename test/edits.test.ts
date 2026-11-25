import { describe, expect, it } from 'vitest';
import { applyPatch, applyToString, PatchApplyError } from '../src/index';
import { L } from './helpers';

const ts = L(
  'export function total(items: Item[]) {',
  '  let sum = 0;',
  '  for (const item of items) sum += item.price;',
  '  return sum;',
  '}',
);

describe('str_replace style edits', () => {
  it('replaces a unique substring, even mid-line', () => {
    const r = applyPatch({ path: 'a.ts', old_str: 'item.price', new_str: 'item.price * item.qty' }, { 'a.ts': ts });
    expect(r.ok).toBe(true);
    expect(r.format).toBe('edits');
    expect(r.files[0].after).toContain('sum += item.price * item.qty;');
  });

  it('accepts Claude Code field names and replace_all', () => {
    const r = applyPatch(
      { file_path: 'a.ts', old_string: 'sum', new_string: 'acc', replace_all: true },
      { 'a.ts': ts },
    );
    expect(r.ok).toBe(true);
    expect(r.files[0].after).not.toMatch(/\bsum\b/);
    expect(r.operations[0].hunks[0].occurrences).toBe(3);
  });

  it('refuses ambiguous replacements and says where they are', () => {
    const r = applyPatch({ path: 'a.ts', old_str: 'sum', new_str: 'acc' }, { 'a.ts': ts });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('AMBIGUOUS');
    expect(r.errors[0].message).toMatch(/appears 3 times \(at lines 2, 3, 4\)/);
    expect(r.errors[0].hint).toMatch(/replace_all/);
  });

  it('falls back to whitespace-tolerant line matching', () => {
    const r = applyPatch(
      { path: 'a.ts', old_str: '    let sum = 0;\n    for (const item of items) sum += item.price;', new_str: '    let sum = 0n;' },
      { 'a.ts': ts },
    );
    expect(r.ok).toBe(true);
    expect(r.files[0].after).toBe(L('export function total(items: Item[]) {', '  let sum = 0n;', '  return sum;', '}'));
  });

  it('applies a list of edits in order, including create and insert', () => {
    const r = applyPatch(
      [
        { command: 'str_replace', path: 'a.ts', old_str: 'let sum = 0;', new_str: 'let sum = 0; // running total' },
        { command: 'insert', path: 'a.ts', insert_line: 0, new_str: "import type { Item } from './item';" },
        { command: 'create', path: 'item.ts', file_text: 'export interface Item { price: number }\n' },
      ],
      { 'a.ts': ts },
    );
    expect(r.ok).toBe(true);
    const a = r.files.find((f) => f.path === 'a.ts')!.after!;
    expect(a.split('\n')[0]).toBe("import type { Item } from './item';");
    expect(a).toContain('// running total');
    expect(r.files.find((f) => f.path === 'item.ts')?.type).toBe('create');
  });

  it('create overwrites (Write semantics); empty old_string creates only new files', () => {
    expect(applyPatch({ command: 'create', path: 'x', file_text: 'new' }, { x: 'old' }).files[0].after).toBe('new');
    const r = applyPatch({ path: 'x', old_string: '', new_string: 'new' }, { x: 'old' });
    expect(r.errors[0].code).toBe('FILE_EXISTS');
  });

  it('accepts edits passed as JSON text', () => {
    const json = JSON.stringify([{ path: 'a.ts', old_str: 'return sum;', new_str: 'return Math.round(sum);' }]);
    expect(applyPatch(json, { 'a.ts': ts }).files[0].after).toContain('Math.round');
  });

  it('applyToString throws PatchApplyError carrying the result and a model-readable hint', () => {
    try {
      applyToString(ts, { path: 'x', old_str: 'not there at all', new_str: 'y' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PatchApplyError);
      const e = err as PatchApplyError;
      expect(e.result.errors[0].code).toBe('NO_MATCH');
      expect(e.message).toMatch(/Could not find the text to replace/);
    }
  });

  it('reports insert past the end of the file', () => {
    const r = applyPatch({ command: 'insert', path: 'a', insert_line: 10, new_str: 'x' }, { a: 'one\n' });
    expect(r.errors[0].message).toMatch(/only 1 lines/);
  });
});
