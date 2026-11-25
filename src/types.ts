/** Patch formats anypatch can read. */
export type PatchFormat = 'unified' | 'v4a' | 'search-replace' | 'edits';

/** How exactly a hunk was located in the file, from strictest to loosest. */
export type MatchLevel =
  | 'exact'
  | 'trailing-whitespace'
  | 'indentation'
  | 'unicode'
  | 'fuzzy';

/**
 * One change inside a file, in the format-neutral form every parser produces.
 *
 * `lines` hunks (unified diff, V4A) are matched line by line.
 * `text` hunks (SEARCH/REPLACE, str_replace) are first matched as an exact
 * substring and fall back to line matching.
 */
export interface Hunk {
  mode: 'lines' | 'text';
  /** Lines the file is expected to contain: context plus removed lines. */
  oldLines: string[];
  /** Lines that replace them: context plus added lines. */
  newLines: string[];
  /** Raw search text (text mode). */
  oldText?: string;
  /** Raw replacement text (text mode). */
  newText?: string;
  /** V4A `@@ anchor` lines: the hunk is searched for after these lines. */
  anchors?: string[];
  /** 0-based line where the hunk is expected to start (unified diff header, Roo :start_line:). */
  lineHint?: number;
  /** Pure insertion after this many lines (0 = top of file). */
  insertAfterLine?: number;
  /** The hunk must sit at the end of the file (V4A `*** End of File`). */
  atEof?: boolean;
  /** Replace every occurrence instead of exactly one. */
  replaceAll?: boolean;
  /** What to do when the hunk matches in more than one place. */
  ambiguity: 'first' | 'error';
  /** Whether the file should end with a newline when this hunk touches the end of the file. */
  eofNewline?: boolean;
}

export type FileOp =
  | { type: 'update'; path: string; moveTo?: string; hunks: Hunk[] }
  | { type: 'create'; path: string; content: string; overwrite?: boolean }
  | { type: 'delete'; path: string };

export interface ParsedPatch {
  format: PatchFormat;
  ops: FileOp[];
  warnings: string[];
}

export type IssueCode =
  | 'PARSE_ERROR'
  | 'EMPTY_PATCH'
  | 'NO_PATH'
  | 'FILE_NOT_FOUND'
  | 'FILE_EXISTS'
  | 'NO_MATCH'
  | 'AMBIGUOUS'
  | 'OUTSIDE_ROOT'
  | 'BINARY_FILE'
  | 'IO_ERROR';

export interface PatchIssue {
  code: IssueCode;
  /** File the issue concerns, when known. */
  path?: string;
  /** 1-based hunk number within its file operation. */
  hunk?: number;
  message: string;
  /** Extra detail written for a model to act on: closest match, line numbers, what to change. */
  hint?: string;
}

export interface HunkResult {
  /** 1-based hunk number within its file operation. */
  index: number;
  status: 'applied' | 'already-applied' | 'failed';
  /** How the hunk was located (applied hunks only). */
  match?: MatchLevel;
  /** 1-based line where the hunk was applied. */
  line?: number;
  /** Context lines dropped from the hunk's edges to make it match. */
  contextTrimmed?: number;
  /** Number of places changed (more than 1 only with replaceAll). */
  occurrences?: number;
}

export interface OperationResult {
  type: FileOp['type'];
  path: string;
  moveTo?: string;
  status: 'applied' | 'failed';
  hunks: HunkResult[];
}

export interface FileChange {
  path: string;
  type: 'create' | 'update' | 'delete';
  /** Content before the patch; null if the file did not exist. */
  before: string | null;
  /** Content after the patch; null if the file is deleted. */
  after: string | null;
  added: number;
  removed: number;
}

export interface PatchResult {
  /** True when every operation and hunk applied. */
  ok: boolean;
  /** Detected format; null if the patch could not be parsed. */
  format: PatchFormat | null;
  /** Final state of every file the patch changed (successful operations only). */
  files: FileChange[];
  /** Per-operation detail, in patch order. */
  operations: OperationResult[];
  errors: PatchIssue[];
  warnings: string[];
}

/** Reads a file's current content; returns null/undefined when it does not exist. */
export type FileReader = (path: string) => string | null | undefined;

export interface ApplyOptions {
  /** Force a format instead of auto-detecting. */
  format?: PatchFormat | 'auto';
  /** Target file for patches that name none (bare `@@` hunks, SEARCH/REPLACE blocks without a filename). */
  defaultPath?: string;
  /** Tolerate whitespace and indentation differences (default true). */
  ignoreWhitespace?: boolean;
  /** Treat smart quotes, dashes and non-breaking spaces as their ASCII forms (default true). */
  normalizeUnicode?: boolean;
  /**
   * Similarity matching for lines the model got slightly wrong.
   * Off by default. `true` uses a 0.9 threshold; pass a number in (0, 1] to set it.
   */
  fuzzy?: boolean | number;
  /** How many unchanged context lines may be dropped from each edge of a hunk to make it match (default 2). */
  maxContextTrim?: number;
  /** Treat a hunk whose result is already in the file as applied (default true). */
  detectAlreadyApplied?: boolean;
}

/** Object-style edit, as produced by str_replace / Edit / Write tools. Field aliases from common tools are accepted. */
export interface EditInput {
  path?: string;
  file_path?: string;
  filePath?: string;
  file?: string;
  command?: 'str_replace' | 'create' | 'insert' | 'delete' | 'write' | string;
  old_str?: string;
  new_str?: string;
  old_string?: string;
  new_string?: string;
  oldText?: string;
  newText?: string;
  search?: string;
  replace?: string;
  file_text?: string;
  content?: string;
  insert_line?: number;
  insertLine?: number;
  replace_all?: boolean;
  replaceAll?: boolean;
  /** OpenAI apply_patch operation type: 'create_file' | 'update_file' | 'delete_file'. */
  type?: string;
  /** OpenAI apply_patch V4A diff body. */
  diff?: string;
  /** A whole OpenAI `apply_patch_call` item: its operation is used. */
  operation?: EditInput;
}
