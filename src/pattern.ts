/**
 * CODEOWNERS pattern compilation.
 *
 * CODEOWNERS patterns follow most of the gitignore rules, with the
 * differences GitHub documents:
 *
 * - no `!` negation and no `[...]` character classes (rejected by the parser);
 * - a trailing `/*` only matches direct children (`docs/*` owns
 *   `docs/a.md` but not `docs/sub/b.md`), whereas gitignore would also
 *   match the contents of `docs/sub/`;
 * - three or more consecutive asterisks are an invalid pattern (GitHub's
 *   "List CODEOWNERS errors" REST example reports `***` + `/*.rb` as
 *   "Invalid pattern" and suggests `**` + `/*.rb`);
 * - matching is case-sensitive.
 *
 * Everything else is gitignore semantics:
 *
 * - a pattern without a slash (other than a trailing one) matches at any depth;
 * - a leading or middle slash anchors the pattern to the repository root;
 * - a trailing slash restricts the pattern to directories (and so to their contents);
 * - a pattern that matches a directory also matches everything below it;
 * - `*` matches anything except `/`, `?` matches one character except `/`;
 * - leading `**` + `/` matches in all directories, trailing `/` + `**` matches
 *   everything inside, and `/` + `**` + `/` matches zero or more directories;
 * - `**` inside a segment (as in `foo**bar`) behaves like a single `*`;
 * - a backslash escapes the next character (for example `\ ` or `\*`).
 *
 * Matching does not use regular expressions: segments are matched with a
 * greedy wildcard algorithm with a single backtracking point, so the cost is
 * bounded by O(pattern length x path length) and cannot blow up.
 */

export interface CompiledPattern {
  /** The pattern exactly as written (escapes included). */
  readonly source: string;
  /** True when the pattern is tied to the repository root. */
  readonly anchored: boolean;
  /** True when the pattern ends with `/` and therefore only matches directory contents. */
  readonly directoryOnly: boolean;
  /** False for patterns ending in `/*`, which only match direct children. */
  readonly recursive: boolean;
  readonly caseSensitive: boolean;
  /** Tests a normalized, root-relative path (see {@link normalizePath}). */
  test(path: string): boolean;
}

export interface CompileOptions {
  /** Defaults to true, as on GitHub. */
  readonly caseSensitive?: boolean;
}

export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

/** One character of a segment pattern: a literal, `*` or `?`. */
type Token = { readonly kind: 'lit'; readonly ch: string } | { readonly kind: 'star' } | { readonly kind: 'any' };

/** A path-segment matcher: `**` (zero or more segments), or a single-segment glob. */
type Segment = { readonly kind: 'globstar' } | { readonly kind: 'glob'; readonly tokens: readonly Token[] };

const GLOBSTAR: Segment = { kind: 'globstar' };
const ANY_SEGMENT: Segment = { kind: 'glob', tokens: [{ kind: 'star' }] };

/** Splits on unescaped slashes, keeping escapes in each piece. */
function splitSegments(pattern: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '\\' && i + 1 < pattern.length) {
      current += ch + (pattern[i + 1] as string);
      i++;
    } else if (ch === '/') {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}

function tokenizeSegment(segment: string, lower: boolean): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (ch === '\\' && i + 1 < segment.length) {
      const next = segment[i + 1] as string;
      tokens.push({ kind: 'lit', ch: lower ? next.toLowerCase() : next });
      i++;
    } else if (ch === '*') {
      while (segment[i + 1] === '*') i++;
      tokens.push({ kind: 'star' });
    } else if (ch === '?') {
      tokens.push({ kind: 'any' });
    } else {
      tokens.push({ kind: 'lit', ch: lower ? ch.toLowerCase() : ch });
    }
  }
  return tokens;
}

/** Greedy wildcard matching with one backtracking point: O(tokens x text). */
function matchTokens(tokens: readonly Token[], text: string): boolean {
  let t = 0;
  let s = 0;
  let starT = -1;
  let starS = 0;
  while (s < text.length) {
    const token = tokens[t];
    if (token !== undefined && (token.kind === 'any' || (token.kind === 'lit' && token.ch === text[s]))) {
      t++;
      s++;
    } else if (token !== undefined && token.kind === 'star') {
      starT = t++;
      starS = s;
    } else if (starT >= 0) {
      t = starT + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  while (tokens[t]?.kind === 'star') t++;
  return t === tokens.length;
}

/**
 * Same algorithm one level up: `**` plays the role of `*` over path segments.
 * Every `**` is a fresh backtracking point that supersedes the previous one,
 * which is correct for star-only wildcards and keeps the cost polynomial.
 */
function matchSegments(segments: readonly Segment[], parts: readonly string[]): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < parts.length) {
    const segment = segments[p];
    if (segment !== undefined && segment.kind === 'glob' && matchTokens(segment.tokens, parts[s] as string)) {
      p++;
      s++;
    } else if (segment !== undefined && segment.kind === 'globstar') {
      starP = p++;
      starS = s;
    } else if (starP >= 0) {
      p = starP + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  while (segments[p]?.kind === 'globstar') p++;
  return p === segments.length;
}

/** True when the pattern ends with an unescaped character `ch`. */
function endsWithUnescaped(pattern: string, ch: string): boolean {
  if (!pattern.endsWith(ch)) return false;
  let backslashes = 0;
  for (let i = pattern.length - 2; i >= 0 && pattern[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 0;
}

/** Length of the longest run of unescaped asterisks. */
function longestStarRun(pattern: string): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      run = 0;
      i++;
    } else if (ch === '*') {
      longest = Math.max(longest, ++run);
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * Compiles a single CODEOWNERS pattern. Syntax that CODEOWNERS does not
 * support (`!`, `[...]`) is not checked here; use {@link parse} for that.
 *
 * @throws {PatternError} when the pattern names no path (for example `/`), or
 *   contains three or more consecutive asterisks.
 */
export function compilePattern(source: string, options: CompileOptions = {}): CompiledPattern {
  const caseSensitive = options.caseSensitive !== false;
  if (longestStarRun(source) >= 3) {
    const suggestion = source.replace(/\*{3,}/g, '**');
    throw new PatternError(
      `Pattern "${source}" contains three or more consecutive asterisks; did you mean "${suggestion}"?`,
    );
  }
  let body = source;
  const leadingSlash = body.startsWith('/');
  if (leadingSlash) body = body.replace(/^\/+/, '');
  const directoryOnly = endsWithUnescaped(body, '/');
  while (endsWithUnescaped(body, '/')) body = body.slice(0, -1);
  if (body.length === 0) {
    throw new PatternError(`Pattern "${source}" does not name any path`);
  }

  // Empty segments come from repeated slashes ("a//b") and are collapsed.
  const raw = splitSegments(body).filter((s) => s.length > 0);
  const anchored = leadingSlash || raw.length > 1;
  const last = raw[raw.length - 1] as string;
  const recursive = !(last === '*' && (raw.length > 1 || leadingSlash) && !directoryOnly);

  const segments: Segment[] = anchored ? [] : [GLOBSTAR];
  const push = (segment: Segment): void => {
    // Consecutive globstars are equivalent to one.
    if (segment.kind === 'globstar' && segments[segments.length - 1]?.kind === 'globstar') return;
    segments.push(segment);
  };
  raw.forEach((text, i) => {
    if (text === '**') {
      // A trailing `/**` matches everything inside, i.e. at least one more segment.
      if (i === raw.length - 1) push(ANY_SEGMENT);
      push(GLOBSTAR);
    } else {
      push({ kind: 'glob', tokens: tokenizeSegment(text, !caseSensitive) });
    }
  });
  if (last !== '**') {
    // Directory-only patterns own what is inside the directory; other
    // recursive patterns own the path itself and, if it is a directory,
    // everything below it. Non-recursive `dir/*` stops at direct children.
    if (directoryOnly) {
      push(ANY_SEGMENT);
      push(GLOBSTAR);
    } else if (recursive) {
      push(GLOBSTAR);
    }
  }

  return {
    source,
    anchored,
    directoryOnly,
    recursive,
    caseSensitive,
    test: (path: string) => {
      if (path.length === 0) return false;
      return matchSegments(segments, (caseSensitive ? path : path.toLowerCase()).split('/'));
    },
  };
}

/**
 * Turns a user-supplied path into the form patterns are tested against:
 * root-relative, no leading `./` or `/`, no trailing `/`, no repeated slashes.
 * Backslashes are kept (they are valid file name characters on POSIX);
 * convert them yourself on Windows.
 */
export function normalizePath(path: string): string {
  let p = path.replace(/\/{2,}/g, '/');
  for (;;) {
    if (p.startsWith('./')) p = p.slice(2);
    else if (p.startsWith('/')) p = p.slice(1);
    else break;
  }
  if (p.endsWith('/')) p = p.slice(0, -1);
  return p === '.' ? '' : p;
}
