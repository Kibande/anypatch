/** Turning a PatchResult into text a person or a model can act on. */

import type { MatchLevel, PatchResult } from './types';

const FORMAT_NAMES: Record<string, string> = {
  unified: 'unified diff',
  v4a: 'apply_patch',
  'search-replace': 'SEARCH/REPLACE',
  edits: 'edits',
};

const LEVEL_NOTES: Record<MatchLevel, string> = {
  exact: '',
  'trailing-whitespace': 'ignoring trailing whitespace',
  indentation: 'ignoring indentation (new lines were re-indented to fit)',
  unicode: 'after normalizing quotes, dashes and spaces',
  fuzzy: 'by approximate similarity; review this change',
};

export interface FormatOptions {
  /**
   * What happened on disk, to phrase the outcome. `true`: changes were written.
   * `'partial'`: clean operations were written and failed ones were not.
   * `false` (default for failures): nothing was written. `'dry-run'`: checked only.
   */
  written?: boolean | 'partial' | 'dry-run';
  /** Include warnings and match notes (default true). */
  notes?: boolean;
}

/**
 * Summarize a result in plain text, designed to be returned to a model as a tool result:
 * what changed, how loosely each hunk matched, and for failures the closest match and how to fix it.
 */
export function formatResult(result: PatchResult, options: FormatOptions = {}): string {
  const notes = options.notes ?? true;
  const written = options.written ?? result.ok;
  const out: string[] = [];
  const fmt = result.format ? ` (${FORMAT_NAMES[result.format] ?? result.format})` : '';

  const moves = new Map<string, string>();
  for (const op of result.operations) if (op.moveTo && op.status === 'applied') moves.set(op.path, op.moveTo);
  const moveTargets = new Map([...moves].map(([from, to]) => [to, from]));

  const fileLines = (): string[] => {
    const lines: string[] = [];
    for (const f of result.files) {
      if (f.type === 'delete' && moves.has(f.path)) continue;
      if (f.type === 'create' && moveTargets.has(f.path)) {
        lines.push(`  R ${moveTargets.get(f.path)} -> ${f.path}`);
        continue;
      }
      const mark = f.type === 'create' ? 'A' : f.type === 'delete' ? 'D' : 'M';
      const counts = f.type === 'delete' ? '' : ` (+${f.added} -${f.removed})`;
      lines.push(`  ${mark} ${f.path}${counts}`);
    }
    return lines;
  };

  const matchNotes = (): string[] => {
    const lines: string[] = [];
    for (const op of result.operations) {
      if (op.status !== 'applied') continue;
      for (const h of op.hunks) {
        if (h.status !== 'applied') continue;
        const bits: string[] = [];
        if (h.match && h.match !== 'exact') bits.push(LEVEL_NOTES[h.match]);
        if (h.contextTrimmed) bits.push(`after dropping ${h.contextTrimmed} context line${h.contextTrimmed === 1 ? '' : 's'} that did not match`);
        if (bits.length) lines.push(`  - ${op.path || 'input'} hunk ${h.index} applied at line ${h.line} ${bits.join(', ')}`);
      }
    }
    return lines;
  };

  if (result.ok) {
    const n = result.files.length;
    if (n === 0) {
      out.push(`Patch applied${fmt}: no changes were needed (the edits are already present).`);
    } else {
      const verb = written === 'dry-run' ? 'Patch checks out' : 'Patch applied';
      out.push(`${verb}${fmt}: ${n} file${n === 1 ? '' : 's'} ${written === 'dry-run' ? 'would change' : 'changed'}.`);
      out.push(...fileLines());
    }
    if (notes) {
      const mn = matchNotes();
      if (mn.length) out.push('Notes:', ...mn);
      if (result.warnings.length) out.push('Warnings:', ...result.warnings.map((w) => `  - ${w}`));
    }
    return out.join('\n');
  }

  const errs = result.errors;
  if (errs.length === 1 && errs[0].code === 'PARSE_ERROR') {
    return `Patch could not be parsed: ${errs[0].message}`;
  }

  const outcome =
    written === 'partial' ? 'The operations that applied cleanly were written; the failed ones were not.'
    : written === 'dry-run' ? 'Dry run: nothing was written.'
    : 'No files were changed.';
  out.push(`Patch failed${fmt}: ${errs.length} problem${errs.length === 1 ? '' : 's'}. ${outcome}`);
  out.push('');
  errs.forEach((e, i) => {
    const where = [e.path, e.hunk !== undefined ? `hunk ${e.hunk}` : ''].filter(Boolean).join(', ');
    out.push(`${i + 1}. ${where ? where + ': ' : ''}${e.message}`);
    if (e.hint) for (const line of e.hint.split('\n')) out.push(`   ${line}`);
  });

  const okHunks: string[] = [];
  for (const op of result.operations) {
    const good = op.hunks.filter((h) => h.status !== 'failed').map((h) => h.index);
    if (op.status === 'applied') okHunks.push(`${op.path} (${op.type})`);
    else if (good.length) okHunks.push(`${op.path} hunk${good.length === 1 ? '' : 's'} ${good.join(', ')}`);
  }
  if (okHunks.length) {
    out.push('');
    out.push(`These parts matched and are fine: ${okHunks.join('; ')}.`);
  }
  out.push('');
  out.push(
    written === 'partial'
      ? 'Send a new patch containing only the failed parts.'
      : 'Fix the failed parts and send the whole patch again.',
  );
  if (notes && result.warnings.length) out.push('Warnings:', ...result.warnings.map((w) => `  - ${w}`));
  return out.join('\n');
}
