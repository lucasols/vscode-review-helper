import { describe, expect, test } from 'vitest'
import {
  parseHunkHeader,
  parseGitDiff,
  getImportLines,
  filterImportOnlyRanges,
  isTypeScriptFile,
} from './git-diff'

describe('parseHunkHeader', () => {
  test('standard format with counts', () => {
    expect(parseHunkHeader('@@ -1,3 +4,5 @@')).toEqual({
      newStart: 4,
      newCount: 5,
    })
  })

  test('omitted count means 1', () => {
    expect(parseHunkHeader('@@ -1 +3 @@')).toEqual({
      newStart: 3,
      newCount: 1,
    })
  })

  test('count of zero (pure deletion)', () => {
    expect(parseHunkHeader('@@ -1,2 +3,0 @@')).toEqual({
      newStart: 3,
      newCount: 0,
    })
  })

  test('handles trailing text after @@', () => {
    expect(parseHunkHeader('@@ -10,5 +12,3 @@ function foo() {')).toEqual({
      newStart: 12,
      newCount: 3,
    })
  })

  test('returns undefined for invalid input', () => {
    expect(parseHunkHeader('not a header')).toBeUndefined()
    expect(parseHunkHeader('')).toBeUndefined()
  })
})

describe('parseGitDiff', () => {
  test('empty diff returns empty array', () => {
    expect(parseGitDiff('')).toEqual([])
    expect(parseGitDiff('  \n  ')).toEqual([])
  })

  test('single file with single hunk', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc..def 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,5 @@',
    ].join('\n')

    expect(parseGitDiff(diff)).toEqual([
      {
        relativePath: 'src/foo.ts',
        changedRanges: [{ startLine: 1, endLine: 5 }],
        deletionAdjacentLines: [],
      },
    ])
  })

  test('single file with multiple hunks', () => {
    const diff = [
      'diff --git a/src/bar.ts b/src/bar.ts',
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
      '@@ -1,2 +1,3 @@',
      '@@ -10 +11 @@',
      '@@ -20,3 +22,5 @@',
    ].join('\n')

    expect(parseGitDiff(diff)).toEqual([
      {
        relativePath: 'src/bar.ts',
        changedRanges: [
          { startLine: 1, endLine: 3 },
          { startLine: 11, endLine: 11 },
          { startLine: 22, endLine: 26 },
        ],
        deletionAdjacentLines: [],
      },
    ])
  })

  test('multiple files', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1,2 @@',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -5,3 +5,4 @@',
    ].join('\n')

    expect(parseGitDiff(diff)).toEqual([
      {
        relativePath: 'a.ts',
        changedRanges: [{ startLine: 1, endLine: 2 }],
        deletionAdjacentLines: [],
      },
      {
        relativePath: 'b.ts',
        changedRanges: [{ startLine: 5, endLine: 8 }],
        deletionAdjacentLines: [],
      },
    ])
  })

  test('new file', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,10 @@',
    ].join('\n')

    expect(parseGitDiff(diff)).toEqual([
      {
        relativePath: 'new.ts',
        changedRanges: [{ startLine: 1, endLine: 10 }],
        deletionAdjacentLines: [],
      },
    ])
  })

  test('deleted file is skipped', () => {
    const diff = [
      'diff --git a/deleted.ts b/deleted.ts',
      'deleted file mode 100644',
      '--- a/deleted.ts',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
    ].join('\n')

    expect(parseGitDiff(diff)).toEqual([])
  })

  test('pure-deletion hunk emits adjacent lines', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -5,3 +5,0 @@',
      '@@ -10,2 +8,4 @@',
    ].join('\n')

    expect(parseGitDiff(diff)).toEqual([
      {
        relativePath: 'foo.ts',
        changedRanges: [{ startLine: 8, endLine: 11 }],
        deletionAdjacentLines: [5, 6],
      },
    ])
  })

  test('pure-deletion at file start emits only line 1', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +0,0 @@',
    ].join('\n')

    expect(parseGitDiff(diff)).toEqual([
      {
        relativePath: 'foo.ts',
        changedRanges: [],
        deletionAdjacentLines: [1],
      },
    ])
  })

  test('multiple deletion hunks dedupe adjacent lines', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -10,1 +10,0 @@',
      '@@ -15,2 +14,0 @@',
    ].join('\n')

    expect(parseGitDiff(diff)).toEqual([
      {
        relativePath: 'foo.ts',
        changedRanges: [],
        deletionAdjacentLines: [10, 11, 14, 15],
      },
    ])
  })

  test('renamed file uses new path', () => {
    const diff = [
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 90%',
      'rename from old-name.ts',
      'rename to new-name.ts',
      '--- a/old-name.ts',
      '+++ b/new-name.ts',
      '@@ -1,2 +1,3 @@',
    ].join('\n')

    expect(parseGitDiff(diff)).toEqual([
      {
        relativePath: 'new-name.ts',
        changedRanges: [{ startLine: 1, endLine: 3 }],
        deletionAdjacentLines: [],
      },
    ])
  })
})

describe('getImportLines', () => {
  test('single-line named import', () => {
    const lines = [
      "import { foo } from './bar'",
      '',
      'const x = 1',
    ]
    expect(getImportLines(lines)).toEqual(new Set([1]))
  })

  test('single-line default import', () => {
    const lines = [
      "import foo from './bar'",
      'const x = 1',
    ]
    expect(getImportLines(lines)).toEqual(new Set([1]))
  })

  test('side-effect import', () => {
    const lines = [
      "import './polyfill'",
      'const x = 1',
    ]
    expect(getImportLines(lines)).toEqual(new Set([1]))
  })

  test('type import', () => {
    const lines = [
      "import type { Foo } from './bar'",
      'const x = 1',
    ]
    expect(getImportLines(lines)).toEqual(new Set([1]))
  })

  test('multiline import', () => {
    const lines = [
      'import {',
      '  foo,',
      '  bar,',
      "} from './baz'",
      'const x = 1',
    ]
    expect(getImportLines(lines)).toEqual(new Set([1, 2, 3, 4]))
  })

  test('multiple imports with blank line between', () => {
    const lines = [
      "import { foo } from './foo'",
      '',
      "import { bar } from './bar'",
      '',
      'const x = 1',
    ]
    expect(getImportLines(lines)).toEqual(new Set([1, 2, 3]))
  })

  test('stops at non-import code', () => {
    const lines = [
      "import { foo } from './foo'",
      'const x = 1',
      "import { bar } from './bar'",
    ]
    // Should only include line 1, stops at line 2
    expect(getImportLines(lines)).toEqual(new Set([1]))
  })

  test('includes comments between imports', () => {
    const lines = [
      "import { foo } from './foo'",
      '// some comment',
      "import { bar } from './bar'",
      'const x = 1',
    ]
    expect(getImportLines(lines)).toEqual(new Set([1, 2, 3]))
  })

  test('empty file returns empty set', () => {
    expect(getImportLines([])).toEqual(new Set())
  })

  test('file with no imports returns empty set', () => {
    const lines = ['const x = 1', 'const y = 2']
    expect(getImportLines(lines)).toEqual(new Set())
  })

  test('multiline import with type keyword', () => {
    const lines = [
      'import type {',
      '  Foo,',
      '  Bar,',
      "} from './types'",
      '',
      'const x = 1',
    ]
    expect(getImportLines(lines)).toEqual(new Set([1, 2, 3, 4]))
  })
})

describe('filterImportOnlyRanges', () => {
  test('filters out range where all lines are imports', () => {
    const lines = [
      "import { foo } from './foo'",
      "import { bar } from './bar'",
      '',
      'const x = 1',
      'const y = 2',
    ]
    const ranges = [
      { startLine: 1, endLine: 2 },
      { startLine: 4, endLine: 5 },
    ]

    expect(filterImportOnlyRanges(ranges, lines)).toEqual([
      { startLine: 4, endLine: 5 },
    ])
  })

  test('keeps range with mixed import and non-import lines', () => {
    const lines = [
      "import { foo } from './foo'",
      'const x = 1',
    ]
    const ranges = [{ startLine: 1, endLine: 2 }]

    expect(filterImportOnlyRanges(ranges, lines)).toEqual([
      { startLine: 1, endLine: 2 },
    ])
  })

  test('returns all ranges when no import lines exist', () => {
    const lines = ['const x = 1', 'const y = 2']
    const ranges = [{ startLine: 1, endLine: 2 }]

    expect(filterImportOnlyRanges(ranges, lines)).toEqual(ranges)
  })

  test('returns empty when all ranges are import-only', () => {
    const lines = [
      "import { foo } from './foo'",
      "import { bar } from './bar'",
    ]
    const ranges = [{ startLine: 1, endLine: 2 }]

    expect(filterImportOnlyRanges(ranges, lines)).toEqual([])
  })
})

describe('isTypeScriptFile', () => {
  test('returns true for TypeScript files', () => {
    expect(isTypeScriptFile('src/foo.ts')).toBe(true)
    expect(isTypeScriptFile('src/foo.tsx')).toBe(true)
  })

  test('returns true for JavaScript files', () => {
    expect(isTypeScriptFile('src/foo.js')).toBe(true)
    expect(isTypeScriptFile('src/foo.jsx')).toBe(true)
  })

  test('returns false for non-JS/TS files', () => {
    expect(isTypeScriptFile('src/foo.css')).toBe(false)
    expect(isTypeScriptFile('src/foo.json')).toBe(false)
    expect(isTypeScriptFile('src/foo.md')).toBe(false)
  })
})
