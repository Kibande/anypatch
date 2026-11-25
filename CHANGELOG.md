# Changelog

## 0.1.0

First release.

- Parsers for unified/git diffs, V4A `apply_patch`, SEARCH/REPLACE blocks (Aider, Cline, Roo) and str_replace-style edit objects, with automatic format detection.
- Layered matching: exact, trailing whitespace, indentation (with re-indent), unicode normalization, context trimming, and opt-in fuzzy similarity.
- Model-facing failure reports with the closest match in the current file.
- `applyPatchToDisk` with all-or-nothing atomic writes, path sandboxing and symlink checks.
- `createPatchTool` for Anthropic, OpenAI, MCP and the Vercel AI SDK; `handleOpenAIApplyPatchCall` for OpenAI's built-in tool.
- `createUnifiedDiff` (Myers) and the `anypatch` CLI.
