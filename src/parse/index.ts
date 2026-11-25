import type { ApplyOptions, EditInput, ParsedPatch, PatchFormat } from '../types';
import { stripBom, toLF } from '../text';
import { parseUnified } from './unified';
import { parseV4A } from './v4a';
import { parseSearchReplace, SEARCH_START } from './search-replace';
import { isEditLike, parseEdits } from './edits';

export class PatchParseError extends Error {
  readonly code = 'PARSE_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PatchParseError';
  }
}

const V4A_MARKERS = /^\s*\*\*\*\s*(Begin Patch|(Update|Add|Delete) File:)/m;
const SR_DIVIDER = /^\s*={5,9}\s*$/m;
const UNIFIED_MARKERS = /^(diff --git |@@.*@@|@@\s*$)/m;
const UNIFIED_HEADERS = /^--- .+\n\+\+\+ .+/m;

/** Guess the format of a patch string. Returns null if it is not recognisable. */
export function detectFormat(text: string): Exclude<PatchFormat, 'edits'> | null {
  const t = toLF(text);
  if (V4A_MARKERS.test(t)) return 'v4a';
  if (t.split('\n').some((l) => SEARCH_START.test(l)) && SR_DIVIDER.test(t)) return 'search-replace';
  if (UNIFIED_MARKERS.test(t) || UNIFIED_HEADERS.test(t)) return 'unified';
  return null;
}

/** Contents of the fenced code blocks in a markdown string. */
function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  let open: { fence: string; body: string[] } | null = null;
  for (const line of lines) {
    if (open) {
      if (line.trim() === open.fence) {
        out.push(open.body.join('\n'));
        open = null;
      } else {
        open.body.push(line);
      }
    } else {
      const m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (m) open = { fence: m[1], body: [] };
    }
  }
  if (open) out.push(open.body.join('\n'));
  return out;
}

function tryJson(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * Parse a patch written in any supported format into file operations.
 * Accepts raw patches, patches wrapped in markdown fences or surrounded by prose,
 * and JSON (`{"patch": "..."}` or str_replace-style edit objects).
 */
export function parsePatch(input: string | EditInput | EditInput[], options: Pick<ApplyOptions, 'format'> = {}): ParsedPatch {
  if (typeof input !== 'string') return parseEdits(input);

  let text = toLF(stripBom(input));
  const forced = options.format && options.format !== 'auto' ? options.format : null;

  if (forced !== 'edits' && !detectFormat(text)) {
    const json = tryJson(text);
    if (json !== undefined) {
      if (json && typeof json === 'object' && !Array.isArray(json) && typeof (json as { patch?: unknown }).patch === 'string') {
        return parsePatch((json as { patch: string }).patch, options);
      }
      if (Array.isArray(json) ? json.every(isEditLike) : isEditLike(json)) {
        return parseEdits(json as EditInput | EditInput[]);
      }
    }
  }
  if (forced === 'edits') {
    const json = tryJson(text);
    if (json === undefined) throw new PatchParseError('Format "edits" needs JSON edit objects.');
    return parseEdits(json as EditInput | EditInput[]);
  }

  const format = forced ?? detectFormat(text);
  if (!format) {
    throw new PatchParseError(
      'Could not recognise the patch format. Use a unified diff (--- / +++ / @@), ' +
        'an apply_patch block (*** Begin Patch), or SEARCH/REPLACE blocks (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE).',
    );
  }

  const warnings: string[] = [];
  if (format !== 'search-replace' && text.includes('```')) {
    const blocks = fencedBlocks(text).filter((b) => detectFormat(b) === format);
    if (blocks.length) text = blocks.join('\n');
  }

  const ops =
    format === 'v4a' ? parseV4A(text, warnings)
    : format === 'search-replace' ? parseSearchReplace(text, warnings)
    : parseUnified(text, warnings);

  return { format, ops, warnings };
}

export { parseEdits, parseUnified, parseV4A, parseSearchReplace };
