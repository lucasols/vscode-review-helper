import { describe, expect, test } from 'vitest'
import { findAbsolutePathEntries } from './absolute-path-detector'
import { createDefaultState } from './state-persistence'

describe('findAbsolutePathEntries', () => {
  test('returns empty array for empty state', () => {
    const state = createDefaultState()
    const result = findAbsolutePathEntries(state, '/workspace')
    expect(result).toEqual([])
  })

  test('does not flag relative paths', () => {
    const state = createDefaultState()
    state.files['src/main.ts'] = {
      relativePath: 'src/main.ts',
      totalLines: 10,
      reviewedRanges: [],
    }
    state.files['tests/foo.test.ts'] = {
      relativePath: 'tests/foo.test.ts',
      totalLines: 5,
      reviewedRanges: [],
    }
    const result = findAbsolutePathEntries(state, '/workspace')
    expect(result).toEqual([])
  })

  test('flags unix absolute path within workspace', () => {
    const state = createDefaultState()
    state.files['/workspace/src/foo.ts'] = {
      relativePath: '/workspace/src/foo.ts',
      totalLines: 10,
      reviewedRanges: [],
    }
    const result = findAbsolutePathEntries(state, '/workspace')
    expect(result).toHaveLength(1)
    expect(result[0]?.absolutePath).toBe('/workspace/src/foo.ts')
    expect(result[0]?.computedRelativePath).toBe('src/foo.ts')
    expect(result[0]?.isRelativeAlreadyTracked).toBe(false)
  })

  test('flags absolute path outside workspace with undefined computedRelativePath', () => {
    const state = createDefaultState()
    state.files['/other/project/bar.ts'] = {
      relativePath: '/other/project/bar.ts',
      totalLines: 10,
      reviewedRanges: [],
    }
    const result = findAbsolutePathEntries(state, '/workspace')
    expect(result).toHaveLength(1)
    expect(result[0]?.absolutePath).toBe('/other/project/bar.ts')
    expect(result[0]?.computedRelativePath).toBeUndefined()
    expect(result[0]?.isRelativeAlreadyTracked).toBe(false)
  })

  test('sets isRelativeAlreadyTracked when relative path exists', () => {
    const state = createDefaultState()
    state.files['src/foo.ts'] = {
      relativePath: 'src/foo.ts',
      totalLines: 10,
      reviewedRanges: [],
    }
    state.files['/workspace/src/foo.ts'] = {
      relativePath: '/workspace/src/foo.ts',
      totalLines: 10,
      reviewedRanges: [],
    }
    const result = findAbsolutePathEntries(state, '/workspace')
    expect(result).toHaveLength(1)
    expect(result[0]?.computedRelativePath).toBe('src/foo.ts')
    expect(result[0]?.isRelativeAlreadyTracked).toBe(true)
  })

  test('handles mix of relative and absolute paths', () => {
    const state = createDefaultState()
    state.files['src/main.ts'] = {
      relativePath: 'src/main.ts',
      totalLines: 10,
      reviewedRanges: [],
    }
    state.files['/workspace/src/utils.ts'] = {
      relativePath: '/workspace/src/utils.ts',
      totalLines: 20,
      reviewedRanges: [],
    }
    state.files['/other/lib.ts'] = {
      relativePath: '/other/lib.ts',
      totalLines: 5,
      reviewedRanges: [],
    }
    const result = findAbsolutePathEntries(state, '/workspace')
    expect(result).toHaveLength(2)

    const withinWorkspace = result.find((e) => e.absolutePath === '/workspace/src/utils.ts')
    expect(withinWorkspace?.computedRelativePath).toBe('src/utils.ts')

    const outsideWorkspace = result.find((e) => e.absolutePath === '/other/lib.ts')
    expect(outsideWorkspace?.computedRelativePath).toBeUndefined()
  })
})
