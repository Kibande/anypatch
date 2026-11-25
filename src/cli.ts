import { readFileSync } from 'node:fs';
import { applyPatchToDisk, createUnifiedDiff, formatResult, VERSION, type DiskOptions } from './node';
import type { PatchFormat } from './types';

const HELP = `anypatch ${VERSION}
Apply a patch written by an LLM: unified diff, apply_patch (V4A), SEARCH/REPLACE blocks,
or JSON str_replace edits. Reads the patch from a file or from stdin.

Usage:
  anypatch [patch-file] [options]
  cat patch.txt | anypatch [options]

Options:
  -C, --cwd <dir>        Project root the patch paths are relative to (default: .)
  -n, --dry-run          Check the patch and report what would change; write nothing
      --partial          Write the parts that applied even if others failed
  -f, --format <fmt>     Force a format: unified | v4a | search-replace | edits
  -p, --path <file>      Target file for patches that name none
      --fuzzy [n]        Also match lines by similarity (threshold 0-1, default 0.9)
      --strict           Exact matching only (no whitespace/unicode tolerance, no context trimming)
      --allow-outside    Allow paths outside the project root
      --diff             Print a unified diff of the resulting changes
      --json             Print the full result as JSON
  -q, --quiet            Print nothing on success
  -h, --help             Show this help
  -v, --version          Show the version

Exit codes: 0 applied, 1 failed, 2 usage error.`;

interface Args {
  file?: string;
  opts: DiskOptions;
  json: boolean;
  diff: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { opts: {}, json: false, diff: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const [flag, inline] = raw.startsWith('--') && raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '-h': case '--help':
        process.stdout.write(HELP + '\n');
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case '-v': case '--version':
        process.stdout.write(VERSION + '\n');
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case '-C': case '--cwd': args.opts.cwd = value(); break;
      case '-n': case '--dry-run': args.opts.dryRun = true; break;
      case '--partial': args.opts.partial = true; break;
      case '-f': case '--format': {
        const f = value();
        if (!['unified', 'v4a', 'search-replace', 'edits', 'auto'].includes(f)) throw new UsageError(`unknown format "${f}"`);
        args.opts.format = f as PatchFormat;
        break;
      }
      case '-p': case '--path': args.opts.defaultPath = value(); break;
      case '--fuzzy': {
        let threshold = 0.9;
        if (inline !== undefined) threshold = Number(inline);
        else if (argv[i + 1] !== undefined && /^(0(\.\d+)?|1(\.0+)?)$/.test(argv[i + 1])) threshold = Number(argv[++i]);
        if (!(threshold > 0 && threshold <= 1)) throw new UsageError('--fuzzy threshold must be between 0 and 1');
        args.opts.fuzzy = threshold;
        break;
      }
      case '--strict':
        args.opts.ignoreWhitespace = false;
        args.opts.normalizeUnicode = false;
        args.opts.maxContextTrim = 0;
        break;
      case '--allow-outside': args.opts.allowOutsideCwd = true; break;
      case '--diff': args.diff = true; break;
      case '--json': args.json = true; break;
      case '-q': case '--quiet': args.quiet = true; break;
      default:
        if (flag.startsWith('-') && flag !== '-') throw new UsageError(`unknown option ${flag}`);
        if (args.file !== undefined) throw new UsageError('only one patch file can be given');
        args.file = flag;
    }
  }
  return args;
}

class UsageError extends Error {}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`anypatch: ${err.message}\nRun "anypatch --help" for usage.\n`);
      return 2;
    }
    throw err;
  }

  let patch: string;
  if (args.file && args.file !== '-') {
    try {
      patch = readFileSync(args.file, 'utf8');
    } catch (err) {
      process.stderr.write(`anypatch: cannot read ${args.file}: ${(err as Error).message}\n`);
      return 2;
    }
  } else {
    if (process.stdin.isTTY) {
      process.stderr.write('anypatch: no patch given. Pass a file or pipe a patch into stdin.\nRun "anypatch --help" for usage.\n');
      return 2;
    }
    patch = await readStdin();
  }

  const result = await applyPatchToDisk(patch, args.opts);

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? 0 : 1;
  }

  const written = result.dryRun ? 'dry-run' : result.ok ? true : args.opts.partial ? 'partial' : false;
  const text = formatResult(result, { written });
  if (result.ok) {
    if (!args.quiet) process.stdout.write(text + '\n');
  } else {
    process.stderr.write(text + '\n');
  }
  if (args.diff) {
    for (const f of result.files) {
      process.stdout.write(createUnifiedDiff(f.before, f.after, { oldPath: f.path, newPath: f.path }));
    }
  }
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`anypatch: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
