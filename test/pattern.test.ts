import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compilePattern, normalizePath, PatternError } from '../src/index.js';

interface Case {
  readonly pattern: string;
  readonly matches: readonly string[];
  readonly rejects: readonly string[];
  readonly note?: string;
}

/**
 * Pattern semantics. Cases marked "GitHub docs" come from the examples in
 * GitHub's "About code owners" documentation; the others follow gitignore
 * rules, which CODEOWNERS inherits.
 */
const CASES: readonly Case[] = [
  {
    pattern: '*',
    note: 'GitHub docs: global owners, matches every file at any depth',
    matches: ['README.md', 'src/index.ts', 'a/b/c/d.txt', '.github/workflows/ci.yml', '.env'],
    rejects: [],
  },
  {
    pattern: '**',
    matches: ['README.md', 'a/b/c/d.txt', '.hidden/x'],
    rejects: [],
  },
  {
    pattern: '*.js',
    note: 'GitHub docs: no slash, so it matches at any depth',
    matches: ['a.js', 'src/a.js', 'src/deep/nested/a.js', '.eslintrc.js', 'lib.js/inner.txt'],
    rejects: ['a.jsx', 'a.ts', 'a.js.map', 'js', 'srcjs'],
  },
  {
    pattern: '*.go',
    matches: ['main.go', 'cmd/tool/main.go'],
    rejects: ['main.golang', 'go'],
  },
  {
    pattern: '/build/logs/',
    note: 'GitHub docs: build/logs at the root and all its subdirectories',
    matches: ['build/logs/a.log', 'build/logs/2024/01/a.log'],
    rejects: ['build/logs', 'src/build/logs/a.log', 'build/logsx/a.log', 'build/a.log'],
  },
  {
    pattern: 'docs/*',
    note: 'GitHub docs: direct children only, not nested files (differs from gitignore)',
    matches: ['docs/getting-started.md', 'docs/build-app', 'docs/.nojekyll'],
    rejects: ['docs/build-app/troubleshooting.md', 'docs', 'src/docs/a.md', 'documents/a.md'],
  },
  {
    pattern: 'apps/',
    note: 'GitHub docs: any apps directory anywhere in the repository',
    matches: ['apps/web/index.ts', 'packages/apps/x.ts', 'a/b/apps/c/d.ts'],
    rejects: ['apps', 'myapps/x.ts', 'apps.ts', 'src/apps'],
  },
  {
    pattern: '/docs/',
    note: 'GitHub docs: docs at the root and any of its subdirectories',
    matches: ['docs/a.md', 'docs/guides/b.md'],
    rejects: ['packages/docs/a.md', 'docs', 'docsite/a.md'],
  },
  {
    pattern: '/scripts/',
    matches: ['scripts/deploy.sh', 'scripts/ci/build.sh'],
    rejects: ['tools/scripts/x.sh'],
  },
  {
    pattern: '**/logs',
    note: 'GitHub docs: any logs directory such as build/logs, scripts/logs, deeply/nested/logs',
    matches: ['logs', 'logs/a.log', 'build/logs/a.log', 'scripts/logs/b.log', 'deeply/nested/logs/c.log'],
    rejects: ['catalogs/a', 'logsx/a.log', 'build/logs.txt'],
  },
  {
    pattern: '/apps/',
    matches: ['apps/github/index.ts', 'apps/web/x.ts'],
    rejects: ['src/apps/x.ts'],
  },
  {
    pattern: 'logs/**',
    note: 'gitignore: trailing /** matches everything inside, anchored to the root',
    matches: ['logs/a.log', 'logs/a/b/c.log'],
    rejects: ['logs', 'build/logs/a.log'],
  },
  {
    pattern: 'a/**/b',
    note: 'gitignore: /**/ matches zero or more directories',
    matches: ['a/b', 'a/x/b', 'a/x/y/b', 'a/x/b/file.txt'],
    rejects: ['a/xb', 'ab', 'x/a/b', 'a/bc'],
  },
  {
    pattern: '**/*.ts',
    matches: ['a.ts', 'src/a.ts', 'src/deep/a.ts'],
    rejects: ['a.tsx', 'a.ts.bak'],
  },
  {
    pattern: '?.md',
    note: '? matches exactly one character other than /',
    matches: ['a.md', 'docs/b.md'],
    rejects: ['ab.md', '.md', 'a/.md'],
  },
  {
    pattern: 'README.md',
    note: 'case-sensitive, any depth',
    matches: ['README.md', 'docs/README.md'],
    rejects: ['readme.md', 'README.md.bak', 'XREADME.md'],
  },
  {
    pattern: 'src/app',
    note: 'middle slash anchors; matches the file, or the directory and its contents',
    matches: ['src/app', 'src/app/main.ts', 'src/app/a/b.ts'],
    rejects: ['lib/src/app', 'src/apple', 'src/app.ts'],
  },
  {
    pattern: '/script.sh',
    matches: ['script.sh'],
    rejects: ['tools/script.sh'],
  },
  {
    pattern: 'docs/*.md',
    matches: ['docs/a.md'],
    rejects: ['docs/a.txt', 'x/docs/a.md', 'docs/sub/a.md'],
  },
  {
    pattern: 'docs/*/',
    note: 'contents of the direct subdirectories of docs',
    matches: ['docs/guides/a.md', 'docs/guides/x/y.md'],
    rejects: ['docs/a.md', 'docs'],
  },
  {
    pattern: '/*',
    note: 'by analogy with docs/*: root-level files only',
    matches: ['README.md', 'package.json', 'src'],
    rejects: ['src/index.ts'],
  },
  {
    pattern: '/**',
    matches: ['README.md', 'src/index.ts'],
    rejects: [],
  },
  {
    pattern: 'foo**bar',
    note: 'gitignore: ** inside a segment acts like * (GitHub does not document this case)',
    matches: ['foobar', 'foo-x-bar', 'dir/fooXbar'],
    rejects: ['foo/bar'],
  },
  {
    pattern: 'my\\ file.txt',
    note: 'backslash escapes a space',
    matches: ['my file.txt', 'docs/my file.txt'],
    rejects: ['my\\ file.txt', 'myfile.txt'],
  },
  {
    pattern: '\\*.js',
    note: 'escaped * is literal',
    matches: ['*.js', 'src/*.js'],
    rejects: ['a.js'],
  },
  {
    pattern: 'a+b(c){1}.$x^|',
    note: 'regular-expression metacharacters are literal',
    matches: ['a+b(c){1}.$x^|'],
    rejects: ['aab(c){1}.$x^|', 'a+bc1.$x^|'],
  },
  {
    pattern: 'a//b',
    note: 'repeated slashes collapse',
    matches: ['a/b', 'a/b/c'],
    rejects: ['x/a/b'],
  },
  {
    pattern: '.github/',
    matches: ['.github/CODEOWNERS', '.github/workflows/ci.yml'],
    rejects: ['github/x', 'x.github/y'],
  },
  {
    pattern: '#',
    note: 'not reachable through parse() (comment), but compilePattern treats it literally',
    matches: ['#', 'a/#'],
    rejects: ['a'],
  },
];

describe('compilePattern: documented and gitignore semantics', () => {
  for (const c of CASES) {
    describe(`"${c.pattern}"${c.note ? ` (${c.note})` : ''}`, () => {
      const compiled = compilePattern(c.pattern);
      for (const path of c.matches) {
        it(`matches ${path}`, () => assert.equal(compiled.test(path), true, c.pattern));
      }
      for (const path of c.rejects) {
        it(`does not match ${path}`, () => assert.equal(compiled.test(path), false, c.pattern));
      }
    });
  }
});

describe('compilePattern: flags', () => {
  it('reports anchoring', () => {
    assert.equal(compilePattern('*.js').anchored, false);
    assert.equal(compilePattern('apps/').anchored, false);
    assert.equal(compilePattern('/apps/').anchored, true);
    assert.equal(compilePattern('docs/*').anchored, true);
    assert.equal(compilePattern('**/logs').anchored, true);
  });

  it('reports directory-only and recursion', () => {
    assert.equal(compilePattern('apps/').directoryOnly, true);
    assert.equal(compilePattern('apps').directoryOnly, false);
    assert.equal(compilePattern('docs/*').recursive, false);
    assert.equal(compilePattern('docs/*/').recursive, true);
    assert.equal(compilePattern('*').recursive, true);
    assert.equal(compilePattern('docs/**').recursive, true);
  });

  it('keeps the source text', () => {
    assert.equal(compilePattern('my\\ file').source, 'my\\ file');
  });

  it('supports case-insensitive matching on request', () => {
    const p = compilePattern('README.md', { caseSensitive: false });
    assert.equal(p.test('docs/readme.MD'), true);
  });

  it('throws PatternError for patterns that name no path', () => {
    for (const bad of ['/', '//', '///']) {
      assert.throws(() => compilePattern(bad), PatternError, bad);
    }
  });

  it('treats an escaped trailing slash as part of the name', () => {
    const p = compilePattern('odd\\/');
    assert.equal(p.directoryOnly, false);
  });
});

describe('normalizePath', () => {
  const cases: Array<[string, string]> = [
    ['src/a.ts', 'src/a.ts'],
    ['./src/a.ts', 'src/a.ts'],
    ['/src/a.ts', 'src/a.ts'],
    ['././src//a.ts', 'src/a.ts'],
    ['docs/', 'docs'],
    ['.', ''],
    ['./', ''],
    ['.github/CODEOWNERS', '.github/CODEOWNERS'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => assert.equal(normalizePath(input), expected));
  }
});
