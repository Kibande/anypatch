import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyPatchToDisk, createPatchTool, handleOpenAIApplyPatchCall } from '../src/node';
import { L } from './helpers';

let dir: string;
const read = (p: string) => fs.readFile(path.join(dir, p), 'utf8');
const exists = (p: string) => fs.access(path.join(dir, p)).then(() => true, () => false);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anypatch-'));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src/a.txt'), L('one', 'two', 'three'));
  await fs.writeFile(path.join(dir, 'src/b.txt'), L('alpha', 'beta'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const twoFiles = L(
  '*** Begin Patch',
  '*** Update File: src/a.txt',
  '-two',
  '+TWO',
  '*** Update File: src/b.txt',
  '-beta',
  '+BETA',
  '*** Add File: src/deep/new.txt',
  '+hi',
  '*** End Patch',
);

describe('applyPatchToDisk', () => {
  it('writes every change when the patch applies', async () => {
    const r = await applyPatchToDisk(twoFiles, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.written.sort()).toEqual(['src/a.txt', 'src/b.txt', 'src/deep/new.txt']);
    expect(await read('src/a.txt')).toBe(L('one', 'TWO', 'three'));
    expect(await read('src/deep/new.txt')).toBe('hi\n');
  });

  it('writes nothing if any part fails (all or nothing)', async () => {
    const bad = twoFiles.replace('-beta', '-gamma');
    const r = await applyPatchToDisk(bad, { cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.written).toEqual([]);
    expect(await read('src/a.txt')).toBe(L('one', 'two', 'three'));
    expect(await exists('src/deep/new.txt')).toBe(false);
  });

  it('writes the clean parts with partial: true', async () => {
    const bad = twoFiles.replace('-beta', '-gamma');
    const r = await applyPatchToDisk(bad, { cwd: dir, partial: true });
    expect(r.ok).toBe(false);
    expect(r.written.sort()).toEqual(['src/a.txt', 'src/deep/new.txt']);
    expect(await read('src/b.txt')).toBe(L('alpha', 'beta'));
  });

  it('dry run reports without writing', async () => {
    const r = await applyPatchToDisk(twoFiles, { cwd: dir, dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(3);
    expect(r.written).toEqual([]);
    expect(await read('src/a.txt')).toBe(L('one', 'two', 'three'));
  });

  it('refuses paths outside the project root', async () => {
    const r = await applyPatchToDisk(L('*** Begin Patch', '*** Add File: ../escape.txt', '+x', '*** End Patch'), { cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('OUTSIDE_ROOT');
    expect(await fs.access(path.join(dir, '..', 'escape.txt')).then(() => true, () => false)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses to write through a symlink that points outside the root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'anypatch-out-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n');
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
      const r = await applyPatchToDisk({ path: 'link.txt', old_str: 'secret', new_str: 'pwned' }, { cwd: dir });
      expect(r.ok).toBe(false);
      expect(r.errors[0].code).toBe('OUTSIDE_ROOT');
      expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('writes through an in-project symlink without replacing the link', async () => {
    await fs.symlink(path.join(dir, 'src/a.txt'), path.join(dir, 'alias.txt'));
    const r = await applyPatchToDisk({ path: 'alias.txt', old_str: 'two', new_str: '2' }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect((await fs.lstat(path.join(dir, 'alias.txt'))).isSymbolicLink()).toBe(true);
    expect(await read('src/a.txt')).toBe(L('one', '2', 'three'));
  });

  it('preserves file mode and CRLF line endings', async () => {
    const script = path.join(dir, 'run.sh');
    await fs.writeFile(script, '#!/bin/sh\r\necho hi\r\n');
    await fs.chmod(script, 0o755);
    const r = await applyPatchToDisk({ path: 'run.sh', old_str: 'echo hi', new_str: 'echo hello' }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(await read('run.sh')).toBe('#!/bin/sh\r\necho hello\r\n');
    if (process.platform !== 'win32') expect((await fs.stat(script)).mode & 0o777).toBe(0o755);
  });

  it('deletes and moves files', async () => {
    const patch = L(
      '*** Begin Patch',
      '*** Delete File: src/b.txt',
      '*** Update File: src/a.txt',
      '*** Move to: lib/a.txt',
      '@@',
      '-one',
      '+ONE',
      '*** End Patch',
    );
    const r = await applyPatchToDisk(patch, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(await exists('src/b.txt')).toBe(false);
    expect(await exists('src/a.txt')).toBe(false);
    expect(await read('lib/a.txt')).toBe(L('ONE', 'two', 'three'));
    expect(r.deleted.sort()).toEqual(['src/a.txt', 'src/b.txt']);
  });

  it('leaves no temp files behind', async () => {
    await applyPatchToDisk(twoFiles, { cwd: dir });
    const names = await fs.readdir(path.join(dir, 'src'));
    expect(names.some((n) => n.includes('anypatch'))).toBe(false);
  });
});

describe('createPatchTool', () => {
  it('produces definitions for each API', () => {
    const tool = createPatchTool({ cwd: dir });
    expect(tool.definition('anthropic')).toMatchObject({ name: 'apply_patch', input_schema: { required: ['patch'] } });
    expect(tool.definition('openai')).toMatchObject({ type: 'function', function: { name: 'apply_patch', strict: true } });
    expect(tool.definition('openai-responses')).toMatchObject({ type: 'function', name: 'apply_patch' });
    expect(tool.definition('mcp')).toHaveProperty('inputSchema');
  });

  it('executes model input and returns text, never throwing', async () => {
    const tool = createPatchTool({ cwd: dir });
    const ok = await tool.execute({ patch: L('src/a.txt', '<<<<<<< SEARCH', 'two', '=======', 'deux', '>>>>>>> REPLACE') });
    expect(ok).toMatch(/^Patch applied \(SEARCH\/REPLACE\): 1 file changed/);
    expect(await read('src/a.txt')).toBe(L('one', 'deux', 'three'));

    const fail = await tool.execute(JSON.stringify({ patch: L('--- a/src/a.txt', '+++ b/src/a.txt', '@@', '-zzz', '+y') }));
    expect(fail).toMatch(/Patch failed/);
    expect(fail).toMatch(/No files were changed/);

    expect(await tool.execute(42)).toMatch(/could not be parsed|failed/i);
  });
});

describe('handleOpenAIApplyPatchCall', () => {
  it('returns an apply_patch_call_output item', async () => {
    const out = await handleOpenAIApplyPatchCall(
      { type: 'apply_patch_call', call_id: 'call_1', operation: { type: 'update_file', path: 'src/a.txt', diff: L('@@', ' one', '-two', '+2') } },
      { cwd: dir },
    );
    expect(out).toMatchObject({ type: 'apply_patch_call_output', call_id: 'call_1', status: 'completed' });
    expect(await read('src/a.txt')).toBe(L('one', '2', 'three'));

    const failed = await handleOpenAIApplyPatchCall(
      { call_id: 'call_2', operation: { type: 'update_file', path: 'missing.txt', diff: L('@@', '-a', '+b') } },
      { cwd: dir },
    );
    expect(failed.status).toBe('failed');
    expect(failed.output).toMatch(/does not exist/);
  });
});
