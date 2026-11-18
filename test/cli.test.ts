import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_FINDINGS, EXIT_OK, EXIT_USAGE, run } from '../src/cli.js';
import { findCodeownersFiles, listRepoFiles, loadCodeowners } from '../src/fs.js';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ownerskit-'));
  temps.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function cli(cwd: string, ...args: string[]): Result {
  let stdout = '';
  let stderr = '';
  const code = run(args, { cwd, out: (t) => (stdout += t), err: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const SAMPLE = {
  '.github/CODEOWNERS': '* @org/core\n/docs/ @docs\n/src/ @dev\n/src/legacy/ @old\n/generated/\n',
  'README.md': '# demo\n',
  'docs/index.md': 'x',
  'src/main.ts': 'x',
  'src/legacy/a.ts': 'x',
  'generated/out.js': 'x',
};

describe('cli: general', () => {
  it('prints the version', () => {
    const r = cli(tmpdir(), '--version');
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
  });

  it('prints help with --help and exits 0', () => {
    const r = cli(tmpdir(), '--help');
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /Usage:/);
  });

  it('exits 2 without a command, with an unknown command or option', () => {
    assert.equal(cli(tmpdir()).code, EXIT_USAGE);
    assert.equal(cli(tmpdir(), 'frobnicate').code, EXIT_USAGE);
    assert.equal(cli(tmpdir(), 'lint', '--bogus').code, EXIT_USAGE);
    assert.equal(cli(tmpdir(), 'lint', 'extra').code, EXIT_USAGE);
  });

  it('exits 2 when no CODEOWNERS file exists', () => {
    const root = makeRepo({ 'a.txt': 'x' });
    const r = cli(root, 'lint', '--no-git', '--root', root);
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, /no CODEOWNERS file found/);
  });

  it('rejects an unknown dialect', () => {
    const root = makeRepo(SAMPLE);
    assert.equal(cli(root, 'stats', '--root', root, '--dialect', 'svn').code, EXIT_USAGE);
  });
});

describe('cli: who', () => {
  const root = makeRepo(SAMPLE);

  it('shows owners and the deciding rule', () => {
    const r = cli(root, 'who', '--root', root, 'src/main.ts', 'src/legacy/a.ts', 'README.md');
    assert.equal(r.code, EXIT_OK);
    const lines = r.stdout.trim().split('\n');
    assert.match(lines[0] ?? '', /^src\/main\.ts\s+@dev\s+\[line 3: \/src\/\]$/);
    assert.match(lines[1] ?? '', /@old/);
    assert.match(lines[2] ?? '', /@org\/core/);
  });

  it('exits 1 when a path has no owner', () => {
    const r = cli(root, 'who', '--root', root, 'generated/out.js');
    assert.equal(r.code, EXIT_FINDINGS);
    assert.match(r.stdout, /\(unowned\)/);
  });

  it('resolves paths relative to the current directory', () => {
    const r = cli(join(root, 'src'), 'who', '--root', root, '--json', 'main.ts');
    const data = JSON.parse(r.stdout) as Array<{ path: string; owners: string[] }>;
    assert.deepEqual(data[0], { path: 'src/main.ts', owners: ['@dev'], rules: [{ line: 3, pattern: '/src/', section: null }] });
  });

  it('rejects paths outside the root', () => {
    const r = cli(root, 'who', '--root', root, '../elsewhere.txt');
    assert.equal(r.code, EXIT_USAGE);
  });

  it('requires at least one path', () => {
    assert.equal(cli(root, 'who', '--root', root).code, EXIT_USAGE);
  });

  it('honours --file', () => {
    const other = join(root, 'custom-owners');
    writeFileSync(other, '* @custom\n');
    const r = cli(root, 'who', '--root', root, '--file', other, 'src/main.ts');
    assert.match(r.stdout, /@custom/);
  });
});

describe('cli: lint, unowned, stats (file-system walk)', () => {
  it('lint exits 0 on a clean file and reports counts', () => {
    const root = makeRepo({ CODEOWNERS: '* @a\n', 'x.txt': 'x' });
    const r = cli(root, 'lint', '--root', root, '--no-git');
    assert.equal(r.code, EXIT_OK, r.stdout + r.stderr);
    assert.match(r.stdout, /no problems/);
  });

  it('lint exits 1 on errors and prints file:line:column', () => {
    const root = makeRepo({ CODEOWNERS: '* @a\n!x @b\n', 'x.txt': 'x' });
    const r = cli(root, 'lint', '--root', root, '--no-git');
    assert.equal(r.code, EXIT_FINDINGS);
    assert.match(r.stdout, /^CODEOWNERS:2:1\s+error\s+negation-unsupported/m);
  });

  it('lint warnings pass unless --strict', () => {
    const root = makeRepo({ CODEOWNERS: '* @a\n/nowhere/ @b\n', 'x.txt': 'x' });
    assert.equal(cli(root, 'lint', '--root', root, '--no-git').code, EXIT_OK);
    assert.equal(cli(root, 'lint', '--root', root, '--no-git', '--strict').code, EXIT_FINDINGS);
  });

  it('lint --json is machine-readable', () => {
    const root = makeRepo(SAMPLE);
    const r = cli(root, 'lint', '--root', root, '--no-git', '--json');
    const data = JSON.parse(r.stdout) as { file: string; errors: number; warnings: number; diagnostics: Array<{ code: string }> };
    assert.equal(data.file, '.github/CODEOWNERS');
    assert.equal(data.errors, 0);
    assert.deepEqual(data.diagnostics, []);
  });

  it('lint warns when several CODEOWNERS files exist', () => {
    const root = makeRepo({ '.github/CODEOWNERS': '* @a\n', CODEOWNERS: '* @b\n', 'docs/CODEOWNERS': '* @c\n' });
    const r = cli(root, 'lint', '--root', root, '--no-git', '--json');
    const data = JSON.parse(r.stdout) as { diagnostics: Array<{ code: string; message: string }> };
    assert.deepEqual(
      data.diagnostics.map((d) => d.code),
      ['multiple-codeowners-files', 'multiple-codeowners-files'],
    );
  });

  it('unowned lists files and exits 1', () => {
    const root = makeRepo(SAMPLE);
    const r = cli(root, 'unowned', '--root', root, '--no-git');
    assert.equal(r.code, EXIT_FINDINGS);
    assert.equal(r.stdout, 'generated/out.js\n');
    assert.match(r.stderr, /1 of 6 file\(s\)/);
  });

  it('unowned exits 0 when everything is owned', () => {
    const root = makeRepo({ CODEOWNERS: '* @a\n', 'x.txt': 'x' });
    const r = cli(root, 'unowned', '--root', root, '--no-git', '--json');
    assert.equal(r.code, EXIT_OK);
    assert.deepEqual(JSON.parse(r.stdout), { total: 2, unowned: 0, files: [] });
  });

  it('stats counts files per owner', () => {
    const root = makeRepo(SAMPLE);
    const r = cli(root, 'stats', '--root', root, '--no-git', '--json');
    assert.equal(r.code, EXIT_OK);
    assert.deepEqual(JSON.parse(r.stdout), {
      total: 6,
      owned: 5,
      unowned: 1,
      owners: [
        { owner: '@org/core', files: 2 },
        { owner: '@dev', files: 1 },
        { owner: '@docs', files: 1 },
        { owner: '@old', files: 1 },
      ],
    });
    const human = cli(root, 'stats', '--root', root, '--no-git');
    assert.match(human.stdout, /^OWNER\s+FILES\s+%$/m);
    assert.match(human.stdout, /6 files, 5 owned \(83\.3%\), 1 unowned/);
  });

  it('supports the gitlab dialect', () => {
    const root = makeRepo({ CODEOWNERS: '[Docs] @docs\n*.md\n[Code] @dev\n*.ts\n', 'a.md': 'x', 'b.ts': 'x' });
    const r = cli(root, 'who', '--root', root, '--dialect', 'gitlab', '--json', 'a.md');
    const data = JSON.parse(r.stdout) as Array<{ owners: string[]; rules: Array<{ section: string }> }>;
    assert.deepEqual(data[0]?.owners, ['@docs']);
    assert.equal(data[0]?.rules[0]?.section, 'Docs');
  });
});

describe('cli: git integration', { skip: !hasGit && 'git is not installed' }, () => {
  const setup = (): string => {
    const root = makeRepo({
      CODEOWNERS: '/src/ @dev\n',
      '.gitignore': 'ignored.txt\n',
      'src/a.ts': 'x',
      'untracked.txt': 'x',
      'ignored.txt': 'x',
    });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'CODEOWNERS', '.gitignore', 'src/a.ts'], { cwd: root });
    return root;
  };

  it('uses tracked files only by default', () => {
    const root = setup();
    const r = cli(root, 'unowned', '--json');
    assert.deepEqual(JSON.parse(r.stdout), { total: 3, unowned: 2, files: ['.gitignore', 'CODEOWNERS'] });
  });

  it('adds untracked, non-ignored files with --untracked', () => {
    const root = setup();
    const r = cli(root, 'unowned', '--json', '--untracked');
    assert.deepEqual(JSON.parse(r.stdout).files, ['.gitignore', 'CODEOWNERS', 'untracked.txt']);
  });

  it('finds the repository root from a subdirectory', () => {
    const root = setup();
    const r = cli(join(root, 'src'), 'who', 'a.ts');
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /^src\/a\.ts\s+@dev/);
  });

  it('listRepoFiles reports its source', () => {
    const root = setup();
    assert.equal(listRepoFiles(root).source, 'git');
    assert.equal(listRepoFiles(root, { noGit: true }).source, 'walk');
  });
});

describe('fs helpers', () => {
  it('finds CODEOWNERS locations in priority order', () => {
    const root = makeRepo({ 'docs/CODEOWNERS': '* @c\n', CODEOWNERS: '* @b\n', '.gitlab/CODEOWNERS': '* @g\n' });
    assert.deepEqual(findCodeownersFiles(root), ['CODEOWNERS', 'docs/CODEOWNERS']);
    assert.deepEqual(findCodeownersFiles(root, 'gitlab'), ['CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS']);
    const loaded = loadCodeowners(root);
    assert.deepEqual(loaded?.codeowners.ownersOf('x'), ['@b']);
    assert.deepEqual(loaded?.ignored, ['docs/CODEOWNERS']);
  });

  it('returns null when there is no CODEOWNERS file', () => {
    assert.equal(loadCodeowners(makeRepo({ 'a.txt': 'x' })), null);
  });

  it('walk skips .git and node_modules', () => {
    const root = makeRepo({ 'a.txt': 'x', 'node_modules/p/index.js': 'x', '.git/HEAD': 'x', 'b/c.txt': 'x' });
    assert.deepEqual(listRepoFiles(root, { noGit: true }).files, ['a.txt', 'b/c.txt']);
  });
});

describe('cli: compiled binary', () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

  it('runs as a process and propagates exit codes', () => {
    const root = makeRepo(SAMPLE);
    const ok = spawnSync(process.execPath, [bin, 'who', '--root', root, 'README.md'], { encoding: 'utf8', cwd: root });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /@org\/core/);
    const unowned = spawnSync(process.execPath, [bin, 'unowned', '--root', root, '--no-git'], { encoding: 'utf8' });
    assert.equal(unowned.status, 1);
    const usage = spawnSync(process.execPath, [bin, 'nope'], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  });
});
