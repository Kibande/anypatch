/** Locating a block of lines inside a file, with progressively looser comparisons. */

import type { MatchLevel } from './types';
import { isBlank, leadingWhitespace, normalizeUnicode } from './text';

export interface MatchConfig {
  ignoreWhitespace: boolean;
  normalizeUnicode: boolean;
  /** Similarity threshold for fuzzy matching, or null when disabled. */
  fuzzyThreshold: number | null;
}

type Normalizer = (s: string) => string;

const identity: Normalizer = (s) => s;
const trimEnd: Normalizer = (s) => s.trimEnd();
const trimBoth: Normalizer = (s) => s.trim();
const unicodeLoose: Normalizer = (s) => normalizeUnicode(s).trim().replace(/\s+/g, ' ');
const unicodeStrict: Normalizer = (s) => normalizeUnicode(s);

/** The strict (non-fuzzy) levels enabled by a config, in the order they are tried. */
export function strictLevels(config: MatchConfig): Array<[MatchLevel, Normalizer]> {
  const levels: Array<[MatchLevel, Normalizer]> = [['exact', identity]];
  if (config.ignoreWhitespace) {
    levels.push(['trailing-whitespace', trimEnd], ['indentation', trimBoth]);
  }
  if (config.normalizeUnicode) {
    levels.push(['unicode', config.ignoreWhitespace ? unicodeLoose : unicodeStrict]);
  }
  return levels;
}

/** Levels at which the matched file lines may differ in indentation from the patch. */
export function levelChangesIndent(level: MatchLevel): boolean {
  return level === 'indentation' || level === 'unicode' || level === 'fuzzy';
}

/** Every start index where `needle` occurs in `hay` under the normalizer. */
export function findAll(hay: readonly string[], needle: readonly string[], norm: Normalizer): number[] {
  return findNormalized(hay.map(norm), needle.map(norm));
}

/** Like findAll, for a hay and needle that are already normalized. */
export function findNormalized(nh: readonly string[], nn: readonly string[]): number[] {
  const n = nn.length;
  if (n === 0 || n > nh.length) return [];
  const out: number[] = [];
  const first = nn[0];
  for (let i = 0; i + n <= nh.length; i++) {
    if (nh[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < n; j++) {
      if (nh[i + j] !== nn[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

export interface WindowScore {
  start: number;
  score: number;
  minLine: number;
}

/** Shared scratch table for bigram counting (exact for ASCII, hashed otherwise). */
const SCRATCH = new Int32Array(1 << 14);
const bigramCode = (a: number, b: number) => ((a << 7) ^ b ^ (a >> 7) * 40503) & 0x3fff;

/** Fast Dice similarity against one fixed string, with no allocation per comparison. */
class Bigrams {
  private readonly codes: Uint16Array;
  constructor(readonly text: string) {
    const n = Math.max(0, text.length - 1);
    this.codes = new Uint16Array(n);
    for (let i = 0; i < n; i++) this.codes[i] = bigramCode(text.charCodeAt(i), text.charCodeAt(i + 1));
  }
  score(other: string): number {
    if (other === this.text) return 1;
    const codes = this.codes;
    const size = codes.length;
    const otherSize = other.length - 1;
    if (size < 1 || otherSize < 1) return 0;
    for (let i = 0; i < size; i++) SCRATCH[codes[i]]++;
    let overlap = 0;
    for (let i = 0; i < otherSize; i++) {
      const code = bigramCode(other.charCodeAt(i), other.charCodeAt(i + 1));
      if (SCRATCH[code] > 0) {
        overlap++;
        SCRATCH[code]--;
      }
    }
    for (let i = 0; i < size; i++) SCRATCH[codes[i]] = 0;
    return (2 * overlap) / (size + otherSize);
  }
}

const FULL_SCAN_BUDGET = 250_000;
const SEED_LINES = 3;
const SEEDS_PER_LINE = 25;

/** Score windows of the file against the needle (average per-line similarity), best first. */
export function scoreWindows(hay: readonly string[], needle: readonly string[], limit = 5): WindowScore[] {
  const n = needle.length;
  if (n === 0 || hay.length === 0) return [];
  const nh = hay.map(unicodeLoose);
  const nn = needle.map(unicodeLoose);
  const profiles = nn.map((s) => new Bigrams(s));
  const windowCount = Math.max(1, hay.length - n + 1);
  const clampStart = (s: number) => Math.min(Math.max(0, s), windowCount - 1);

  let starts: number[];
  if (windowCount * n <= FULL_SCAN_BUDGET) {
    starts = Array.from({ length: windowCount }, (_, i) => i);
  } else {
    // Large file: score only windows seeded by lines that resemble the needle's most distinctive lines.
    const set = new Set<number>();
    const exact = new Map<string, number[]>();
    nn.forEach((line, j) => {
      if (line) exact.set(line, [...(exact.get(line) ?? []), j]);
    });
    nh.forEach((line, i) => {
      for (const j of exact.get(line) ?? []) set.add(clampStart(i - j));
    });
    const seeds = nn
      .map((line, j) => ({ line, j }))
      .filter(({ line }) => line.length > 3)
      .sort((x, y) => y.line.length - x.line.length)
      .slice(0, SEED_LINES);
    const topScore = new Float64Array(SEEDS_PER_LINE);
    const topIndex = new Int32Array(SEEDS_PER_LINE);
    for (const { j } of seeds) {
      let count = 0;
      for (let i = 0; i < nh.length; i++) {
        const s = profiles[j].score(nh[i]);
        if (count === SEEDS_PER_LINE && s <= topScore[count - 1]) continue;
        // Insert into the descending top-K list.
        let p = count < SEEDS_PER_LINE ? count++ : count - 1;
        while (p > 0 && topScore[p - 1] < s) {
          topScore[p] = topScore[p - 1];
          topIndex[p] = topIndex[p - 1];
          p--;
        }
        topScore[p] = s;
        topIndex[p] = i;
      }
      for (let k = 0; k < count; k++) set.add(clampStart(topIndex[k] - j));
    }
    starts = [...set].sort((a, b) => a - b);
  }

  const scores: WindowScore[] = [];
  for (const start of starts) {
    let total = 0;
    let minLine = 1;
    for (let j = 0; j < n; j++) {
      const line = nh[start + j] ?? '';
      const s = line === '' && nn[j] === '' ? 1 : profiles[j].score(line);
      total += s;
      if (s < minLine) minLine = s;
    }
    scores.push({ start, score: total / n, minLine });
  }
  scores.sort((a, b) => b.score - a.score || a.start - b.start);
  return scores.slice(0, limit);
}

/** Fuzzy positions: windows whose average similarity clears the threshold. */
export function findFuzzy(hay: readonly string[], needle: readonly string[], threshold: number): number[] {
  if (needle.length > hay.length) return [];
  const best = scoreWindows(hay, needle, 50);
  return best
    .filter((w) => w.score >= threshold && w.minLine >= 0.5)
    .map((w) => w.start)
    .sort((a, b) => a - b);
}

export interface PickContext {
  /** Prefer matches at or after this line (end of the previous hunk / V4A anchor). */
  cursor: number;
  /** Prefer the match closest to this line. */
  hint?: number;
  /** Prefer a match that ends at the last line. */
  atEof?: boolean;
  ambiguity: 'first' | 'error';
  needleLength: number;
  fileLength: number;
  /** Require a unique candidate unless a hint disambiguates (used for context-trimmed matches). */
  requireUnique?: boolean;
}

export type PickResult =
  | { ok: true; start: number; outOfOrder: boolean }
  | { ok: false; ambiguous: number[] };

export function pick(positions: number[], ctx: PickContext): PickResult {
  let pool = positions;
  if (ctx.atEof) {
    const atEnd = pool.filter((p) => p + ctx.needleLength === ctx.fileLength);
    if (atEnd.length) pool = atEnd;
  }
  const after = pool.filter((p) => p >= ctx.cursor);
  const outOfOrder = after.length === 0;
  if (after.length) pool = after;

  if (pool.length === 1) return { ok: true, start: pool[0], outOfOrder };
  if (ctx.hint !== undefined) {
    let best = pool[0];
    for (const p of pool) if (Math.abs(p - ctx.hint) < Math.abs(best - ctx.hint)) best = p;
    return { ok: true, start: best, outOfOrder };
  }
  if (ctx.ambiguity === 'first' && !ctx.requireUnique) return { ok: true, start: pool[0], outOfOrder };
  return { ok: false, ambiguous: pool };
}

/**
 * Re-indent lines written by the model so they line up with the file, when the
 * patch's context was matched with different indentation.
 */
export function makeReindenter(needle: readonly string[], fileSlice: readonly string[]): (line: string) => string {
  const pairs: Array<[string, string]> = [];
  for (let j = 0; j < needle.length; j++) {
    if (isBlank(needle[j]) || isBlank(fileSlice[j] ?? '')) continue;
    pairs.push([leadingWhitespace(needle[j]), leadingWhitespace(fileSlice[j])]);
  }
  if (!pairs.length || pairs.every(([a, b]) => a === b)) return (l) => l;

  // Exact indent mapping learned from the matched lines (first occurrence wins).
  const map = new Map<string, string>();
  for (const [a, b] of pairs) if (!map.has(a)) map.set(a, b);

  // Linear model over indent widths: fileWidth = scale * patchWidth + shift.
  const fileIndents = pairs.map(([, b]) => b).filter((b) => b.length > 0);
  const tabs = fileIndents.length > 0 && fileIndents.every((b) => /^\t+$/.test(b));
  const spaces = fileIndents.every((b) => /^ +$/.test(b));
  const distinct = [...new Map(pairs.map(([a, b]) => [a.length, b.length])).entries()];
  let model: ((w: number) => number) | null = null;
  if ((tabs || spaces) && distinct.length >= 1) {
    let scale = 1;
    let shift = distinct[0][1] - distinct[0][0];
    if (distinct.length >= 2) {
      const [[x1, y1], [x2, y2]] = distinct;
      scale = (y2 - y1) / (x2 - x1);
      shift = y1 - scale * x1;
    }
    const fits = scale > 0 && pairs.every(([a, b]) => Math.abs(scale * a.length + shift - b.length) < 0.01);
    if (fits) model = (w) => Math.max(0, Math.round(scale * w + shift));
  }

  if (model) {
    const unit = tabs ? '\t' : ' ';
    const m = model;
    return (l) => {
      if (isBlank(l)) return l;
      const ws = leadingWhitespace(l);
      const mapped = map.get(ws);
      if (mapped !== undefined) return mapped + l.slice(ws.length);
      return unit.repeat(m(ws.length)) + l.slice(ws.length);
    };
  }

  // Fallback: use a learned indent when there is one, else shift by the first differing pair.
  const [from, to] = pairs.find(([a, b]) => a !== b) ?? pairs[0];
  let shift: (l: string) => string;
  if (to.startsWith(from)) {
    const add = to.slice(from.length);
    shift = (l) => add + l;
  } else if (from.startsWith(to)) {
    const remove = from.length - to.length;
    shift = (l) => l.slice(Math.min(remove, leadingWhitespace(l).length));
  } else {
    // Different indent characters (tabs vs spaces): swap the base prefix.
    shift = (l) => (l.startsWith(from) ? to + l.slice(from.length) : l);
  }
  return (l) => {
    if (isBlank(l)) return l;
    const ws = leadingWhitespace(l);
    const mapped = map.get(ws);
    return mapped !== undefined ? mapped + l.slice(ws.length) : shift(l);
  };
}
