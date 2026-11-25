/**
 * Parser for the V4A / `apply_patch` format used by OpenAI's Codex and GPT models:
 *
 *   *** Begin Patch
 *   *** Update File: src/app.py
 *   @@ def greet():
 *   -    print("hi")
 *   +    print("hello")
 *   *** End Patch
 */

import type { FileOp, Hunk } from '../types';

const ADD = /^\*\*\*\s*Add File:\s*(.+?)\s*$/;
const DELETE = /^\*\*\*\s*Delete File:\s*(.+?)\s*$/;
const UPDATE = /^\*\*\*\s*Update File:\s*(.+?)\s*$/;
const MOVE = /^\*\*\*\s*Move to:\s*(.+?)\s*$/;
const END_PATCH = /^\*\*\*\s*End Patch\s*$/;
const BEGIN_PATCH = /^\*\*\*\s*Begin Patch\s*$/;
const END_OF_FILE = /^\*\*\*\s*End of File\s*$/;

function isDirective(line: string): boolean {
  return ADD.test(line) || DELETE.test(line) || UPDATE.test(line) || END_PATCH.test(line);
}

function cleanPath(p: string): string {
  return p.replace(/^["'`]|["'`]$/g, '').trim();
}

export function parseV4A(text: string, warnings: string[]): FileOp[] {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => BEGIN_PATCH.test(l.trim()));
  if (i === -1) {
    warnings.push('Patch has no "*** Begin Patch" line; parsed it anyway.');
    i = 0;
  } else {
    i++;
  }
  const ops: FileOp[] = [];
  let sawEnd = false;

  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (END_PATCH.test(line)) {
      sawEnd = true;
      break;
    }
    let m: RegExpExecArray | null;

    if ((m = ADD.exec(line))) {
      const path = cleanPath(m[1]);
      i++;
      const body: string[] = [];
      let unprefixed = false;
      let bareBlank = 0;
      while (i < lines.length && !isDirective(lines[i].trimEnd()) && !lines[i].startsWith('```')) {
        const l = lines[i];
        if (l.startsWith('+')) {
          body.push(l.slice(1));
          bareBlank = 0;
        } else {
          body.push(l);
          if (l !== '') {
            unprefixed = true;
            bareBlank = 0;
          } else {
            bareBlank++;
          }
        }
        i++;
      }
      body.length -= bareBlank;
      if (unprefixed) warnings.push(`Lines in "Add File: ${path}" should start with "+"; used them as written.`);
      ops.push({ type: 'create', path, content: body.length ? body.join('\n') + '\n' : '' });
      continue;
    }

    if ((m = DELETE.exec(line))) {
      ops.push({ type: 'delete', path: cleanPath(m[1]) });
      i++;
      continue;
    }

    if ((m = UPDATE.exec(line))) {
      const path = cleanPath(m[1]);
      i++;
      let moveTo: string | undefined;
      if (i < lines.length) {
        const mv = MOVE.exec(lines[i].trimEnd());
        if (mv) {
          moveTo = cleanPath(mv[1]);
          i++;
        }
      }
      const hunks: Hunk[] = [];
      let anchors: string[] = [];
      let cur: Hunk | null = null;
      let bareBlank = 0;
      let unprefixed = false;

      const finish = () => {
        if (cur) {
          if (bareBlank) {
            cur.oldLines.length -= bareBlank;
            cur.newLines.length -= bareBlank;
          }
          if (cur.oldLines.length || cur.newLines.length) hunks.push(cur);
        }
        cur = null;
        bareBlank = 0;
      };
      const open = (): Hunk => {
        if (!cur) {
          cur = { mode: 'lines', oldLines: [], newLines: [], ambiguity: 'first' };
          if (anchors.length) cur.anchors = anchors;
          anchors = [];
        }
        return cur;
      };

      while (i < lines.length && !isDirective(lines[i].trimEnd()) && !lines[i].startsWith('```')) {
        const l = lines[i];
        if (l.startsWith('@@')) {
          finish();
          const anchor = l.replace(/^@@+/, '').replace(/@@+\s*$/, '').trim();
          if (anchor) anchors.push(anchor);
        } else if (END_OF_FILE.test(l.trimEnd())) {
          const h = open();
          h.atEof = true;
          finish();
        } else if (l === '') {
          const h = open();
          h.oldLines.push('');
          h.newLines.push('');
          bareBlank++;
        } else {
          const h = open();
          bareBlank = 0;
          const c = l[0];
          if (c === ' ') {
            h.oldLines.push(l.slice(1));
            h.newLines.push(l.slice(1));
          } else if (c === '-') {
            h.oldLines.push(l.slice(1));
          } else if (c === '+') {
            h.newLines.push(l.slice(1));
          } else {
            unprefixed = true;
            h.oldLines.push(l);
            h.newLines.push(l);
          }
        }
        i++;
      }
      finish();
      if (unprefixed) warnings.push(`Some lines in "Update File: ${path}" had no " ", "-" or "+" prefix; treated them as context.`);
      if (!hunks.length && !moveTo) warnings.push(`"Update File: ${path}" has no changes.`);
      else ops.push({ type: 'update', path, moveTo, hunks });
      continue;
    }

    if (line.trim() !== '' && !line.startsWith('```')) warnings.push(`Ignored line outside any file section: ${line.slice(0, 80)}`);
    i++;
  }
  if (!sawEnd && ops.length) warnings.push('Patch has no "*** End Patch" line.');
  return ops;
}
