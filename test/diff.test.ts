import { describe, expect, it } from 'vitest';
import { applyPatch, countChanges, createUnifiedDiff } from '../src/index';
import { diffArrays } from '../src/diff';

/** Small deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomFile(rand: () => number, n: number, alphabet: string[]): string[] {
  return Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]);
}

function mutate(rand: () => number, lines: string[], alphabet: string[]): string[] {
  const out = lines.slice();
  const edits = 1 + Math.floor(rand() * 5);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rand() * (out.length + 1));
    const kind = rand();
    if (kind < 0.33 && out.length) out.splice(Math.min(at, out.length - 1), 1);
    else if (kind < 0.66) out.splice(at, 0, alphabet[Math.floor(rand() * alphabet.length)] + '*');
    else if (out.length) out[Math.min(at, out.length - 1)] = 'changed ' + e;
  }
  return out;
}

describe('diffArrays', () => {
  it('produces a minimal edit script', () => {
    const ops = diffArrays(['a', 'b', 'c', 'a', 'b', 'b', 'a'], ['c', 'b', 'a', 'b', 'a', 'c']);
    expect(ops.filter((o) => o.kind !== '=').length).toBe(5);
  });

  it('handles empty inputs', () => {
    expect(diffArrays([], [])).toEqual([]);
    expect(diffArrays(['a'], []).map((o) => o.kind)).toEqual(['-']);
    expect(diffArrays([], ['a']).map((o) => o.kind)).toEqual(['+']);
  });
});

describe('createUnifiedDiff', () => {
  it('writes a standard diff', () => {
    const d = createUnifiedDiff('a\nb\nc\n', 'a\nB\nc\n', { oldPath: 'f.txt' });
    expect(d).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
  });

  it('returns an empty string for identical input', () => {
    expect(createUnifiedDiff('x\n', 'x\n')).toBe('');
  });

  it('marks missing final newlines', () => {
    const d = createUnifiedDiff('a\nb', 'a\nb\n', { oldPath: 'f' });
    expect(d).toContain('-b\n\\ No newline at end of file\n+b\n');
  });

  it('round-trips through applyPatch on random edits (property test)', () => {
    const alphabet = ['{', '}', 'return x;', '', 'x++;', 'if (a) {', 'else', 'foo()', 'bar()'];
    for (let seed = 1; seed <= 3000; seed++) {
      const rand = rng(seed);
      const before = randomFile(rand, 5 + Math.floor(rand() * 40), alphabet);
      const after = mutate(rand, before, alphabet);
      const eofA = rand() < 0.85;
      const eofB = rand() < 0.85;
      const a = before.join('\n') + (eofA && before.length ? '\n' : '');
      const b = after.join('\n') + (eofB && after.length ? '\n' : '');
      const context = Math.floor(rand() * 4);
      const patch = createUnifiedDiff(a, b, { oldPath: 'f', context });
      if (a === b) {
        expect(patch).toBe('');
        continue;
      }
      const r = applyPatch(patch, { f: a }, { maxContextTrim: 0 });
      if (!r.ok || (r.files[0]?.after ?? a) !== b) {
        throw new Error(`seed ${seed} failed\n${JSON.stringify({ a, b, context })}\n${patch}\n${JSON.stringify(r.errors)}`);
      }
      const counts = countChanges(a, b);
      expect(counts.added + counts.removed).toBeGreaterThan(0);
    }
  });

  it('still applies after LLM-style corruption: no line numbers, CRLF file, stray trailing spaces', () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const rand = rng(seed * 7919);
      const before = Array.from({ length: 8 + Math.floor(rand() * 30) }, (_, i) => `line ${i}${i % 3 ? ' ' + 'x'.repeat(i % 3) : ''}`);
      const after = mutate(rand, before, ['new a', 'new b', 'new c']);
      const a = before.join('\n') + '\n';
      const b = after.join('\n') + '\n';
      if (a === b) continue;
      const context = 1 + Math.floor(rand() * 3);
      const clean = createUnifiedDiff(a, b, { oldPath: 'f', context });
      const noisy = clean.replace(/^@@ .* @@$/gm, '@@');
      const fileLines = before.map((l) => (rand() < 0.3 ? l + '  ' : l));
      const file = fileLines.join('\r\n') + '\r\n';
      const r = applyPatch(noisy, { f: file });
      const out = r.files[0]?.after ?? '';
      const normalized = out.split('\r\n').map((l) => l.trimEnd()).join('\n');
      if (!r.ok || normalized !== b || /[^\r]\n/.test(out)) {
        throw new Error(`seed ${seed} failed\n${noisy}\n${JSON.stringify(r.errors)}`);
      }
    }
  });

  it('diffs creations and deletions', () => {
    expect(createUnifiedDiff(null, 'x\n', { newPath: 'n' })).toBe('--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n');
    expect(createUnifiedDiff('x\n', null, { oldPath: 'n' })).toBe('--- a/n\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n');
  });
});
