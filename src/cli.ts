#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { argv, cwd as processCwd, exit } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findGitRoot, listRepoFiles, loadCodeowners, codeownersLocations, type LoadedCodeowners } from './fs.js';
import { analyze, lint } from './lint.js';
import type { Diagnostic, Dialect } from './types.js';
import { VERSION } from './version.js';

/** Exit codes: stable, meant for CI. */
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;

const HELP = `ownerskit ${VERSION} - inspect and lint CODEOWNERS files

Usage:
  ownerskit who <paths...>   Show the owners of each path
  ownerskit lint             Check the CODEOWNERS file for problems
  ownerskit unowned          List repository files that have no owner
  ownerskit stats            Count files per owner

Options:
  -f, --file <path>      CODEOWNERS file to use (default: first of
                         .github/CODEOWNERS, CODEOWNERS, docs/CODEOWNERS)
  -C, --root <dir>       Repository root (default: git top-level, else cwd)
      --dialect <name>   github (default) or gitlab
      --json             Print machine-readable JSON
      --untracked        Also consider untracked, non-ignored files
      --no-git           Walk the file system instead of using git ls-files
      --strict           lint: treat warnings as errors
      --invalid-owners <policy>
                         ignore-owner (default): drop malformed owners, keep
                         the line; skip-line: ignore lines naming one
  -h, --help             Show this help
  -v, --version          Show the version

Exit codes:
  0  success, nothing to report
  1  findings: lint errors (or warnings with --strict), unowned files,
     or a 'who' path without owner
  2  usage error, unreadable file, or no CODEOWNERS file found
     (with --json, printed on stdout as {"error": {"code", "message"}})
`;

export interface Io {
  readonly cwd: string;
  out(text: string): void;
  err(text: string): void;
}

/** Error codes printed with --json: {"error": {"code", "message"}}. */
export type ErrorCode = 'usage' | 'no-codeowners' | 'read-error' | 'root-not-found';

class UsageError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = 'usage',
  ) {
    super(message);
  }
}

function fail(io: Io, json: boolean, code: ErrorCode, message: string, help = false): number {
  if (json) io.out(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
  else io.err(`ownerskit: ${message}\n${help ? `\n${HELP}` : ''}`);
  return EXIT_USAGE;
}

interface Context {
  readonly root: string;
  readonly dialect: Dialect;
  readonly json: boolean;
  readonly loaded: LoadedCodeowners;
  readonly displayPath: string;
  readonly values: Options;
}

interface Options {
  file?: string | undefined;
  root?: string | undefined;
  dialect?: string | undefined;
  json?: boolean | undefined;
  untracked?: boolean | undefined;
  'no-git'?: boolean | undefined;
  strict?: boolean | undefined;
  'invalid-owners'?: string | undefined;
  help?: boolean | undefined;
  version?: boolean | undefined;
}

const toSlash = (p: string): string => p.split(sep).join('/');

function files(ctx: Context, io: Io): string[] {
  const listed = listRepoFiles(ctx.root, {
    untracked: ctx.values.untracked === true,
    noGit: ctx.values['no-git'] === true,
  });
  if (listed.source === 'walk' && ctx.values['no-git'] !== true && !ctx.json) {
    io.err('note: not a git work tree (or git unavailable); walking the file system instead\n');
  }
  return listed.files;
}

function formatDiagnostic(file: string, d: Diagnostic): string {
  const where = d.line > 0 ? `${file}:${d.line}:${d.column}` : file;
  return `${where}  ${d.severity.padEnd(7)}  ${d.code}  ${d.message}`;
}

function cmdWho(ctx: Context, paths: string[], io: Io): number {
  if (paths.length === 0) throw new UsageError('who: expected at least one path');
  const results = paths.map((input) => {
    const absolute = resolve(io.cwd, input);
    const rel = toSlash(relative(ctx.root, absolute));
    if (rel.startsWith('../') || rel === '..' || isAbsolute(rel)) {
      throw new UsageError(`who: "${input}" is outside the repository root ${ctx.root}`);
    }
    return ctx.loaded.codeowners.match(rel);
  });
  if (ctx.json) {
    const data = results.map((m) => ({
      path: m.path,
      owners: m.owners,
      rules: m.rules.map((r) => ({ line: r.line, pattern: r.pattern, section: r.section?.name ?? null })),
    }));
    io.out(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    const width = Math.min(60, Math.max(...results.map((m) => m.path.length)));
    for (const m of results) {
      const owners = m.owners.length > 0 ? m.owners.join(' ') : '(unowned)';
      const rule = m.rules.length > 0 ? `  [${m.rules.map((r) => `line ${r.line}: ${r.pattern}`).join(', ')}]` : '';
      io.out(`${m.path.padEnd(width)}  ${owners}${rule}\n`);
    }
  }
  return results.some((m) => m.owners.length === 0) ? EXIT_FINDINGS : EXIT_OK;
}

function cmdLint(ctx: Context, io: Io): number {
  const list = files(ctx, io);
  const diagnostics: Diagnostic[] = lint(ctx.loaded.codeowners, { files: list, sizeBytes: ctx.loaded.sizeBytes });
  for (const other of ctx.loaded.ignored) {
    diagnostics.unshift({
      code: 'multiple-codeowners-files',
      severity: 'warning',
      message: `${other} also exists but is ignored: only the first CODEOWNERS file found is used (${codeownersLocations(ctx.dialect).join(', ')})`,
      line: 0,
      column: 0,
    });
  }
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  if (ctx.json) {
    io.out(
      `${JSON.stringify({ file: ctx.displayPath, filesChecked: list.length, errors, warnings, diagnostics }, null, 2)}\n`,
    );
  } else {
    for (const d of diagnostics) io.out(`${formatDiagnostic(ctx.displayPath, d)}\n`);
    io.out(
      diagnostics.length === 0
        ? `${ctx.displayPath}: no problems (${ctx.loaded.codeowners.rules.length} rules, ${list.length} files)\n`
        : `\n${errors} error(s), ${warnings} warning(s)\n`,
    );
  }
  if (errors > 0) return EXIT_FINDINGS;
  if (warnings > 0 && ctx.values.strict === true) return EXIT_FINDINGS;
  return EXIT_OK;
}

function cmdUnowned(ctx: Context, io: Io): number {
  const list = files(ctx, io);
  const report = analyze(ctx.loaded.codeowners, list);
  if (ctx.json) {
    io.out(`${JSON.stringify({ total: list.length, unowned: report.unowned.length, files: report.unowned }, null, 2)}\n`);
  } else {
    for (const f of report.unowned) io.out(`${f}\n`);
    io.err(`${report.unowned.length} of ${list.length} file(s) have no owner\n`);
  }
  return report.unowned.length > 0 ? EXIT_FINDINGS : EXIT_OK;
}

function cmdStats(ctx: Context, io: Io): number {
  const list = files(ctx, io);
  const report = analyze(ctx.loaded.codeowners, list);
  const owned = list.length - report.unowned.length;
  if (ctx.json) {
    io.out(
      `${JSON.stringify(
        { total: list.length, owned, unowned: report.unowned.length, owners: report.owners },
        null,
        2,
      )}\n`,
    );
  } else {
    const pct = (n: number): string => (list.length === 0 ? '0.0' : ((100 * n) / list.length).toFixed(1));
    const width = Math.max(5, ...report.owners.map((o) => o.owner.length));
    io.out(`${'OWNER'.padEnd(width)}  FILES      %\n`);
    for (const o of report.owners) {
      io.out(`${o.owner.padEnd(width)}  ${String(o.files).padStart(5)}  ${pct(o.files).padStart(5)}\n`);
    }
    io.out(`\n${list.length} files, ${owned} owned (${pct(owned)}%), ${report.unowned.length} unowned\n`);
  }
  return EXIT_OK;
}

/** Runs the CLI. Returns the exit code instead of exiting, for testability. */
export function run(args: readonly string[], io: Io): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        file: { type: 'string', short: 'f' },
        root: { type: 'string', short: 'C' },
        dialect: { type: 'string' },
        json: { type: 'boolean' },
        untracked: { type: 'boolean' },
        'no-git': { type: 'boolean' },
        strict: { type: 'boolean' },
        'invalid-owners': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    return fail(io, args.includes('--json'), 'usage', (error as Error).message, true);
  }
  const values: Options = parsed.values;
  const [command, ...rest] = parsed.positionals;

  if (values.version) {
    io.out(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (values.help || command === undefined || command === 'help') {
    (command === undefined && !values.help ? io.err : io.out)(HELP);
    return command === undefined && !values.help ? EXIT_USAGE : EXIT_OK;
  }

  try {
    if (!['who', 'lint', 'unowned', 'stats'].includes(command)) {
      throw new UsageError(`unknown command "${command}"`);
    }
    if (command !== 'who' && rest.length > 0) {
      throw new UsageError(`${command}: unexpected argument "${rest[0]}"`);
    }
    const dialect = values.dialect ?? 'github';
    if (dialect !== 'github' && dialect !== 'gitlab') {
      throw new UsageError(`--dialect must be "github" or "gitlab", got "${dialect}"`);
    }
    const invalidOwners = values['invalid-owners'] ?? 'ignore-owner';
    if (invalidOwners !== 'ignore-owner' && invalidOwners !== 'skip-line') {
      throw new UsageError(`--invalid-owners must be "ignore-owner" or "skip-line", got "${invalidOwners}"`);
    }
    const base = values.root !== undefined ? resolve(io.cwd, values.root) : (findGitRoot(io.cwd) ?? io.cwd);
    let root = base;
    try {
      root = realpathSync(base);
    } catch {
      throw new UsageError(`root directory not found: ${base}`, 'root-not-found');
    }
    const file = values.file !== undefined ? resolve(io.cwd, values.file) : undefined;
    let loaded: LoadedCodeowners | null;
    try {
      loaded = loadCodeowners(root, file === undefined ? { dialect, invalidOwners } : { dialect, invalidOwners, file });
    } catch (error) {
      throw new UsageError(`cannot read ${file ?? 'CODEOWNERS'}: ${(error as Error).message}`, 'read-error');
    }
    if (loaded === null) {
      throw new UsageError(
        `no CODEOWNERS file found in ${root} (looked at ${codeownersLocations(dialect).join(', ')})`,
        'no-codeowners',
      );
    }
    const rel = toSlash(relative(root, loaded.path));
    const displayPath = rel.startsWith('..') || isAbsolute(rel) ? toSlash(loaded.path) : rel;
    const ctx: Context = { root, dialect, json: values.json === true, loaded, displayPath, values };

    switch (command) {
      case 'who':
        return cmdWho(ctx, rest, io);
      case 'lint':
        return cmdLint(ctx, io);
      case 'unowned':
        return cmdUnowned(ctx, io);
      default:
        return cmdStats(ctx, io);
    }
  } catch (error) {
    if (error instanceof UsageError) return fail(io, values.json === true, error.code, error.message);
    throw error;
  }
}

function isMain(): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    // exitCode (not exit()) so piped stdout is flushed before the process ends.
    process.exitCode = run(argv.slice(2), {
      cwd: processCwd(),
      out: (t) => process.stdout.write(t),
      err: (t) => process.stderr.write(t),
    });
  } catch (error) {
    process.stderr.write(`ownerskit: internal error: ${(error as Error).stack ?? String(error)}\n`);
    exit(EXIT_USAGE);
  }
}
