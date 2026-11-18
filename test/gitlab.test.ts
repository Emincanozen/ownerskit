import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from '../src/index.js';

const FILE = `# Rules before any section belong to the default section.
* @everyone

[Documentation] @docs-team
docs/
README.md @readme-owner

^[Optional Review][2] @group/sub/reviewers
*.md

[Backend] @backend
/api/
/api/legacy/ @@maintainer

[documentation]
/docs/internal/ @internal-docs
`;

describe('gitlab dialect: sections', () => {
  const co = parse(FILE, { dialect: 'gitlab' });

  it('parses sections without diagnostics', () => {
    assert.deepEqual(co.diagnostics, []);
    assert.deepEqual(
      co.sections.map((s) => [s.name, s.optional, s.approvals, s.defaultOwners]),
      [
        ['Documentation', false, null, ['@docs-team']],
        ['Optional Review', true, 2, ['@group/sub/reviewers']],
        ['Backend', false, null, ['@backend']],
        ['documentation', false, null, []],
      ],
    );
  });

  it('applies section default owners to rules without owners', () => {
    const docs = co.rules.find((r) => r.pattern === 'docs/');
    assert.deepEqual(docs?.owners, ['@docs-team']);
    assert.deepEqual(docs?.explicitOwners, []);
  });

  it('unions the owners of every section, last match per section', () => {
    assert.deepEqual(co.ownersOf('docs/guide.md'), ['@everyone', '@docs-team', '@group/sub/reviewers']);
    assert.deepEqual(co.ownersOf('README.md'), ['@everyone', '@readme-owner', '@group/sub/reviewers']);
    assert.deepEqual(co.ownersOf('src/main.rb'), ['@everyone']);
    assert.deepEqual(co.ownersOf('api/users.rb'), ['@everyone', '@backend']);
    assert.deepEqual(co.ownersOf('api/legacy/old.rb'), ['@everyone', '@@maintainer']);
  });

  it('merges sections whose names differ only by case', () => {
    const m = co.match('docs/internal/secret.txt');
    assert.deepEqual(m.owners, ['@everyone', '@internal-docs']);
    assert.deepEqual(
      m.rules.map((r) => [r.section?.name ?? null, r.pattern]),
      [
        [null, '*'],
        ['documentation', '/docs/internal/'],
      ],
    );
  });

  it('reports malformed section headers', () => {
    const bad = parse('[] @a\n[Name][x] @a\n[Unclosed @a\n', { dialect: 'gitlab' });
    assert.deepEqual(
      bad.diagnostics.map((d) => [d.line, d.code]),
      [
        [1, 'invalid-section'],
        [2, 'invalid-section'],
        [3, 'invalid-section'],
      ],
    );
    assert.equal(bad.sections.length, 0);
  });

  it('allows an escaped leading # as a pattern', () => {
    const g = parse('\\#notes.md @a', { dialect: 'gitlab' });
    assert.deepEqual(g.diagnostics, []);
    assert.deepEqual(g.ownersOf('#notes.md'), ['@a']);
  });

  it('still rejects ! exclusions (not implemented)', () => {
    const g = parse('[S] @a\n!docs/', { dialect: 'gitlab' });
    assert.equal(g.diagnostics[0]?.code, 'negation-unsupported');
  });

  it('accepts GitLab roles and nested groups but flags unknown roles', () => {
    const g = parse('* @@developer @a/b/c @@guest', { dialect: 'gitlab' });
    assert.deepEqual(
      g.diagnostics.map((d) => d.code),
      ['invalid-owner'],
    );
  });
});
