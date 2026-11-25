/**
 * anypatch: apply any LLM-generated code edit.
 *
 * Browser-safe core (no Node APIs). For file system helpers and the agent tool,
 * import from "anypatch/node".
 */

export { applyPatch, applyToString, PatchApplyError } from './apply';
export type { PatchInput, FileSource } from './apply';
export { parsePatch, detectFormat, PatchParseError } from './parse/index';
export { formatResult } from './format';
export type { FormatOptions } from './format';
export { createUnifiedDiff, countChanges } from './diff';
export type { UnifiedDiffOptions } from './diff';
export {
  PATCH_TOOL_NAME,
  PATCH_TOOL_DESCRIPTION,
  patchToolInputSchema,
  patchToolDefinition,
  extractPatchInput,
} from './tool';
export type { ToolFlavor, PatchToolDefinitionOptions } from './tool';
export { VERSION } from './version';
export type * from './types';
