import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { classifyOwner, ownersOf, parse, VERSION } from '../src/index.js';

/** The example file from GitHub's "About code owners" documentation (owners kept, comments trimmed). */
const GITHUB_EXAMPLE = `# This is a comment.
# Each line is a file pattern followed by one or more owners.

# These owners will be the default owners for everything in
# the repo. Unless a later match takes precedence,
# @global-owner1 and @global-owner2 will be requested for
# review when someone opens a pull request.
*       @global-owner1 @global-owner2

# Order is important; the last matching pattern takes the most
# precedence.
*.js    @js-owner #This is an inline comment.

# You can also use email addresses if you prefer.
*.go docs@example.com

# Teams can be specified as code owners as well.
*.txt @octo-org/octocats

/build/logs/ @doctocat

docs/*  docs@example.com

apps/ @octocat

/docs/ @doctocat

/scripts/ @doctocat @octocat

**/logs @octocat

/apps/ @octocat
/apps/github
`;

describe('parse: GitHub documentation example', () => {
  const co = parse(GITHUB_EXAMPLE);

  it('parses every rule without diagnostics', () => {
    assert.deepEqual(co.diagnostics, []);
    assert.equal(co.rules.length, 12);
  });

  const expectations: Array<[string, string[]]> = [
    ['README.md', ['@global-owner1', '@global-owner2']],
    ['src/index.js', ['@js-owner']],
    ['cmd/main.go', ['docs@example.com']],
    ['notes/a.txt', ['@octo-org/octocats']],
    ['build/logs/x.log', ['@octocat']], // **/logs comes later and wins
    ['build/logs', ['@octocat']],
    ['docs/getting-started.md', ['@doctocat']], // /docs/ comes after docs/*
    ['docs/build-app/troubleshooting.md', ['@doctocat']],
    ['scripts/deploy.sh', ['@doctocat', '@octocat']],
    ['deeply/nested/logs/a', ['@octocat']],
    ['apps/web/index.ts', ['@octocat']],
    ['apps/github/index.ts', []], // empty owners: unowned
    ['packages/apps/x.ts', ['@octocat']],
  ];
  for (const [path, owners] of expectations) {
    it(`owners of ${path}`, () => assert.deepEqual(co.ownersOf(path), owners));
  }

  it('reports the winning rule', () => {
    const m = co.match('src/index.js');
    assert.equal(m.rules.length, 1);
    assert.equal(m.rules[0]?.pattern, '*.js');
    assert.equal(m.rules[0]?.line, 12);
    assert.equal(m.rules[0]?.comment, 'This is an inline comment.');
  });

  it('reports an owner-less rule as the winner with no owners', () => {
    const m = co.match('apps/github/index.ts');
    assert.deepEqual(m.owners, []);
    assert.equal(m.rules[0]?.pattern, '/apps/github');
  });
});

describe('parse: lexical details', () => {
  it('ignores blank lines, comments and indentation', () => {
    const co = parse('\n   \n# comment\n   # indented comment\n\t*.md @a\n');
    assert.equal(co.rules.length, 1);
    assert.equal(co.rules[0]?.line, 5);
    assert.deepEqual(co.ownersOf('x.md'), ['@a']);
  });

  it('handles CRLF line endings and a UTF-8 BOM', () => {
    const co = parse('﻿* @a\r\n*.md @b\r\n');
    assert.deepEqual(co.diagnostics, []);
    assert.deepEqual(co.ownersOf('README.md'), ['@b']);
    assert.deepEqual(co.ownersOf('x.ts'), ['@a']);
  });

  it('accepts tabs and repeated spaces as separators', () => {
    const co = parse('*.md\t\t@a   @b\t');
    assert.deepEqual(co.rules[0]?.owners, ['@a', '@b']);
  });

  it('starts a comment at a token beginning with #', () => {
    const co = parse('*.md @a # owned by docs team @not-an-owner');
    assert.deepEqual(co.rules[0]?.owners, ['@a']);
    assert.equal(co.rules[0]?.comment, 'owned by docs team @not-an-owner');
  });

  it('keeps # inside a token', () => {
    const co = parse('file#1.txt @a');
    assert.equal(co.rules[0]?.pattern, 'file#1.txt');
    assert.deepEqual(co.ownersOf('file#1.txt'), ['@a']);
  });

  it('supports escaped spaces in patterns', () => {
    const co = parse('My\\ Documents/ @a');
    assert.equal(co.rules[0]?.pattern, 'My\\ Documents/');
    assert.deepEqual(co.ownersOf('My Documents/x.txt'), ['@a']);
  });

  it('treats a line with only a pattern as a rule without owners', () => {
    const co = parse('* @a\n/vendor/');
    assert.deepEqual(co.rules[1]?.owners, []);
    assert.deepEqual(co.ownersOf('vendor/lib.js'), []);
    assert.deepEqual(co.ownersOf('src/lib.js'), ['@a']);
  });

  it('returns no owners when nothing matches', () => {
    const co = parse('/src/ @a');
    const m = co.match('docs/x.md');
    assert.deepEqual(m.owners, []);
    assert.deepEqual(m.rules, []);
  });

  it('normalizes queried paths', () => {
    const co = parse('/src/ @a');
    assert.deepEqual(co.ownersOf('./src/x.ts'), ['@a']);
    assert.deepEqual(co.ownersOf('/src/x.ts'), ['@a']);
    assert.equal(co.match('./src//x.ts').path, 'src/x.ts');
  });

  it('matches case-sensitively by default and optionally ignores case', () => {
    assert.deepEqual(parse('/Docs/ @a').ownersOf('docs/x'), []);
    assert.deepEqual(parse('/Docs/ @a', { caseSensitive: false }).ownersOf('docs/x'), ['@a']);
  });

  it('records 1-based lines and columns of diagnostics', () => {
    const co = parse('* @a\n  *.md   bad-owner');
    assert.equal(co.diagnostics.length, 1);
    assert.equal(co.diagnostics[0]?.line, 2);
    assert.equal(co.diagnostics[0]?.column, 10);
  });

  it('never throws on arbitrary input', () => {
    const junk = ['\\', '\\\\', '!', '[', ']', '/', '#', '@', '* \\', '\u0000', 'a'.repeat(5000)].join('\n');
    assert.doesNotThrow(() => parse(junk));
  });
});

describe('parse: syntax GitHub does not support', () => {
  it('rejects ! negation and skips the line', () => {
    const co = parse('* @a\n!*.md @b');
    assert.equal(co.rules.length, 1);
    assert.equal(co.diagnostics[0]?.code, 'negation-unsupported');
    assert.equal(co.diagnostics[0]?.severity, 'error');
    assert.deepEqual(co.ownersOf('README.md'), ['@a']);
  });

  it('rejects [ ] character classes and skips the line', () => {
    const co = parse('*.[ch] @a\nfile]x @b');
    assert.equal(co.rules.length, 0);
    assert.deepEqual(
      co.diagnostics.map((d) => d.code),
      ['character-class-unsupported', 'character-class-unsupported'],
    );
  });

  it('accepts escaped brackets', () => {
    const co = parse('\\[id\\].tsx @a');
    assert.deepEqual(co.diagnostics, []);
    assert.deepEqual(co.ownersOf('pages/[id].tsx'), ['@a']);
  });

  it('rejects an escaped leading # (GitHub documents it as unsupported)', () => {
    const co = parse('\\#notes.md @a');
    assert.equal(co.rules.length, 0);
    assert.equal(co.diagnostics[0]?.code, 'escaped-hash-unsupported');
  });

  it('hints at --dialect gitlab for section headers', () => {
    const co = parse('[Docs] @a\n*.md');
    assert.match(co.diagnostics[0]?.message ?? '', /--dialect gitlab/);
  });

  it('rejects patterns that name no path', () => {
    const co = parse('/ @a');
    assert.equal(co.rules.length, 0);
    assert.equal(co.diagnostics[0]?.code, 'invalid-pattern');
  });
});

describe('parse: owners', () => {
  it('flags malformed owners but keeps the rule', () => {
    const co = parse('*.md @ok bad @-dash @org/ trailing-@ @a--b');
    assert.equal(co.rules.length, 1);
    assert.deepEqual(
      co.diagnostics.map((d) => d.message.match(/"([^"]+)"/)?.[1]),
      ['bad', '@-dash', '@org/', 'trailing-@', '@a--b'],
    );
    assert.ok(co.diagnostics.every((d) => d.code === 'invalid-owner'));
  });

  it('warns about duplicate owners and deduplicates them', () => {
    const co = parse('*.md @a @b @a');
    assert.deepEqual(co.rules[0]?.owners, ['@a', '@b']);
    assert.equal(co.diagnostics[0]?.code, 'duplicate-owner');
    assert.equal(co.diagnostics[0]?.severity, 'warning');
  });

  const github: Array<[string, string]> = [
    ['@octocat', 'user'],
    ['@a', 'user'],
    ['@user-name-1', 'user'],
    ['@octo-org/octocats', 'team'],
    ['@org/team_name.x', 'team'],
    ['docs@example.com', 'email'],
    ['first.last+tag@sub.example.co', 'email'],
    ['octocat', 'invalid'],
    ['@', 'invalid'],
    ['@-x', 'invalid'],
    ['@x-', 'invalid'],
    ['@a/b/c', 'invalid'],
    ['@@developer', 'invalid'],
    [`@${'a'.repeat(40)}`, 'invalid'],
    ['user@localhost', 'invalid'],
  ];
  for (const [owner, kind] of github) {
    it(`github: ${owner} is ${kind}`, () => assert.equal(classifyOwner(owner), kind));
  }

  const gitlab: Array<[string, string]> = [
    ['@user_name', 'user'],
    ['@group/sub/team', 'team'],
    ['@@developer', 'role'],
    ['@@maintainers', 'role'],
    ['@@guest', 'invalid'],
    ['dev@example.com', 'email'],
  ];
  for (const [owner, kind] of gitlab) {
    it(`gitlab: ${owner} is ${kind}`, () => assert.equal(classifyOwner(owner, 'gitlab'), kind));
  }
});

describe('ownersOf helper and package metadata', () => {
  it('parses and queries in one call', () => {
    assert.deepEqual(ownersOf('* @a\n/src/ @b', 'src/x.ts'), ['@b']);
  });

  it('exports the package.json version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
  });
});
