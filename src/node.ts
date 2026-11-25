/**
 * Node.js helpers: apply patches to the file system safely, and a drop-in agent tool.
 *
 *   import { applyPatchToDisk, createPatchTool } from 'anypatch/node';
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import type { ApplyOptions, EditInput, ParsedPatch, PatchIssue, PatchResult } from './types';
import { applyPatch, normalizePath, type PatchInput } from './apply';
import { parsePatch } from './parse/index';
import { formatResult } from './format';
import { extractPatchInput, patchToolDefinition, patchToolInputSchema, PATCH_TOOL_DESCRIPTION, PATCH_TOOL_NAME, type ToolFlavor } from './tool';

export * from './index';

export interface DiskOptions extends ApplyOptions {
  /** Project root that patch paths are relative to (default: process.cwd()). */
  cwd?: string;
  /** Check the patch and report what would change, without writing anything. */
  dryRun?: boolean;
  /** Write the operations that applied even if others failed (default false: all or nothing). */
  partial?: boolean;
  /** Allow paths (and symlink targets) outside `cwd` (default false). */
  allowOutsideCwd?: boolean;
}

export interface DiskResult extends PatchResult {
  /** Paths (relative to cwd, as written in the patch) that were created or modified. */
  written: string[];
  /** Paths that were deleted. */
  deleted: string[];
  dryRun: boolean;
}

function failure(errors: PatchIssue[], format: PatchResult['format'] = null, dryRun = false): DiskResult {
  return { ok: false, format, files: [], operations: [], errors, warnings: [], written: [], deleted: [], dryRun };
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    // The file may not exist yet: resolve its nearest existing parent instead.
    const parent = nodePath.dirname(p);
    if (parent === p) return p;
    return nodePath.join(await realpathOrSelf(parent), nodePath.basename(p));
  }
}

function inside(root: string, target: string): boolean {
  const rel = nodePath.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !nodePath.isAbsolute(rel));
}

/**
 * Apply a patch to files on disk. Reads every file the patch touches, applies all
 * changes in memory, and only then writes (atomically, preserving line endings, BOM
 * and file mode). By default nothing is written unless the whole patch applies.
 */
export async function applyPatchToDisk(patch: PatchInput, options: DiskOptions = {}): Promise<DiskResult> {
  const cwd = nodePath.resolve(options.cwd ?? process.cwd());
  const dryRun = options.dryRun ?? false;

  let parsed: ParsedPatch;
  try {
    parsed = typeof patch === 'string' || Array.isArray(patch) || !('ops' in (patch as object))
      ? parsePatch(patch as string | EditInput | EditInput[], options)
      : (patch as ParsedPatch);
  } catch (err) {
    return failure([{ code: 'PARSE_ERROR', message: (err as Error).message }], null, dryRun);
  }

  const realRoot = await realpathOrSelf(cwd);
  const paths = new Set<string>();
  for (const op of parsed.ops) {
    const p = normalizePath(op.path || options.defaultPath || '');
    if (p) paths.add(p);
    if (op.type === 'update' && op.moveTo) paths.add(normalizePath(op.moveTo));
  }

  const files = new Map<string, string>();
  const absolute = new Map<string, string>();
  const problems: PatchIssue[] = [];
  for (const p of paths) {
    const abs = nodePath.resolve(cwd, p);
    const real = await realpathOrSelf(abs);
    if (!options.allowOutsideCwd && (!inside(cwd, abs) || !inside(realRoot, real))) {
      problems.push({
        code: 'OUTSIDE_ROOT',
        path: p,
        message: `${p} is outside the project directory; refusing to touch it.`,
        hint: 'Use paths relative to the project root.',
      });
      continue;
    }
    absolute.set(p, real);
    try {
      const stat = await fs.stat(real);
      if (stat.isDirectory()) {
        problems.push({ code: 'IO_ERROR', path: p, message: `${p} is a directory, not a file.` });
        continue;
      }
      files.set(p, await fs.readFile(real, 'utf8'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        problems.push({ code: 'IO_ERROR', path: p, message: `Could not read ${p}: ${(err as Error).message}` });
      }
    }
  }
  if (problems.length) return failure(problems, parsed.format, dryRun);

  const result = applyPatch(parsed, files, options);
  const out: DiskResult = { ...result, written: [], deleted: [], dryRun };
  if (dryRun || (!result.ok && !options.partial)) return out;

  for (const f of result.files) {
    const target = absolute.get(f.path) ?? nodePath.resolve(cwd, f.path);
    try {
      if (f.after === null) {
        await fs.rm(target, { force: true });
        out.deleted.push(f.path);
      } else {
        await fs.mkdir(nodePath.dirname(target), { recursive: true });
        await writeAtomic(target, f.after);
        out.written.push(f.path);
      }
    } catch (err) {
      out.ok = false;
      out.errors.push({ code: 'IO_ERROR', path: f.path, message: `Could not write ${f.path}: ${(err as Error).message}` });
    }
  }
  return out;
}

async function writeAtomic(target: string, data: string): Promise<void> {
  let mode: number | undefined;
  try {
    mode = (await fs.stat(target)).mode;
  } catch {
    mode = undefined;
  }
  const tmp = nodePath.join(
    nodePath.dirname(target),
    `.${nodePath.basename(target)}.anypatch-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    await fs.writeFile(tmp, data, 'utf8');
    if (mode !== undefined) await fs.chmod(tmp, mode & 0o7777);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface PatchToolOptions extends DiskOptions {
  /** Tool name (default "apply_patch"). */
  name?: string;
  /** Tool description shown to the model (default explains all accepted formats). */
  description?: string;
}

export interface PatchTool {
  name: string;
  description: string;
  inputSchema: typeof patchToolInputSchema;
  /** The definition in the shape a given API expects (anthropic, openai, openai-responses, mcp, generic). */
  definition(flavor?: ToolFlavor): Record<string, unknown>;
  /** Apply the model's input and return text to send back as the tool result. Never throws. */
  execute(input: unknown): Promise<string>;
  /** Like execute, but also returns the structured result. */
  run(input: unknown): Promise<{ ok: boolean; output: string; result: DiskResult | null }>;
}

/**
 * A complete apply_patch tool for an agent: give `definition()` to the model and pass
 * whatever it calls the tool with to `execute()`.
 */
export function createPatchTool(options: PatchToolOptions = {}): PatchTool {
  const name = options.name ?? PATCH_TOOL_NAME;
  const description = options.description ?? PATCH_TOOL_DESCRIPTION;
  const run = async (input: unknown) => {
    try {
      const patch = extractPatchInput(input) as PatchInput;
      const result = await applyPatchToDisk(patch, options);
      const written = result.dryRun ? 'dry-run' : result.ok ? true : options.partial ? 'partial' : false;
      return { ok: result.ok, output: formatResult(result, { written }), result };
    } catch (err) {
      return { ok: false, output: `apply_patch failed unexpectedly: ${(err as Error).message}`, result: null };
    }
  };
  return {
    name,
    description,
    inputSchema: patchToolInputSchema,
    definition: (flavor: ToolFlavor = 'generic') => patchToolDefinition(flavor, { name, description }),
    execute: async (input: unknown) => (await run(input)).output,
    run,
  };
}

export interface OpenAIApplyPatchCall {
  type?: string;
  call_id: string;
  operation: { type: string; path: string; diff?: string };
}

/**
 * Handle an `apply_patch_call` item from the OpenAI Responses API and return the
 * `apply_patch_call_output` item to send back.
 */
export async function handleOpenAIApplyPatchCall(
  call: OpenAIApplyPatchCall,
  options: DiskOptions = {},
): Promise<{ type: 'apply_patch_call_output'; call_id: string; status: 'completed' | 'failed'; output: string }> {
  const result = await applyPatchToDisk(call.operation as EditInput, options);
  const written = result.dryRun ? 'dry-run' : result.ok ? true : options.partial ? 'partial' : false;
  return {
    type: 'apply_patch_call_output',
    call_id: call.call_id,
    status: result.ok ? 'completed' : 'failed',
    output: formatResult(result, { written }),
  };
}
