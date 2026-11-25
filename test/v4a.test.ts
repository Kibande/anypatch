import { describe, expect, it } from 'vitest';
import { applyPatch, applyToString } from '../src/index';
import { L } from './helpers';

const py = L(
  'class Greeter:',
  '    def greet(self, name):',
  '        return f"hi {name}"',
  '',
  '    def bye(self, name):',
  '        return f"bye {name}"',
  '',
  'class Other:',
  '    def greet(self, name):',
  '        return f"hi {name}"',
);

describe('V4A / apply_patch', () => {
  it('applies an update with an anchor', () => {
    const patch = L(
      '*** Begin Patch',
      '*** Update File: greet.py',
      '@@ class Other:',
      '     def greet(self, name):',
      '-        return f"hi {name}"',
      '+        return f"hello {name}"',
      '*** End Patch',
    );
    const r = applyPatch(patch, { 'greet.py': py });
    expect(r.ok).toBe(true);
    expect(r.format).toBe('v4a');
    const out = r.files[0].after!.split('\n');
    expect(out[2]).toBe('        return f"hi {name}"');
    expect(out[9]).toBe('        return f"hello {name}"');
  });

  it('supports nested anchors', () => {
    const patch = L(
      '*** Begin Patch',
      '*** Update File: greet.py',
      '@@ class Greeter:',
      '@@     def bye(self, name):',
      '-        return f"bye {name}"',
      '+        return f"goodbye {name}"',
      '*** End Patch',
    );
    expect(applyToString(py, patch)).toContain('goodbye');
  });

  it('accepts partial anchors (prefix of the real line)', () => {
    const patch = L('*** Begin Patch', '*** Update File: greet.py', '@@ class Other', '-        return f"hi {name}"', '+        return 1', '*** End Patch');
    const out = applyToString(py, patch).split('\n');
    expect(out[2]).toBe('        return f"hi {name}"');
    expect(out[9]).toBe('        return 1');
  });

  it('adds, deletes and moves files in one patch', () => {
    const patch = L(
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const a = 1;',
      '+export const b = 2;',
      '*** Delete File: src/dead.ts',
      '*** Update File: src/old.ts',
      '*** Move to: src/moved.ts',
      '@@',
      '-export const v = 1;',
      '+export const v = 2;',
      '*** End Patch',
    );
    const r = applyPatch(patch, { 'src/dead.ts': 'x\n', 'src/old.ts': 'export const v = 1;\n' });
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(by['src/new.ts']).toMatchObject({ type: 'create', after: 'export const a = 1;\nexport const b = 2;\n' });
    expect(by['src/dead.ts']).toMatchObject({ type: 'delete' });
    expect(by['src/old.ts']).toMatchObject({ type: 'delete' });
    expect(by['src/moved.ts']).toMatchObject({ type: 'create', after: 'export const v = 2;\n' });
  });

  it('honours *** End of File', () => {
    const file = L('x', 'end', 'x', 'end');
    const patch = L('*** Begin Patch', '*** Update File: f', '@@', ' x', '-end', '+END', '*** End of File', '*** End Patch');
    expect(applyToString(file, patch)).toBe(L('x', 'end', 'x', 'END'));
  });

  it('applies several chunks in order', () => {
    const file = L('a', 'b', 'c', 'd', 'e', 'f');
    const patch = L('*** Begin Patch', '*** Update File: f', '@@', ' a', '-b', '+B', '@@', ' e', '-f', '+F', '*** End Patch');
    expect(applyToString(file, patch)).toBe(L('a', 'B', 'c', 'd', 'e', 'F'));
  });

  it('is lenient about a missing Begin/End envelope and unprefixed context lines', () => {
    const patch = L('*** Update File: f', '@@', 'a', '-b', '+B');
    const r = applyPatch(patch, { f: L('a', 'b') });
    expect(r.ok).toBe(true);
    expect(r.files[0].after).toBe(L('a', 'B'));
    expect(r.warnings.join(' ')).toMatch(/Begin Patch/);
  });

  it('inserts after an anchor when a chunk only adds lines', () => {
    const file = L('def a():', '    pass', 'def b():', '    pass');
    const patch = L('*** Begin Patch', '*** Update File: f', '@@ def b():', '+    print("b")', '*** End Patch');
    expect(applyToString(file, patch)).toBe(L('def a():', '    pass', 'def b():', '    print("b")', '    pass'));
  });

  it('refuses to add a file that already exists with other content', () => {
    const patch = L('*** Begin Patch', '*** Add File: f', '+new', '*** End Patch');
    const r = applyPatch(patch, { f: 'old\n' });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('FILE_EXISTS');
  });

  it('reports a missing file for updates', () => {
    const r = applyPatch(L('*** Begin Patch', '*** Update File: nope.ts', '-a', '+b', '*** End Patch'), {});
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: 'FILE_NOT_FOUND', path: 'nope.ts' });
    expect(r.errors[0].hint).toMatch(/Add File/);
  });

  it('accepts OpenAI Responses API apply_patch operations', () => {
    const update = { type: 'update_file', path: 'f', diff: L('@@', '-a', '+A') };
    expect(applyPatch(update, { f: 'a\n' }).files[0].after).toBe('A\n');
    const create = { type: 'create_file', path: 'g', diff: L('+one', '+two') };
    expect(applyPatch(create, {}).files[0]).toMatchObject({ type: 'create', after: 'one\ntwo\n' });
    const del = { type: 'delete_file', path: 'f' };
    expect(applyPatch(del, { f: 'a\n' }).files[0].type).toBe('delete');
    const call = { type: 'apply_patch_call', call_id: 'c1', operation: update };
    expect(applyPatch(call, { f: 'a\n' }).files[0].after).toBe('A\n');
  });
});
