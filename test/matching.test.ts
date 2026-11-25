import { describe, expect, it } from 'vitest';
import { applyPatch, applyToString, formatResult } from '../src/index';
import { J, L } from './helpers';

const diff = (...body: string[]) => L('--- a/f', '+++ b/f', '@@', ...body);

describe('tolerant matching', () => {
  it('ignores trailing whitespace differences and keeps the file’s own context lines', () => {
    const file = 'a  \nb\nc\t\n';
    const out = applyToString(file, diff(' a', '-b', '+B', ' c'));
    expect(out).toBe('a  \nB\nc\t\n');
  });

  it('re-indents new lines when the model got the indentation wrong (uniform shift)', () => {
    const file = L('class A {', '    run() {', '        go();', '    }', '}');
    const patch = diff(' run() {', '-    go();', '+    stop();', '+    go();', ' }');
    expect(applyToString(file, patch)).toBe(L('class A {', '    run() {', '        stop();', '        go();', '    }', '}'));
  });

  it('re-indents when the model used 2 spaces for a 4-space file', () => {
    const file = L('def f():', '    if x:', '        return 1', '    return 2');
    // The model wrote 2-space indentation: "  if x:" / "    return 1".
    const patch = diff(' def f():', '   if x:', '-    return 1', '+    log(x)', '+    return 1', '   return 2');
    expect(applyToString(file, patch)).toBe(L('def f():', '    if x:', '        log(x)', '        return 1', '    return 2'));
  });

  it('converts spaces to tabs when the file is tab-indented', () => {
    const file = 'func main() {\n\tif ok {\n\t\trun()\n\t}\n}\n';
    const patch = diff(' func main() {', '     if ok {', '-        run()', '+        start()', '+        run()', '     }');
    expect(applyToString(file, patch)).toBe('func main() {\n\tif ok {\n\t\tstart()\n\t\trun()\n\t}\n}\n');
  });

  it('matches through smart quotes, dashes and non-breaking spaces', () => {
    const file = L('const msg = “hello” — world;', 'const n = 1;');
    const patch = diff(' const msg = "hello" - world;', '-const n = 1;', '+const n = 2;');
    expect(applyToString(file, patch)).toBe(L('const msg = “hello” — world;', 'const n = 2;'));
  });

  it('preserves CRLF line endings and a BOM', () => {
    const file = '﻿one\r\ntwo\r\nthree\r\n';
    const out = applyToString(file, diff(' one', '-two', '+TWO', ' three'));
    expect(out).toBe('﻿one\r\nTWO\r\nthree\r\n');
  });

  it('drops hallucinated context lines at the edges of a hunk', () => {
    const file = L('a', 'b', 'c', 'd', 'e');
    const patch = diff(' this line does not exist', ' b', '-c', '+C', ' d');
    const r = applyPatch(patch, { f: file });
    expect(r.ok).toBe(true);
    expect(r.files[0].after).toBe(L('a', 'b', 'C', 'd', 'e'));
    expect(r.operations[0].hunks[0].contextTrimmed).toBe(1);
    expect(formatResult(r)).toMatch(/dropping 1 context line/);
  });

  it('does not trim context into an ambiguous match', () => {
    const file = L('x', 'b', 'x', 'b');
    const r = applyPatch(diff(' nope', '-b', '+B'), { f: file });
    expect(r.ok).toBe(false);
  });

  it('treats an already-applied hunk as applied (idempotent retries)', () => {
    const file = L('a', 'B', 'c');
    const r = applyPatch(diff(' a', '-b', '+B', ' c'), { f: file });
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(0);
    expect(r.operations[0].hunks[0].status).toBe('already-applied');
    expect(formatResult(r)).toMatch(/already present/);
  });

  it('does not call a pure deletion "already applied"', () => {
    const r = applyPatch(diff(' a', '-zzz', ' c'), { f: L('a', 'c') });
    expect(r.ok).toBe(false);
  });

  it('fuzzy matching is off by default and finds near misses when enabled', () => {
    const file = L('function compute(alpha, beta) {', '  const result = alpha * beta;', '  return result;', '}');
    const patch = diff(
      ' function compute(alpha, beta) {',
      '-  const result = alpha * betaa;',
      '+  const result = alpha + beta;',
      '   return result;',
    );
    expect(applyPatch(patch, { f: file }).ok).toBe(false);
    const r = applyPatch(patch, { f: file }, { fuzzy: true });
    expect(r.ok).toBe(true);
    expect(r.operations[0].hunks[0].match).toBe('fuzzy');
    expect(r.files[0].after).toContain('alpha + beta');
  });

  it('strict options turn tolerance off', () => {
    const r = applyPatch(diff(' a', '-b', '+B'), { f: 'a  \nb\n' }, { ignoreWhitespace: false, normalizeUnicode: false, maxContextTrim: 0 });
    expect(r.ok).toBe(false);
  });

  it('applies hunks that arrive out of order, with a warning', () => {
    const file = L('a', 'b', 'c', 'd');
    const patch = L('--- a/f', '+++ b/f', '@@', '-d', '+D', '@@', '-a', '+A');
    const r = applyPatch(patch, { f: file });
    expect(r.ok).toBe(true);
    expect(r.files[0].after).toBe(L('A', 'b', 'c', 'D'));
    expect(r.warnings.join('\n')).toMatch(/out of order/);
  });

  it('reports every failing hunk at once, with the closest match', () => {
    const file = L('alpha', 'beta', 'gamma', 'delta', 'epsilon');
    const patch = L('--- a/f', '+++ b/f', '@@', ' alpah', '-betta', '+BETA', '@@', ' gamma', '-delta', '+DELTA', '@@', '-omega', '+OMEGA');
    const r = applyPatch(patch, { f: file });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.hunk)).toEqual([1, 3]);
    expect(r.operations[0].hunks.map((h) => h.status)).toEqual(['failed', 'applied', 'failed']);
    expect(r.files).toHaveLength(0);
    const text = formatResult(r);
    expect(text).toMatch(/Closest match in the current file is lines 1-2/);
    expect(text).toMatch(/> 1 \| alpha/);
    expect(text).toMatch(/Nothing similar exists/);
    expect(text).toMatch(/f hunk 2/);
  });

  it('rejects binary files', () => {
    const r = applyPatch(diff('-a', '+b'), { f: 'a\u0000b' });
    expect(r.errors[0].code).toBe('BINARY_FILE');
  });

  it('gives a parse error with guidance for text that is not a patch', () => {
    const r = applyPatch('just some prose, no patch here', {});
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('PARSE_ERROR');
    expect(formatResult(r)).toMatch(/could not be parsed.*unified diff/s);
  });

  it('reports an empty patch', () => {
    const r = applyPatch('*** Begin Patch\n*** End Patch\n', {});
    expect(r.errors[0].code).toBe('EMPTY_PATCH');
  });

  it('reads files through a reader function and only once each', () => {
    const calls: string[] = [];
    const r = applyPatch(
      L('--- a/f', '+++ b/f', '@@', '-a', '+b', '--- a/f', '+++ b/f', '@@', '-b', '+c'),
      (p) => {
        calls.push(p);
        return p === 'f' ? 'a\n' : undefined;
      },
    );
    expect(r.ok).toBe(true);
    expect(r.files[0].after).toBe('c\n');
    expect(calls).toEqual(['f']);
  });

  it('handles files without a trailing newline', () => {
    expect(applyToString('a\nb', diff(' a', '-b', '+c'))).toBe('a\nc');
    expect(applyToString('x', J('<<<<<<< SEARCH', 'x', '=======', 'y', '>>>>>>> REPLACE'))).toBe('y');
  });
});
