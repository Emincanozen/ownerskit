import { compilePattern, normalizePath } from './pattern.js';
import { sectionKey } from './parser.js';
import type { Codeowners, Diagnostic, OwnershipMatch, Rule } from './types.js';

/** GitHub ignores CODEOWNERS files of this size or larger. */
export const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024;

export interface LintOptions {
  /**
   * Root-relative paths of the repository files (for example from
   * `git ls-files`). When given, enables the `no-match` and `shadowed-rule`
   * checks.
   */
  readonly files?: readonly string[];
  /** Size of the CODEOWNERS file in bytes, to enable the `file-too-large` check. */
  readonly sizeBytes?: number;
}

// Patterns that match every path. "/*/**" is deliberately absent: it does not
// match root-level files, so rules for those stay reachable.
const CATCH_ALL = new Set(['*', '**', '/**', '**/*', '/**/*']);

function byPosition(a: Diagnostic, b: Diagnostic): number {
  return a.line - b.line || a.column - b.column || a.code.localeCompare(b.code);
}

function groupBySection(rules: readonly Rule[]): Map<string, Rule[]> {
  const groups = new Map<string, Rule[]>();
  for (const rule of rules) {
    const key = sectionKey(rule.section);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(rule);
  }
  return groups;
}

/** Checks that need nothing but the file itself. */
function staticChecks(codeowners: Codeowners): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const group of groupBySection(codeowners.rules).values()) {
    // A later catch-all rule makes every earlier rule of the section unreachable.
    let catchAll: Rule | null = null;
    for (let i = group.length - 1; i >= 0 && catchAll === null; i--) {
      const rule = group[i] as Rule;
      if (CATCH_ALL.has(rule.pattern)) catchAll = rule;
    }
    const reported = new Set<Rule>();
    if (catchAll) {
      for (const rule of group) {
        if (rule.index >= catchAll.index) break;
        reported.add(rule);
        out.push({
          code: 'unreachable-rule',
          severity: 'warning',
          message: `Rule "${rule.pattern}" can never apply: the catch-all "${catchAll.pattern}" on line ${catchAll.line} comes later and the last matching rule wins`,
          line: rule.line,
          column: 1,
        });
      }
    }
    // The same pattern written twice: only the last one can ever win.
    const lastByPattern = new Map<string, Rule>();
    for (const rule of group) lastByPattern.set(rule.pattern, rule);
    for (const rule of group) {
      const last = lastByPattern.get(rule.pattern) as Rule;
      if (last === rule || reported.has(rule)) continue;
      out.push({
        code: 'duplicate-pattern',
        severity: 'warning',
        message: `Pattern "${rule.pattern}" is repeated on line ${last.line}; this earlier rule never applies`,
        line: rule.line,
        column: 1,
      });
    }
  }
  return out;
}

/** Checks that compare the rules with the actual files of the repository. */
function fileChecks(codeowners: Codeowners, files: readonly string[], skip: ReadonlySet<number>): Diagnostic[] {
  const groups = [...groupBySection(codeowners.rules).values()];
  const matched = new Uint32Array(codeowners.rules.length);
  const won = new Uint32Array(codeowners.rules.length);
  // For shadowed rules: which rule most often wins instead of them.
  const beatenBy = new Map<number, Map<number, number>>();
  const lowerFiles: string[] = [];

  for (const file of files) {
    const path = normalizePath(file);
    lowerFiles.push(path.toLowerCase());
    for (const group of groups) {
      let winner: Rule | null = null;
      for (let i = group.length - 1; i >= 0; i--) {
        const rule = group[i] as Rule;
        if (!rule.matcher.test(path)) continue;
        matched[rule.index] = (matched[rule.index] ?? 0) + 1;
        if (winner === null) {
          winner = rule;
          won[rule.index] = (won[rule.index] ?? 0) + 1;
        } else {
          let counts = beatenBy.get(rule.index);
          if (!counts) beatenBy.set(rule.index, (counts = new Map()));
          counts.set(winner.index, (counts.get(winner.index) ?? 0) + 1);
        }
      }
    }
  }

  const out: Diagnostic[] = [];
  for (const rule of codeowners.rules) {
    if (skip.has(rule.index)) continue;
    if (matched[rule.index] === 0) {
      const insensitive = compilePattern(rule.pattern, { caseSensitive: false });
      const caseHint = lowerFiles.some((f) => insensitive.test(f))
        ? ' (a file matches when ignoring case; CODEOWNERS paths are case-sensitive)'
        : '';
      out.push({
        code: 'no-match',
        severity: 'warning',
        message: `Pattern "${rule.pattern}" does not match any file${caseHint}`,
        line: rule.line,
        column: 1,
      });
    } else if (won[rule.index] === 0) {
      const counts = beatenBy.get(rule.index);
      let top = -1;
      let topCount = 0;
      for (const [index, count] of counts ?? []) {
        if (count > topCount) [top, topCount] = [index, count];
      }
      const by = codeowners.rules[top];
      const detail = by ? `, mostly by "${by.pattern}" on line ${by.line}` : '';
      out.push({
        code: 'shadowed-rule',
        severity: 'warning',
        message: `Rule "${rule.pattern}" matches ${matched[rule.index]} file(s) but later rules override all of them${detail}`,
        line: rule.line,
        column: 1,
      });
    }
  }
  return out;
}

/**
 * Lints a parsed CODEOWNERS file. Returns the parser's syntax diagnostics
 * plus semantic findings, sorted by position.
 */
export function lint(codeowners: Codeowners, options: LintOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [...codeowners.diagnostics];
  if (options.sizeBytes !== undefined && options.sizeBytes >= MAX_CODEOWNERS_BYTES) {
    out.push({
      code: 'file-too-large',
      severity: 'error',
      message: `CODEOWNERS is ${options.sizeBytes} bytes; GitHub ignores files of 3 MB or more`,
      line: 0,
      column: 0,
    });
  }
  const fromStatic = staticChecks(codeowners);
  out.push(...fromStatic);
  if (options.files) {
    const skip = new Set<number>();
    const byLine = new Map(codeowners.rules.map((r) => [r.line, r.index]));
    for (const d of fromStatic) {
      const index = byLine.get(d.line);
      if (index !== undefined) skip.add(index);
    }
    out.push(...fileChecks(codeowners, options.files, skip));
  }
  return out.sort(byPosition);
}

export interface OwnershipReport {
  readonly matches: readonly OwnershipMatch[];
  readonly unowned: readonly string[];
  /** Owner to number of files owned, sorted by count (descending), then name. */
  readonly owners: ReadonlyArray<{ readonly owner: string; readonly files: number }>;
}

/** Computes ownership for a list of files: who owns what, and what nobody owns. */
export function analyze(codeowners: Codeowners, files: readonly string[]): OwnershipReport {
  const matches = files.map((file) => codeowners.match(file));
  const unowned: string[] = [];
  const counts = new Map<string, number>();
  for (const m of matches) {
    if (m.owners.length === 0) unowned.push(m.path);
    for (const owner of m.owners) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  const owners = [...counts]
    .map(([owner, n]) => ({ owner, files: n }))
    .sort((a, b) => b.files - a.files || a.owner.localeCompare(b.owner));
  return { matches, unowned, owners };
}
