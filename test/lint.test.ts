import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyze, lint, MAX_CODEOWNERS_BYTES, parse, type Diagnostic } from '../src/index.js';

const codes = (ds: readonly Diagnostic[]): Array<[number, string]> => ds.map((d) => [d.line, d.code]);

const FILES = [
  'README.md',
  'docs/index.md',
  'docs/guide/setup.md',
  'src/index.ts',
  'src/util.ts',
  'src/legacy/old.ts',
  'tools/build.sh',
];

describe('lint: static checks', () => {
  it('returns nothing for a clean file', () => {
    assert.deepEqual(lint(parse('* @a\n/docs/ @b\n')), []);
  });

  it('flags rules made unreachable by a later catch-all', () => {
    const co = parse('/docs/ @a\n*.ts @b\n* @c\n/src/ @d\n');
    assert.deepEqual(codes(lint(co)), [
      [1, 'unreachable-rule'],
      [2, 'unreachable-rule'],
    ]);
  });

  it('flags earlier duplicates of the same pattern', () => {
    const co = parse('/docs/ @a\n*.md @b\n/docs/ @c\n');
    const ds = lint(co);
    assert.deepEqual(codes(ds), [[1, 'duplicate-pattern']]);
    assert.match(ds[0]?.message ?? '', /line 3/);
  });

  it('includes parser diagnostics, sorted by position', () => {
    const co = parse('!x @a\n/docs/ @a\n* @b bad\n');
    assert.deepEqual(codes(lint(co)), [
      [1, 'negation-unsupported'],
      [2, 'unreachable-rule'],
      [3, 'invalid-owner'],
    ]);
  });

  it('flags files GitHub would ignore for size', () => {
    const ds = lint(parse('* @a'), { sizeBytes: MAX_CODEOWNERS_BYTES });
    assert.deepEqual(codes(ds), [[0, 'file-too-large']]);
    assert.deepEqual(lint(parse('* @a'), { sizeBytes: MAX_CODEOWNERS_BYTES - 1 }), []);
  });

  it('checks GitLab sections independently', () => {
    const co = parse('[A] @a\n/docs/\n[B] @b\n*\n', { dialect: 'gitlab' });
    assert.deepEqual(lint(co), []);
    const same = parse('[A] @a\n/docs/\n[a]\n* @b\n', { dialect: 'gitlab' });
    assert.deepEqual(codes(lint(same)), [[2, 'unreachable-rule']]);
  });
});

describe('lint: checks against repository files', () => {
  it('flags patterns that match no file', () => {
    const co = parse('* @a\n/missing/ @b\n*.py @c\n');
    assert.deepEqual(codes(lint(co, { files: FILES })), [
      [2, 'no-match'],
      [3, 'no-match'],
    ]);
  });

  it('hints at case mismatches', () => {
    const co = parse('/Docs/ @a\n');
    const ds = lint(co, { files: FILES });
    assert.equal(ds[0]?.code, 'no-match');
    assert.match(ds[0]?.message ?? '', /case-sensitive/);
  });

  it('flags rules whose every file is overridden later', () => {
    const co = parse('/src/legacy/ @a\n/src/ @b\n/docs/ @c\n*.md @d\n');
    const ds = lint(co, { files: FILES });
    assert.deepEqual(codes(ds), [
      [1, 'shadowed-rule'],
      [3, 'shadowed-rule'],
    ]);
    assert.match(ds[0]?.message ?? '', /"\/src\/" on line 2/);
    assert.match(ds[1]?.message ?? '', /2 file\(s\)/);
  });

  it('does not double-report statically unreachable rules', () => {
    const co = parse('/nothing/ @a\n* @b\n');
    assert.deepEqual(codes(lint(co, { files: FILES })), [[1, 'unreachable-rule']]);
  });

  it('accepts an empty file list', () => {
    assert.deepEqual(codes(lint(parse('/src/ @a'), { files: [] })), [[1, 'no-match']]);
  });
});

describe('analyze', () => {
  it('lists unowned files and counts files per owner', () => {
    const co = parse('/src/ @dev @lead\n/docs/ @docs\n/src/legacy/ @lead\n');
    const report = analyze(co, FILES);
    assert.deepEqual(report.unowned, ['README.md', 'tools/build.sh']);
    assert.deepEqual(report.owners, [
      { owner: '@lead', files: 3 },
      { owner: '@dev', files: 2 },
      { owner: '@docs', files: 2 },
    ]);
    assert.equal(report.matches.length, FILES.length);
  });

  it('treats an owner-less winning rule as unowned', () => {
    const report = analyze(parse('* @a\n/tools/\n'), FILES);
    assert.deepEqual(report.unowned, ['tools/build.sh']);
  });
});
