import { describe, expect, it } from 'vitest';
import { applyPatch, applyToString, parsePatch } from '../src/index';
import { pathFromLine } from '../src/parse/search-replace';
import { J, L } from './helpers';

const js = L(
  'function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'function sub(a, b) {',
  '  return a - b;',
  '}',
);

describe('SEARCH/REPLACE blocks', () => {
  it('applies an Aider-style block with the path above the fence', () => {
    const patch = J(
      'I will change add:',
      '',
      'src/math.js',
      '```javascript',
      '<<<<<<< SEARCH',
      '  return a + b;',
      '=======',
      '  return Number(a) + Number(b);',
      '>>>>>>> REPLACE',
      '```',
    );
    const r = applyPatch(patch, { 'src/math.js': js });
    expect(r.ok).toBe(true);
    expect(r.format).toBe('search-replace');
    expect(r.files[0].after).toContain('  return Number(a) + Number(b);');
  });

  it('applies several blocks for several files', () => {
    const patch = J(
      'a.js',
      '<<<<<<< SEARCH',
      'function add(a, b) {',
      '=======',
      'export function add(a, b) {',
      '>>>>>>> REPLACE',
      '',
      '<<<<<<< SEARCH',
      'function sub(a, b) {',
      '=======',
      'export function sub(a, b) {',
      '>>>>>>> REPLACE',
      '',
      '**b.txt**',
      '<<<<<<< SEARCH',
      'hello',
      '=======',
      'goodbye',
      '>>>>>>> REPLACE',
    );
    const r = applyPatch(patch, { 'a.js': js, 'b.txt': 'hello\n' });
    expect(r.ok).toBe(true);
    expect(r.operations).toHaveLength(2);
    expect(r.files[0].after).toContain('export function add');
    expect(r.files[0].after).toContain('export function sub');
    expect(r.files[1].after).toBe('goodbye\n');
  });

  it('creates a new file from an empty SEARCH section and appends to an existing one', () => {
    const create = J('docs/notes.md', '<<<<<<< SEARCH', '=======', '# Notes', '>>>>>>> REPLACE');
    expect(applyPatch(create, {}).files[0]).toMatchObject({ type: 'create', after: '# Notes\n' });
    const append = J('a.txt', '<<<<<<< SEARCH', '=======', 'three', '>>>>>>> REPLACE');
    expect(applyPatch(append, { 'a.txt': 'one\ntwo\n' }).files[0].after).toBe('one\ntwo\nthree\n');
  });

  it('understands Cline markers and Roo :start_line: hints', () => {
    const cline = J('------- SEARCH', '  return a - b;', '=======', '  return a - b - 0;', '+++++++ REPLACE');
    expect(applyToString(js, cline)).toContain('a - b - 0');

    const file = L('x = 1', 'y = 2', 'x = 1', 'y = 2');
    const roo = J('<<<<<<< SEARCH', ':start_line:3', '-------', 'x = 1', '=======', 'x = 100', '>>>>>>> REPLACE');
    expect(applyToString(file, roo)).toBe(L('x = 1', 'y = 2', 'x = 100', 'y = 2'));
  });

  it('replaces the first occurrence after the previous block when the search text repeats', () => {
    const file = L('a', 'x', 'a', 'x');
    const patch = J(
      '<<<<<<< SEARCH', 'a', '=======', 'A1', '>>>>>>> REPLACE',
      '<<<<<<< SEARCH', 'a', '=======', 'A2', '>>>>>>> REPLACE',
    );
    expect(applyToString(file, patch)).toBe(L('A1', 'x', 'A2', 'x'));
  });

  it('matches whole lines, not substrings of lines', () => {
    const file = L('const total = sum;', 'const sum = 1;');
    const patch = J('<<<<<<< SEARCH', 'const sum = 1;', '=======', 'const sum = 2;', '>>>>>>> REPLACE');
    expect(applyToString(file, patch)).toBe(L('const total = sum;', 'const sum = 2;'));
  });

  it('tolerates a missing >>>>>>> REPLACE line at the end', () => {
    const r = applyPatch(J('f.txt', '<<<<<<< SEARCH', 'a', '=======', 'b', '```'), { 'f.txt': 'a\n' });
    expect(r.ok).toBe(true);
    expect(r.files[0].after).toBe('b\n');
    expect(r.warnings[0]).toMatch(/REPLACE/);
  });

  it('extracts paths from the many ways models write them', () => {
    expect(pathFromLine('src/app.ts')).toBe('src/app.ts');
    expect(pathFromLine('**src/app.ts**')).toBe('src/app.ts');
    expect(pathFromLine('`src/app.ts`')).toBe('src/app.ts');
    expect(pathFromLine('### File: src/app.ts')).toBe('src/app.ts');
    expect(pathFromLine('src/app.ts:')).toBe('src/app.ts');
    expect(pathFromLine('```ts title="src/app.ts"')).toBe('src/app.ts');
    expect(pathFromLine('```python:src/app.py')).toBe('src/app.py');
    expect(pathFromLine('Dockerfile')).toBe('Dockerfile');
    expect(pathFromLine('.env.example')).toBe('.env.example');
    expect(pathFromLine('```python')).toBeNull();
    expect(pathFromLine('Here is the change:')).toBeNull();
    expect(pathFromLine('Done.')).toBeNull();
    expect(pathFromLine('1.2.3')).toBeNull();
    expect(pathFromLine('https://example.com/a.js')).toBeNull();
  });

  it('keeps the path from the line before the fence when the fence names only a language', () => {
    const p = parsePatch(J('lib/x.rb', '```ruby', '<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE', '```'));
    expect(p.ops[0].path).toBe('lib/x.rb');
  });
});
