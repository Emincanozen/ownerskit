/**
 * Regression tests for findings of an independent pre-publication review.
 * Each block names the finding it covers.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { EXIT_USAGE, run } from '../src/cli.js';
import { analyze, compilePattern, lint, parse, PatternError } from '../src/index.js';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function cli(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const code = run(args, { cwd, out: (t) => (stdout += t), err: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

describe('review 1: malformed owners are never assigned', () => {
  // GitHub docs: "If you specify a user or team that doesn't exist or has
  // insufficient access, a code owner will not be assigned."
  it('does not return a malformed owner from ownersOf', () => {
    const co = parse('*.js bob');
    assert.deepEqual(co.ownersOf('src/a.js'), []);
    assert.equal(co.diagnostics[0]?.code, 'invalid-owner');
  });

  it('keeps the valid owners of the line and records the dropped ones', () => {
    const co = parse('*.js @ok bob');
    assert.deepEqual(co.ownersOf('src/a.js'), ['@ok']);
    assert.deepEqual(co.rules[0]?.invalidOwners, ['bob']);
  });

  it("can instead skip the whole line ('skip-line')", () => {
    const co = parse('* @global\n*.js @ok bob', { invalidOwners: 'skip-line' });
    assert.deepEqual(co.ownersOf('src/a.js'), ['@global']);
    assert.equal(co.rules.length, 1);
  });

  it('counts a file owned only by a malformed owner as unowned', () => {
    const report = analyze(parse('*.js bob'), ['a.js']);
    assert.deepEqual(report.unowned, ['a.js']);
    assert.deepEqual(report.owners, []);
  });
});

describe('review 2: runs of three or more asterisks are invalid', () => {
  // GitHub REST API example for "List CODEOWNERS errors": kind "Invalid
  // pattern", source "***/*.rb @monalisa", suggestion "Did you mean `**/*.rb`?".
  it('skips the line so the earlier rule still applies', () => {
    const co = parse('* @global\n***/*.rb @special');
    assert.deepEqual(co.ownersOf('dir/x.rb'), ['@global']);
    assert.equal(co.rules.length, 1);
    const d = co.diagnostics[0];
    assert.equal(d?.code, 'invalid-pattern');
    assert.equal(d?.line, 2);
    assert.match(d?.message ?? '', /\*\*\/\*\.rb/);
  });

  it('compilePattern rejects them anywhere in the pattern', () => {
    for (const bad of ['***/*.rb', 'a/***', 'foo***bar', '****']) {
      assert.throws(() => compilePattern(bad), PatternError, bad);
    }
  });

  it('accepts escaped asterisks next to a wildcard', () => {
    assert.doesNotThrow(() => compilePattern('\\**\\*'));
  });
});

describe('review 3: /*/** is not a catch-all', () => {
  it('does not report a root-file rule as unreachable', () => {
    const co = parse('README.md @a\n/*/** @b');
    assert.deepEqual(co.ownersOf('README.md'), ['@a']);
    assert.deepEqual(lint(co), []);
  });

  it('still reports rules before real catch-alls', () => {
    for (const all of ['*', '**', '/**', '**/*', '/**/*']) {
      const co = parse(`README.md @a\n${all} @b`);
      assert.deepEqual(co.ownersOf('README.md'), ['@b'], all);
      assert.deepEqual(
        lint(co).map((d) => d.code),
        ['unreachable-rule'],
        all,
      );
    }
  });
});

describe('review 4: matching time is bounded (no exponential backtracking)', () => {
  const timed = (fn: () => void): number => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };

  it('handles many stars against a long non-matching segment', () => {
    const p = compilePattern('*a*a*a*a*a*a*a*a*b');
    const ms = timed(() => {
      assert.equal(p.test('a'.repeat(36)), false);
      assert.equal(p.test('a'.repeat(5000)), false);
    });
    assert.ok(ms < 250, `took ${ms.toFixed(1)} ms`);
  });

  it('handles many globstars against a deep non-matching path', () => {
    const p = compilePattern('**/a/**/a/**/a/**/a/**/a/**/b');
    const deep = Array.from({ length: 400 }, () => 'a').join('/');
    const ms = timed(() => assert.equal(p.test(deep), false));
    assert.ok(ms < 250, `took ${ms.toFixed(1)} ms`);
  });

  it('still matches correctly', () => {
    const p = compilePattern('*a*a*b');
    assert.equal(p.test('xaxaxb'), true);
    assert.equal(p.test('dir/aab'), true);
    assert.equal(p.test('aaa'), false);
  });
});

describe('review 5: --json also covers errors', () => {
  const empty = mkdtempSync(join(tmpdir(), 'ownerskit-review-'));
  temps.push(empty);

  it('prints a JSON error when no CODEOWNERS file exists', () => {
    const r = cli(empty, 'who', '--json', '--root', empty, 'x');
    assert.equal(r.code, EXIT_USAGE);
    const data = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    assert.equal(data.error.code, 'no-codeowners');
    assert.match(data.error.message, /no CODEOWNERS file found/);
  });

  it('prints a JSON error for usage errors', () => {
    const r = cli(empty, 'lint', '--json', '--bogus');
    assert.equal(r.code, EXIT_USAGE);
    assert.equal((JSON.parse(r.stdout) as { error: { code: string } }).error.code, 'usage');
    const r2 = cli(empty, 'nope', '--json');
    assert.equal((JSON.parse(r2.stdout) as { error: { code: string } }).error.code, 'usage');
  });

  it('prints a JSON error when --file cannot be read', () => {
    const r = cli(empty, 'lint', '--json', '--root', empty, '--file', join(empty, 'missing'));
    assert.equal(r.code, EXIT_USAGE);
    assert.equal((JSON.parse(r.stdout) as { error: { code: string } }).error.code, 'read-error');
  });

  it('CLI --invalid-owners skip-line is honoured', () => {
    const root = mkdtempSync(join(tmpdir(), 'ownerskit-review-'));
    temps.push(root);
    writeFileSync(join(root, 'CODEOWNERS'), '* @global\n*.js bob\n');
    const keep = cli(root, 'who', '--json', '--root', root, 'a.js');
    assert.deepEqual((JSON.parse(keep.stdout) as Array<{ owners: string[] }>)[0]?.owners, []);
    const skip = cli(root, 'who', '--json', '--root', root, '--invalid-owners', 'skip-line', 'a.js');
    assert.deepEqual((JSON.parse(skip.stdout) as Array<{ owners: string[] }>)[0]?.owners, ['@global']);
    assert.equal(cli(root, 'who', '--root', root, '--invalid-owners', 'maybe', 'a.js').code, EXIT_USAGE);
  });
});

describe('review 7: package builds its entry points on pack and git installs', () => {
  it('has a prepare script that builds dist/', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
      bin: Record<string, string>;
      files: string[];
    };
    assert.match(pkg.scripts['prepare'] ?? '', /npm run build/);
    assert.equal(pkg.bin['ownerskit'], 'dist/cli.js');
    assert.ok(pkg.files.includes('dist'));
  });
});
