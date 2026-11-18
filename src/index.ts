export { parse, type InvalidOwnerPolicy, type ParseOptions } from './parser.js';
export {
  compilePattern,
  normalizePath,
  PatternError,
  type CompiledPattern,
  type CompileOptions,
} from './pattern.js';
export { classifyOwner, isValidOwner, type OwnerKind } from './owners.js';
export { analyze, lint, MAX_CODEOWNERS_BYTES, type LintOptions, type OwnershipReport } from './lint.js';
export { VERSION } from './version.js';
export type {
  Codeowners,
  Diagnostic,
  DiagnosticCode,
  Dialect,
  OwnershipMatch,
  Rule,
  Section,
  Severity,
} from './types.js';

import { parse, type ParseOptions } from './parser.js';

/**
 * One-shot helper: owners of `path` according to the CODEOWNERS `content`.
 * Parse once with {@link parse} when you query many paths.
 */
export function ownersOf(content: string, path: string, options: ParseOptions = {}): readonly string[] {
  return parse(content, options).ownersOf(path);
}
