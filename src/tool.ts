/** A ready-made "apply_patch" tool definition for any agent framework or model API. */

export const PATCH_TOOL_NAME = 'apply_patch';

export const PATCH_TOOL_DESCRIPTION = `Edit files by applying a patch. Paths are relative to the project root. Use any ONE of these formats per call.

1. Unified diff:
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,3 @@
 unchanged line
-old line
+new line
 unchanged line

2. apply_patch:
*** Begin Patch
*** Update File: src/app.ts
@@ function main() {
   unchanged line
-  old line
+  new line
*** Add File: src/new.ts
+every line of the new file, prefixed with +
*** Delete File: src/old.ts
*** End Patch

3. SEARCH/REPLACE blocks, each directly below its file path:
src/app.ts
<<<<<<< SEARCH
exact lines currently in the file
=======
lines to put in their place
>>>>>>> REPLACE

Include 2-3 unchanged lines around each change and copy them exactly from the file. Small whitespace or indentation differences are tolerated. If a hunk fails, the result shows the closest matching lines in the current file: correct the patch from those lines and call the tool again.`;

export const patchToolInputSchema = {
  type: 'object',
  properties: {
    patch: {
      type: 'string',
      description: 'The patch: a unified diff, an apply_patch block (*** Begin Patch ... *** End Patch), or SEARCH/REPLACE blocks.',
    },
  },
  required: ['patch'],
  additionalProperties: false,
} as const;

export type ToolFlavor = 'anthropic' | 'openai' | 'openai-responses' | 'mcp' | 'generic';

export interface PatchToolDefinitionOptions {
  name?: string;
  description?: string;
}

/**
 * The tool definition in the shape each API expects:
 * - `anthropic`: { name, description, input_schema }
 * - `openai` (Chat Completions): { type: 'function', function: { name, description, parameters, strict } }
 * - `openai-responses`: { type: 'function', name, description, parameters, strict }
 * - `mcp`: { name, description, inputSchema }
 * - `generic`: { name, description, parameters }
 */
export function patchToolDefinition(flavor: ToolFlavor = 'generic', options: PatchToolDefinitionOptions = {}): Record<string, unknown> {
  const name = options.name ?? PATCH_TOOL_NAME;
  const description = options.description ?? PATCH_TOOL_DESCRIPTION;
  const schema = JSON.parse(JSON.stringify(patchToolInputSchema));
  switch (flavor) {
    case 'anthropic':
      return { name, description, input_schema: schema };
    case 'openai':
      return { type: 'function', function: { name, description, parameters: schema, strict: true } };
    case 'openai-responses':
      return { type: 'function', name, description, parameters: schema, strict: true };
    case 'mcp':
      return { name, description, inputSchema: schema };
    default:
      return { name, description, parameters: schema };
  }
}

/** Pull the patch out of whatever a model passed to the tool: a string, { patch }, { input }, or edit objects. */
export function extractPatchInput(input: unknown): unknown {
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('{')) {
      try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed.patch === 'string') return parsed.patch;
      } catch {
        // not JSON: treat as patch text
      }
    }
    return input;
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    for (const key of ['patch', 'input', 'diff_text', 'content']) {
      if (typeof o[key] === 'string' && !('path' in o)) return o[key];
    }
    if (Array.isArray(o.edits)) return o.edits;
  }
  return input;
}
