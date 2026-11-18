/**
 * Node.js helpers: locate and read the CODEOWNERS file, list repository files.
 * Kept out of the main entry point so the core library has no Node imports.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse, type ParseOptions } from './parser.js';
import type { Codeowners, Dialect } from './types.js';

/** Where GitHub looks for CODEOWNERS, in priority order. The first one found is used. */
export const GITHUB_LOCATIONS: readonly string[] = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
/** Where GitLab looks for CODEOWNERS, in priority order. */
export const GITLAB_LOCATIONS: readonly string[] = ['CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'];

export function codeownersLocations(dialect: Dialect = 'github'): readonly string[] {
  return dialect === 'gitlab' ? GITLAB_LOCATIONS : GITHUB_LOCATIONS;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Returns every existing CODEOWNERS location (root-relative), in priority order. */
export function findCodeownersFiles(root: string, dialect: Dialect = 'github'): string[] {
  return codeownersLocations(dialect).filter((location) => isFile(join(root, location)));
}

export interface LoadedCodeowners {
  /** Absolute or caller-supplied path of the file that was read. */
  readonly path: string;
  readonly content: string;
  readonly sizeBytes: number;
  readonly codeowners: Codeowners;
  /** Other CODEOWNERS files that exist but are ignored because of priority. */
  readonly ignored: readonly string[];
}

export interface LoadOptions extends ParseOptions {
  /** Explicit file to read instead of searching the standard locations. */
  readonly file?: string;
}

/**
 * Reads and parses the CODEOWNERS file of a repository.
 * Returns null when no file is found at the standard locations.
 */
export function loadCodeowners(root: string, options: LoadOptions = {}): LoadedCodeowners | null {
  const dialect = options.dialect ?? 'github';
  let path: string;
  let ignored: string[] = [];
  if (options.file !== undefined) {
    path = options.file;
  } else {
    const found = findCodeownersFiles(root, dialect);
    if (found.length === 0) return null;
    path = join(root, found[0] as string);
    ignored = found.slice(1);
  }
  const buffer = readFileSync(path);
  const content = buffer.toString('utf8');
  const parseOptions: ParseOptions = {
    dialect,
    ...(options.caseSensitive === undefined ? {} : { caseSensitive: options.caseSensitive }),
    ...(options.invalidOwners === undefined ? {} : { invalidOwners: options.invalidOwners }),
  };
  return { path, content, sizeBytes: buffer.byteLength, codeowners: parse(content, parseOptions), ignored };
}

/** Top-level directory of the git work tree containing `cwd`, or null outside git. */
export function findGitRoot(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

export interface ListFilesOptions {
  /** Also list untracked files that are not ignored (`git ls-files --others --exclude-standard`). */
  readonly untracked?: boolean;
  /** Skip git and walk the file system (excluding `.git` and `node_modules`). */
  readonly noGit?: boolean;
}

export interface FileList {
  readonly files: string[];
  readonly source: 'git' | 'walk';
}

function walk(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative(root, full).split(sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

/**
 * Lists repository files as root-relative paths with forward slashes.
 * Uses `git ls-files` (tracked files, the set GitHub evaluates) and falls back
 * to a file-system walk when git is unavailable or `root` is not a work tree.
 */
export function listRepoFiles(root: string, options: ListFilesOptions = {}): FileList {
  if (!options.noGit) {
    try {
      const args = ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached'];
      if (options.untracked) args.push('--others', '--exclude-standard');
      const out = execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const files = [...new Set(out.split('\0').filter((f) => f.length > 0))].sort();
      return { files, source: 'git' };
    } catch {
      // Not a git work tree, or git is not installed: fall through.
    }
  }
  return { files: walk(root), source: 'walk' };
}
