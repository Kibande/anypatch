import { describe, expect, it } from 'vitest';
import { applyPatch, applyToString, parsePatch } from '../src/index';
import { J, L } from './helpers';

const app = L(
  'import os',
  '',
  'def greet(name):',
  '    print("hi", name)',
  '    return name',
  '',
  '',
  'def main():',
  '    greet("bob")',
  '    greet("ann")',
);

describe('unified diff', () => {
  it('applies a clean git diff', () => {
    const patch = L(
      'diff --git a/src/app.py b/src/app.py',
      'index 3b18e51..a9c3f2d 100644',
      '--- a/src/app.py',
      '+++ b/src/app.py',
      '@@ -3,3 +3,3 @@',
      ' def greet(name):',
      '-    print("hi", name)',
      '+    print("hello", name)',
      '     return name',
    );
    const r = applyPatch(patch, { 'src/app.py': app });
    expect(r.ok).toBe(true);
    expect(r.format).toBe('unified');
    expect(r.files[0].after).toBe(app.replace('"hi"', '"hello"'));
    expect(r.files[0]).toMatchObject({ added: 1, removed: 1, type: 'update' });
    expect(r.operations[0].hunks[0]).toMatchObject({ status: 'applied', match: 'exact', line: 3 });
  });

  it('ignores wrong line numbers and counts in hunk headers', () => {
    const patch = L(
      '--- a/src/app.py',
      '+++ b/src/app.py',
      '@@ -90,7 +90,9 @@',
      ' def main():',
      '     greet("bob")',
      '+    greet("cy")',
    );
    const r = applyPatch(patch, { 'src/app.py': app });
    expect(r.ok).toBe(true);
    expect(r.files[0].after).toContain('    greet("bob")\n    greet("cy")\n    greet("ann")');
  });

  it('accepts bare @@ headers with no numbers', () => {
    const patch = L('--- src/app.py', '+++ src/app.py', '@@', ' import os', '+import sys');
    const r = applyPatch(patch, { 'src/app.py': app });
    expect(r.ok).toBe(true);
    expect(r.files[0].after!.startsWith('import os\nimport sys\n\n')).toBe(true);
  });

  it('treats unprefixed blank lines inside a hunk as blank context', () => {
    const patch = L(
      '--- a/src/app.py',
      '+++ b/src/app.py',
      '@@ -5,5 +5,5 @@',
      '     return name',
      '',
      '',
      '-def main():',
      '+def main() -> None:',
    );
    const r = applyPatch(patch, { 'src/app.py': app });
    expect(r.ok).toBe(true);
    expect(r.files[0].after).toContain('def main() -> None:');
  });

  it('handles patches wrapped in markdown fences with prose around them', () => {
    const patch = [
      'Here is the fix:',
      '',
      '```diff',
      '--- a/src/app.py',
      '+++ b/src/app.py',
      '@@ -1,1 +1,1 @@',
      '-import os',
      '+import os, sys',
      '```',
      '',
      'This adds sys.',
    ].join('\n');
    const r = applyPatch(patch, { 'src/app.py': app });
    expect(r.ok).toBe(true);
    expect(r.files[0].after!.split('\n')[0]).toBe('import os, sys');
  });

  it('applies several hunks and files, including create and delete', () => {
    const patch = L(
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '@@ -7,3 +7,3 @@',
      ' seven',
      '-eight',
      '+EIGHT',
      ' nine',
      '--- /dev/null',
      '+++ b/new/file.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    );
    const a = L('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine');
    const r = applyPatch(patch, { 'a.txt': a, 'old.txt': 'bye\n' });
    expect(r.ok).toBe(true);
    const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(byPath['a.txt'].after).toBe(L('one', 'TWO', 'three', 'four', 'five', 'six', 'seven', 'EIGHT', 'nine'));
    expect(byPath['new/file.txt']).toMatchObject({ type: 'create', after: 'hello\nworld\n' });
    expect(byPath['old.txt']).toMatchObject({ type: 'delete', after: null });
  });

  it('handles "\\ No newline at end of file" in both directions', () => {
    const add = L('--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b');
    expect(applyToString('a\nb', add)).toBe('a\nb\n');
    const remove = L('--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' a', '-b', '+c', '\\ No newline at end of file');
    expect(applyToString('a\nb\n', remove)).toBe('a\nc');
  });

  it('parses git renames and mode lines', () => {
    const patch = L(
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 90%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -1 +1 @@',
      '-export const x = 1;',
      '+export const x = 2;',
    );
    const r = applyPatch(patch, { 'old/name.ts': 'export const x = 1;\n' });
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => [f.path, f.type])).toEqual([
      ['old/name.ts', 'delete'],
      ['new/name.ts', 'create'],
    ]);
    expect(r.files[1].after).toBe('export const x = 2;\n');
  });

  it('parses a pure git rename with no hunks', () => {
    const patch = L('diff --git a/x.txt b/y.txt', 'similarity index 100%', 'rename from x.txt', 'rename to y.txt');
    const r = applyPatch(patch, { 'x.txt': 'same\n' });
    expect(r.ok).toBe(true);
    expect(r.files.find((f) => f.path === 'y.txt')?.after).toBe('same\n');
  });

  it('does not mistake a removed "-- comment" line for a file header', () => {
    const sql = L('select 1;', '-- old comment', 'select 2;');
    const patch = L('--- a/q.sql', '+++ b/q.sql', '@@ -1,3 +1,3 @@', ' select 1;', '--- old comment', '+-- new comment', ' select 2;');
    expect(applyToString(sql, patch)).toBe(L('select 1;', '-- new comment', 'select 2;'));
  });

  it('uses the line hint to pick between identical candidates', () => {
    const file = L('x', 'a', 'b', 'x', 'a', 'b', 'x', 'a', 'b');
    const patch = L('--- f', '+++ f', '@@ -5,2 +5,2 @@', ' a', '-b', '+B');
    expect(applyToString(file, patch)).toBe(L('x', 'a', 'b', 'x', 'a', 'B', 'x', 'a', 'b'));
  });

  it('tracks line offsets from earlier hunks', () => {
    const file = L('a', 'b', 'c', 'a', 'b', 'c');
    const patch = L('--- f', '+++ f', '@@ -1,1 +1,3 @@', ' a', '+1', '+2', '@@ -4,2 +6,2 @@', ' a', '-b', '+B');
    expect(applyToString(file, patch)).toBe(L('a', '1', '2', 'b', 'c', 'a', 'B', 'c'));
  });

  it('strips a/ b/ prefixes only when they are git prefixes', () => {
    const p1 = parsePatch(L('--- a/src/x.ts', '+++ b/src/x.ts', '@@', '-1', '+2'));
    expect(p1.ops[0].path).toBe('src/x.ts');
    const p2 = parsePatch(L('--- a/x.ts', '+++ a/x.ts', '@@', '-1', '+2'));
    expect(p2.ops[0].path).toBe('a/x.ts');
    const p3 = parsePatch(L('--- a/src/x.ts', '+++ src/x.ts', '@@', '-1', '+2'));
    expect(p3.ops[0]).toMatchObject({ path: 'src/x.ts', moveTo: undefined });
  });

  it('applies a hunk-only patch (no file headers) with defaultPath', () => {
    const patch = J('@@ -1,2 +1,2 @@', ' import os', '-', '+import sys');
    const r = applyPatch(patch, { 'app.py': app }, { defaultPath: 'app.py' });
    expect(r.ok).toBe(true);
    expect(r.files[0].after!.startsWith('import os\nimport sys\ndef greet')).toBe(true);
  });

  it('reports NO_PATH for a hunk-only patch without defaultPath', () => {
    const r = applyPatch(J('@@', '-a', '+b'), { a: 'a\n' });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('NO_PATH');
  });

  it('creates a missing file from an all-additions hunk without /dev/null', () => {
    const r = applyPatch(L('--- a/n.txt', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+x', '+y'), {});
    expect(r.ok).toBe(true);
    expect(r.files[0]).toMatchObject({ path: 'n.txt', type: 'create', after: 'x\ny\n' });
  });
});
