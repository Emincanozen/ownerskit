import type { CompiledPattern } from './pattern.js';

/** `github` is the default. `gitlab` adds `[Section]` headers and GitLab owner forms. */
export type Dialect = 'github' | 'gitlab';

export type Severity = 'error' | 'warning';

export type DiagnosticCode =
  /** `!pattern` is not supported by CODEOWNERS. */
  | 'negation-unsupported'
  /** `[abc]` character classes are not supported by GitHub CODEOWNERS. */
  | 'character-class-unsupported'
  /** `\#pattern`: GitHub does not support escaping a leading `#`. */
  | 'escaped-hash-unsupported'
  /** The pattern names no path (for example `/`). */
  | 'invalid-pattern'
  /** An owner is not a `@user`, `@org/team` or e-mail address. */
  | 'invalid-owner'
  /** The same owner is listed twice on one line. */
  | 'duplicate-owner'
  /** Malformed GitLab section header. */
  | 'invalid-section'
  /** An earlier rule uses the exact same pattern, so it never applies. */
  | 'duplicate-pattern'
  /** A later catch-all rule (`*`, `**`) makes this rule unreachable. */
  | 'unreachable-rule'
  /** The rule matches files, but a later rule always wins for each of them. */
  | 'shadowed-rule'
  /** The pattern matches no file in the repository. */
  | 'no-match'
  /** GitHub ignores CODEOWNERS files of 3 MB or more. */
  | 'file-too-large'
  /** Several CODEOWNERS files exist; only the first one is used. */
  | 'multiple-codeowners-files';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  readonly message: string;
  /** 1-based line number, or 0 for file-level findings. */
  readonly line: number;
  /** 1-based column, or 0 for file-level findings. */
  readonly column: number;
}

export interface Section {
  /** Section name as written. GitLab compares names case-insensitively. */
  readonly name: string;
  readonly line: number;
  /** `^[Section]`: approval is optional. */
  readonly optional: boolean;
  /** `[Section][2]`: number of required approvals, or null when not given. */
  readonly approvals: number | null;
  readonly defaultOwners: readonly string[];
}

export interface Rule {
  /** Position among the valid rules of the file (0-based). */
  readonly index: number;
  /** 1-based line number in the file. */
  readonly line: number;
  /** The pattern as written, escapes included. */
  readonly pattern: string;
  /** Effective owners (explicit owners, or the GitLab section defaults). */
  readonly owners: readonly string[];
  /** Well-formed owners written on the line itself. */
  readonly explicitOwners: readonly string[];
  /** Malformed owners written on the line; never part of `owners`. */
  readonly invalidOwners: readonly string[];
  /** GitLab section the rule belongs to, or null (always null for GitHub). */
  readonly section: Section | null;
  /** Inline comment text after `#`, if any. */
  readonly comment: string | null;
  readonly matcher: CompiledPattern;
}

export interface OwnershipMatch {
  readonly path: string;
  /** Owners of the path, deduplicated, in file order. Empty means unowned. */
  readonly owners: readonly string[];
  /**
   * Winning rules: at most one for GitHub (the last matching rule), and one
   * per section for GitLab.
   */
  readonly rules: readonly Rule[];
}

export interface Codeowners {
  readonly dialect: Dialect;
  /** Valid rules in file order. Invalid lines are skipped, like GitHub does. */
  readonly rules: readonly Rule[];
  readonly sections: readonly Section[];
  /** Syntax problems found while parsing. */
  readonly diagnostics: readonly Diagnostic[];
  /** Explains who owns `path` and which rules decided it. */
  match(path: string): OwnershipMatch;
  /** Shorthand for `match(path).owners`. */
  ownersOf(path: string): readonly string[];
}
