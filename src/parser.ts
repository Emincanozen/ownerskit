import { classifyOwner } from './owners.js';
import { compilePattern, normalizePath, PatternError } from './pattern.js';
import type {
  Codeowners,
  Diagnostic,
  DiagnosticCode,
  Dialect,
  OwnershipMatch,
  Rule,
  Section,
  Severity,
} from './types.js';

export interface ParseOptions {
  /** Defaults to `github`. */
  readonly dialect?: Dialect;
  /** Defaults to true (GitHub matches paths case-sensitively). */
  readonly caseSensitive?: boolean;
  /**
   * What to do with a line that names a malformed owner (such as `bob`).
   * Malformed owners are never returned as owners. GitHub documents that an
   * owner that doesn't exist "will not be assigned", and that lines with
   * invalid syntax are skipped, but not which of the two applies to a
   * malformed owner, so both behaviours are available:
   *
   * - `ignore-owner` (default): drop the owner, keep the rest of the line;
   * - `skip-line`: ignore the whole line, so an earlier rule applies.
   */
  readonly invalidOwners?: InvalidOwnerPolicy;
}

export type InvalidOwnerPolicy = 'ignore-owner' | 'skip-line';

interface Token {
  /** Text as written, backslashes included. */
  readonly raw: string;
  /** Text with escapes resolved. */
  readonly value: string;
  /** 1-based column. */
  readonly column: number;
}

interface TokenizedLine {
  readonly tokens: Token[];
  readonly comment: string | null;
}

const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t';

/**
 * Splits a line on unescaped whitespace. A token that starts with `#` starts
 * a comment that runs to the end of the line.
 */
function tokenize(line: string, from = 0): TokenizedLine {
  const tokens: Token[] = [];
  let comment: string | null = null;
  let i = from;
  while (i < line.length) {
    while (isSpace(line[i])) i++;
    if (i >= line.length) break;
    if (line[i] === '#') {
      comment = line.slice(i + 1).trim();
      break;
    }
    const start = i;
    let raw = '';
    let value = '';
    while (i < line.length && !isSpace(line[i])) {
      const ch = line[i] as string;
      if (ch === '\\' && i + 1 < line.length) {
        const next = line[i + 1] as string;
        raw += ch + next;
        value += next;
        i += 2;
      } else {
        raw += ch;
        value += ch;
        i++;
      }
    }
    tokens.push({ raw, value, column: start + 1 });
  }
  return { tokens, comment };
}

/** True when `raw` contains an unescaped `[` or `]`. */
function hasCharacterClass(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') i++;
    else if (ch === '[' || ch === ']') return true;
  }
  return false;
}

const SECTION_HEADER = /^(\^)?\[([^\]]*)\](?:\[([^\]]*)\])?/;

class CodeownersFile implements Codeowners {
  readonly dialect: Dialect;
  readonly rules: readonly Rule[];
  readonly sections: readonly Section[];
  readonly diagnostics: readonly Diagnostic[];
  /** Rules grouped by section key, each group in file order. */
  readonly #groups: ReadonlyArray<readonly Rule[]>;

  constructor(dialect: Dialect, rules: Rule[], sections: Section[], diagnostics: Diagnostic[]) {
    this.dialect = dialect;
    this.rules = rules;
    this.sections = sections;
    this.diagnostics = diagnostics;
    const groups = new Map<string, Rule[]>();
    for (const rule of rules) {
      const key = sectionKey(rule.section);
      let group = groups.get(key);
      if (!group) groups.set(key, (group = []));
      group.push(rule);
    }
    this.#groups = [...groups.values()];
  }

  match(path: string): OwnershipMatch {
    const normalized = normalizePath(path);
    const winners: Rule[] = [];
    for (const group of this.#groups) {
      for (let i = group.length - 1; i >= 0; i--) {
        const rule = group[i] as Rule;
        if (rule.matcher.test(normalized)) {
          winners.push(rule);
          break;
        }
      }
    }
    winners.sort((a, b) => a.index - b.index);
    const owners: string[] = [];
    for (const rule of winners) {
      for (const owner of rule.owners) if (!owners.includes(owner)) owners.push(owner);
    }
    return { path: normalized, owners, rules: winners };
  }

  ownersOf(path: string): readonly string[] {
    return this.match(path).owners;
  }
}

/** Key used to group rules: GitLab merges sections with the same name, ignoring case. */
export function sectionKey(section: Section | null): string {
  return section === null ? '' : `[${section.name.toLowerCase()}]`;
}

/**
 * Parses CODEOWNERS content. Never throws on bad input: invalid lines are
 * reported in `diagnostics` and skipped, which is what GitHub does.
 */
export function parse(content: string, options: ParseOptions = {}): Codeowners {
  const dialect: Dialect = options.dialect ?? 'github';
  const caseSensitive = options.caseSensitive ?? true;
  const rules: Rule[] = [];
  const sections: Section[] = [];
  const diagnostics: Diagnostic[] = [];
  let currentSection: Section | null = null;

  const report = (
    severity: Severity,
    code: DiagnosticCode,
    message: string,
    line: number,
    column: number,
  ): void => {
    diagnostics.push({ code, severity, message, line, column });
  };

  const invalidOwnerPolicy: InvalidOwnerPolicy = options.invalidOwners ?? 'ignore-owner';
  const checkOwners = (owners: Token[], lineNo: number): { valid: string[]; invalid: string[] } => {
    const seen = new Set<string>();
    const valid: string[] = [];
    const invalid: string[] = [];
    const consequence =
      invalidOwnerPolicy === 'skip-line' ? 'line ignored' : 'owner ignored, the rest of the line applies';
    for (const token of owners) {
      const owner = token.value;
      if (seen.has(owner)) {
        report('warning', 'duplicate-owner', `Owner "${owner}" is listed more than once`, lineNo, token.column);
        continue;
      }
      seen.add(owner);
      if (classifyOwner(owner, dialect) === 'invalid') {
        const expected =
          dialect === 'gitlab'
            ? '@user, @group, @group/subgroup, @@role or an e-mail address'
            : '@user, @org/team or an e-mail address';
        report(
          'error',
          'invalid-owner',
          `Invalid owner "${owner}": expected ${expected} (${consequence})`,
          lineNo,
          token.column,
        );
        invalid.push(owner);
      } else {
        valid.push(owner);
      }
    }
    return { valid, invalid };
  };

  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((text, i) => {
    const lineNo = i + 1;
    const indent = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    // GitLab section headers: [Name], ^[Name], [Name][2], followed by default owners.
    if (dialect === 'gitlab' && (trimmed.startsWith('[') || trimmed.startsWith('^['))) {
      const header = SECTION_HEADER.exec(trimmed);
      const name = header?.[2]?.trim() ?? '';
      const approvalsText = header?.[3];
      if (!header || name === '' || (approvalsText !== undefined && !/^\d+$/.test(approvalsText))) {
        report('error', 'invalid-section', `Malformed section header "${trimmed}"`, lineNo, indent + 1);
        return;
      }
      const rest = tokenize(text, indent + header[0].length);
      currentSection = {
        name,
        line: lineNo,
        optional: header[1] === '^',
        approvals: approvalsText === undefined ? null : Number(approvalsText),
        // Malformed default owners are always dropped, whatever the policy.
        defaultOwners: checkOwners(rest.tokens, lineNo).valid,
      };
      sections.push(currentSection);
      return;
    }

    const { tokens, comment } = tokenize(text);
    const [patternToken, ...ownerTokens] = tokens;
    if (!patternToken) return;
    const raw = patternToken.raw;
    const col = patternToken.column;

    if (raw.startsWith('!')) {
      report('error', 'negation-unsupported', `Negation is not supported in CODEOWNERS: "${raw}" (line ignored)`, lineNo, col);
      return;
    }
    if (dialect === 'github' && raw.startsWith('\\#')) {
      report(
        'error',
        'escaped-hash-unsupported',
        `GitHub does not support escaping a leading "#": "${raw}" (line ignored)`,
        lineNo,
        col,
      );
      return;
    }
    if (hasCharacterClass(raw)) {
      const hint =
        dialect === 'github' && raw.startsWith('[') ? '; GitLab sections need --dialect gitlab' : '';
      report(
        'error',
        'character-class-unsupported',
        `Character classes ([...]) are not supported in CODEOWNERS: "${raw}" (line ignored${hint})`,
        lineNo,
        col,
      );
      return;
    }

    let matcher;
    try {
      matcher = compilePattern(raw, { caseSensitive });
    } catch (error) {
      if (!(error instanceof PatternError)) throw error;
      report('error', 'invalid-pattern', `${error.message} (line ignored)`, lineNo, col);
      return;
    }

    const checked = checkOwners(ownerTokens, lineNo);
    if (checked.invalid.length > 0 && invalidOwnerPolicy === 'skip-line') return;
    const explicitOwners = checked.valid;
    const section: Section | null = currentSection;
    // GitLab section defaults apply only when the line names no owner at all.
    const owners = ownerTokens.length > 0 || section === null ? explicitOwners : [...section.defaultOwners];
    rules.push({
      index: rules.length,
      line: lineNo,
      pattern: raw,
      owners,
      explicitOwners,
      invalidOwners: checked.invalid,
      section,
      comment,
      matcher,
    });
  });

  return new CodeownersFile(dialect, rules, sections, diagnostics);
}
