import { describe, expect, test } from 'vitest'
import { findAbsolutePathEntries } from './absolute-path-detector'
import type { FileReviewState } from './types'

function emptyFile(relativePath: string, totalLines = 0): FileReviewState {
  return { relativePath, totalLines, reviewedRanges: [] }
}

describe('findAbsolutePathEntries', () => {
  test('returns empty array for empty files map', () => {
    const result = findAbsolutePathEntries({}, '/workspace')
    expect(result).toEqual([])
  })

  test('does not flag relative paths', () => {
    const files: Record<string, FileReviewState> = {
      'src/main.ts': emptyFile('src/main.ts', 10),
      'tests/foo.test.ts': emptyFile('tests/foo.test.ts', 5),
    }
    const result = findAbsolutePathEntries(files, '/workspace')
    expect(result).toEqual([])
  })

  test('flags unix absolute path within workspace', () => {
    const files: Record<string, FileReviewState> = {
      '/workspace/src/foo.ts': emptyFile('/workspace/src/foo.ts', 10),
    }
    const result = findAbsolutePathEntries(files, '/workspace')
    expect(result).toHaveLength(1)
    expect(result[0]?.absolutePath).toBe('/workspace/src/foo.ts')
    expect(result[0]?.computedRelativePath).toBe('src/foo.ts')
    expect(result[0]?.isRelativeAlreadyTracked).toBe(false)
  })

  test('flags absolute path outside workspace with undefined computedRelativePath', () => {
    const files: Record<string, FileReviewState> = {
      '/other/project/bar.ts': emptyFile('/other/project/bar.ts', 10),
    }
    const result = findAbsolutePathEntries(files, '/workspace')
    expect(result).toHaveLength(1)
    expect(result[0]?.absolutePath).toBe('/other/project/bar.ts')
    expect(result[0]?.computedRelativePath).toBeUndefined()
    expect(result[0]?.isRelativeAlreadyTracked).toBe(false)
  })

  test('sets isRelativeAlreadyTracked when relative path exists', () => {
    const files: Record<string, FileReviewState> = {
      'src/foo.ts': emptyFile('src/foo.ts', 10),
      '/workspace/src/foo.ts': emptyFile('/workspace/src/foo.ts', 10),
    }
    const result = findAbsolutePathEntries(files, '/workspace')
    expect(result).toHaveLength(1)
    expect(result[0]?.computedRelativePath).toBe('src/foo.ts')
    expect(result[0]?.isRelativeAlreadyTracked).toBe(true)
  })

  test('handles mix of relative and absolute paths', () => {
    const files: Record<string, FileReviewState> = {
      'src/main.ts': emptyFile('src/main.ts', 10),
      '/workspace/src/utils.ts': emptyFile('/workspace/src/utils.ts', 20),
      '/other/lib.ts': emptyFile('/other/lib.ts', 5),
    }
    const result = findAbsolutePathEntries(files, '/workspace')
    expect(result).toHaveLength(2)

    const withinWorkspace = result.find((e) => e.absolutePath === '/workspace/src/utils.ts')
    expect(withinWorkspace?.computedRelativePath).toBe('src/utils.ts')

    const outsideWorkspace = result.find((e) => e.absolutePath === '/other/lib.ts')
    expect(outsideWorkspace?.computedRelativePath).toBeUndefined()
  })
})
