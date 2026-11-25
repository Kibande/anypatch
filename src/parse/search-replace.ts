/**
 * Parser for SEARCH/REPLACE blocks (Aider, Cline, Roo Code, and most "diff" prompts):
 *
 *   src/app.py
 *   ```python
 *   <<<<<<< SEARCH
 *   old lines
 *   =======
 *   new lines
 *   >>>>>>> REPLACE
 *   ```
 *
 * Also accepts Cline's `------- SEARCH` / `+++++++ REPLACE` markers and Roo's
 * `:start_line:` hints. The file path is taken from the nearest path-like line
 * before the block (or the fence info string), else from `defaultPath`.
 */

import type { FileOp, Hunk } from '../types';

export const SEARCH_START = /^\s*(?:<{5,9}|-{5,9})\s*SEARCH\s*>?\s*$/i;
const DIVIDER = /^\s*={5,9}\s*$/;
const REPLACE_END = /^\s*(?:>{5,9}|\+{5,9})\s*REPLACE\s*<?\s*$/i;
const LINE_HINT = /^\s*:(start|end)_line:\s*(\d+)\s*$/;

const EXTENSIONLESS = new Set([
  'Makefile', 'makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'Gemfile', 'Rakefile',
  'Procfile', 'Justfile', 'justfile', 'Vagrantfile', 'Brewfile', 'Podfile', 'LICENSE', 'README',
  'CODEOWNERS', 'Jenkinsfile', 'Caddyfile', 'BUILD', 'WORKSPACE',
]);

/** Extract a file path from a line such as `src/app.ts`, `**src/app.ts**`, `### File: src/app.ts:`. */
export function pathFromLine(line: string): string | null {
  let s = line.trim();
  if (!s || s.length > 300) return null;
  if (s.startsWith('```') || s.startsWith('~~~')) {
    const info = s.slice(3).trim();
    if (!info) return null;
    const title = /(?:title|file|filename|path)=["']?([^"'\s]+)/i.exec(info);
    if (title) return pathFromLine(title[1]);
    const colon = /^[\w+#.-]+:(\S+)$/.exec(info);
    if (colon) return pathFromLine(colon[1]);
    const parts = info.split(/\s+/);
    if (parts.length >= 2) return pathFromLine(parts[parts.length - 1]);
    // A lone info string is a language, unless it clearly is a path.
    return info.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(info) ? pathFromLine(info) : null;
  }
  s = s.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '');
  s = s.replace(/^(?:\*\*|__)?(?:file(?:name)?|path)\s*:\s*/i, '');
  s = s.replace(/^[*_`"']+|[*_`"':]+$/g, '').trim();
  s = s.replace(/^(?:file(?:name)?|path)\s*:\s*/i, '').trim();
  s = s.replace(/^[*_`"']+|[*_`"':]+$/g, '').trim();
  if (!s || /\s/.test(s)) return null;
  if (/^[<>=+-]{3,}/.test(s)) return null;
  if (/^[a-z]+:\/\//i.test(s)) return null;
  const base = s.split(/[\\/]/).pop() ?? s;
  if (EXTENSIONLESS.has(base) || /^\.[\w.-]+$/.test(base)) return s;
  if (/\.[A-Za-z0-9_+-]{1,12}$/.test(base) && !/^\d+(\.\d+)+$/.test(base)) return s;
  return null;
}

export function parseSearchReplace(text: string, warnings: string[]): FileOp[] {
  const lines = text.split('\n');
  const ops: FileOp[] = [];
  let path: string | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!SEARCH_START.test(line)) {
      const p = pathFromLine(line);
      if (p) path = p;
      i++;
      continue;
    }

    const blockStart = i + 1;
    i++;
    let startLine: number | undefined;
    let sawHint = false;
    while (i < lines.length && LINE_HINT.test(lines[i])) {
      const [, kind, n] = LINE_HINT.exec(lines[i])!;
      if (kind === 'start') startLine = Number(n);
      sawHint = true;
      i++;
    }
    if (sawHint && i < lines.length && /^\s*-{3,}\s*$/.test(lines[i])) i++;

    const search: string[] = [];
    while (i < lines.length && !DIVIDER.test(lines[i])) {
      if (REPLACE_END.test(lines[i]) || SEARCH_START.test(lines[i])) break;
      search.push(lines[i]);
      i++;
    }
    if (i >= lines.length || !DIVIDER.test(lines[i])) {
      warnings.push(`SEARCH block starting at line ${blockStart} has no "=======" divider; skipped it.`);
      continue;
    }
    i++;
    const replace: string[] = [];
    let closed = false;
    while (i < lines.length) {
      if (REPLACE_END.test(lines[i])) {
        closed = true;
        i++;
        break;
      }
      if (SEARCH_START.test(lines[i])) break;
      replace.push(lines[i]);
      i++;
    }
    if (!closed) {
      while (replace.length && /^\s*(```|~~~)\s*$/.test(replace[replace.length - 1])) replace.pop();
      while (replace.length && replace[replace.length - 1].trim() === '') replace.pop();
      warnings.push(`SEARCH block starting at line ${blockStart} has no ">>>>>>> REPLACE" line; used everything after "=======".`);
    }

    const emptySearch = search.every((l) => l.trim() === '');
    const hunk: Hunk = {
      mode: 'lines',
      oldLines: emptySearch ? [] : search,
      newLines: replace,
      ambiguity: 'first',
    };
    if (emptySearch) hunk.atEof = true;
    if (startLine !== undefined) hunk.lineHint = Math.max(0, startLine - 1);

    const target = path ?? '';
    const prev = ops[ops.length - 1];
    if (prev && prev.type === 'update' && prev.path === target) prev.hunks.push(hunk);
    else ops.push({ type: 'update', path: target, hunks: [hunk] });
  }
  return ops;
}
