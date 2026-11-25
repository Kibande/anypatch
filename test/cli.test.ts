import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { L } from './helpers';
import { VERSION } from '../src/index';
import pkg from '../package.json';

const cli = path.resolve(__dirname, '../dist/cli.js');
const built = existsSync(cli);
let dir: string;

const run = (args: string[], input?: string) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: dir, input, encoding: 'utf8' });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anypatch-cli-'));
  await fs.writeFile(path.join(dir, 'a.txt'), L('one', 'two'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('version', () => {
  it('matches package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });
});

describe.skipIf(!built)('cli (built)', () => {
  const patch = L('--- a/a.txt', '+++ b/a.txt', '@@', ' one', '-two', '+2');

  it('applies a patch from stdin', async () => {
    const r = run([], patch);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Patch applied/);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe(L('one', '2'));
  });

  it('applies a patch from a file with --diff output', async () => {
    await fs.writeFile(path.join(dir, 'p.diff'), patch);
    const r = run(['p.diff', '--diff']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('-two\n+2');
  });

  it('dry run leaves files alone', async () => {
    const r = run(['--dry-run'], patch);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/would change/);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe(L('one', 'two'));
  });

  it('exits 1 with a model-readable report on failure', () => {
    const r = run([], patch.replace('-two', '-three'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Patch failed/);
    expect(r.stderr).toMatch(/Closest match/);
  });

  it('prints JSON with --json', () => {
    const r = run(['--json'], patch);
    const json = JSON.parse(r.stdout);
    expect(json.ok).toBe(true);
    expect(json.written).toEqual(['a.txt']);
  });

  it('exits 2 on usage errors', () => {
    expect(run(['--nope']).status).toBe(2);
    expect(run(['--format', 'xml'], patch).status).toBe(2);
  });

  it('prints help and version', () => {
    expect(run(['--help']).stdout).toMatch(/Usage:/);
    expect(run(['--version']).stdout.trim()).toBe(VERSION);
  });
});
