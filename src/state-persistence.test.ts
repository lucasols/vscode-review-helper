import { describe, expect, test } from 'vitest'
import {
  DEFAULT_BRANCH_KEY,
  createDefaultState,
  deserializeState,
  serializeState,
} from './state-persistence'
import { fingerprintDocumentLineHashes } from './review-state'

describe('createDefaultState', () => {
  test('creates state with version 3 and empty branches', () => {
    const state = createDefaultState()
    expect(state.version).toBe(3)
    expect(state.branches).toEqual({})
  })
})

describe('serializeState / deserializeState', () => {
  test('round-trips a default state', () => {
    const state = createDefaultState()
    const json = serializeState(state)
    const result = deserializeState(json)
    expect(result).toEqual(state)
  })

  test('round-trips a version 3 state with branches and snapshots', () => {
    const state = createDefaultState()
    state.branches['main'] = {
      lastAccessedAt: 1700000000000,
      files: {
        'src/main.ts': {
          relativePath: 'src/main.ts',
          totalLines: 50,
          reviewedRanges: [
            {
              startLine: 1,
              endLine: 10,
              lineHashes: { 1: 'abc', 5: 'def', 10: 'ghi' },
            },
          ],
          documentLineHashes: ['h1', 'h2'],
          documentFingerprint: fingerprintDocumentLineHashes(['h1', 'h2']),
          deletionAdjacentLines: [12],
          snapshots: [
            {
              fingerprint: fingerprintDocumentLineHashes(['h1', 'h2']),
              totalLines: 50,
              reviewedRanges: [
                {
                  startLine: 1,
                  endLine: 10,
                  lineHashes: { 1: 'abc', 5: 'def', 10: 'ghi' },
                },
              ],
              documentLineHashes: ['h1', 'h2'],
              deletionAdjacentLines: [12],
            },
          ],
        },
      },
    }
    state.branches['feature/foo'] = {
      lastAccessedAt: 1710000000000,
      files: {
        'src/other.ts': {
          relativePath: 'src/other.ts',
          totalLines: 5,
          reviewedRanges: [],
        },
      },
    }

    const json = serializeState(state)
    const result = deserializeState(json)
    expect(result).toEqual(state)
  })

  test('migrates version 1 state into a branch scope', () => {
    const json = JSON.stringify({
      version: 1,
      files: {
        'a.ts': {
          relativePath: 'a.ts',
          totalLines: 2,
          reviewedRanges: [
            {
              startLine: 1,
              endLine: 1,
              lineHashes: { 1: 'hash-a' },
            },
          ],
          documentLineHashes: ['doc-a', 'doc-b'],
          deletionAdjacentLines: [2],
        },
      },
    })

    const result = deserializeState(json, 'main')
    expect(result.version).toBe(3)
    expect(Object.keys(result.branches)).toEqual(['main'])
    const scope = result.branches['main']
    expect(scope?.lastAccessedAt).toBeTypeOf('number')
    expect(scope?.files['a.ts']).toEqual({
      relativePath: 'a.ts',
      totalLines: 2,
      reviewedRanges: [
        {
          startLine: 1,
          endLine: 1,
          lineHashes: { 1: 'hash-a' },
        },
      ],
      documentLineHashes: ['doc-a', 'doc-b'],
      documentFingerprint: fingerprintDocumentLineHashes(['doc-a', 'doc-b']),
      deletionAdjacentLines: [2],
      snapshots: [
        {
          fingerprint: fingerprintDocumentLineHashes(['doc-a', 'doc-b']),
          totalLines: 2,
          reviewedRanges: [
            {
              startLine: 1,
              endLine: 1,
              lineHashes: { 1: 'hash-a' },
            },
          ],
          documentLineHashes: ['doc-a', 'doc-b'],
          deletionAdjacentLines: [2],
        },
      ],
    })
  })

  test('migrates version 2 flat state into a branch scope', () => {
    const json = JSON.stringify({
      version: 2,
      files: {
        'a.ts': {
          relativePath: 'a.ts',
          totalLines: 1,
          reviewedRanges: [],
        },
      },
    })

    const result = deserializeState(json, 'feature/x')
    expect(result.version).toBe(3)
    expect(Object.keys(result.branches)).toEqual(['feature/x'])
    expect(Object.keys(result.branches['feature/x']?.files ?? {})).toEqual(['a.ts'])
  })

  test('migration uses default branch when no override is provided', () => {
    const json = JSON.stringify({
      version: 2,
      files: {
        'a.ts': {
          relativePath: 'a.ts',
          totalLines: 1,
          reviewedRanges: [],
        },
      },
    })

    const result = deserializeState(json)
    expect(Object.keys(result.branches)).toEqual([DEFAULT_BRANCH_KEY])
  })

  test('returns default state for invalid JSON', () => {
    const result = deserializeState('not json')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for missing version', () => {
    const result = deserializeState('{"branches":{}}')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for unsupported version', () => {
    const result = deserializeState('{"version":4,"branches":{}}')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for missing branches in v3', () => {
    const result = deserializeState('{"version":3}')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for null', () => {
    const result = deserializeState('null')
    expect(result).toEqual(createDefaultState())
  })

  test('strips file entries with invalid relativePath inside a branch', () => {
    const json = JSON.stringify({
      version: 3,
      branches: {
        main: {
          lastAccessedAt: 1700000000000,
          files: {
            'a.ts': { relativePath: 'WRONG', totalLines: 10, reviewedRanges: [] },
            'b.ts': { relativePath: 'b.ts', totalLines: 5, reviewedRanges: [] },
          },
        },
      },
    })
    const result = deserializeState(json)
    expect(Object.keys(result.branches['main']?.files ?? {})).toEqual(['b.ts'])
  })

  test('strips invalid ranges but keeps valid ones', () => {
    const json = JSON.stringify({
      version: 3,
      branches: {
        main: {
          lastAccessedAt: 0,
          files: {
            'a.ts': {
              relativePath: 'a.ts',
              totalLines: 20,
              reviewedRanges: [
                { startLine: 1, endLine: 5, lineHashes: { 1: 'abc' } },
                { startLine: -1, endLine: 3, lineHashes: {} },
                { startLine: 10, endLine: 5, lineHashes: {} },
                'not a range',
                { startLine: 8, endLine: 10, lineHashes: { 9: 'def' } },
              ],
            },
          },
        },
      },
    })
    const result = deserializeState(json)
    const ranges = result.branches['main']?.files['a.ts']?.reviewedRanges
    expect(ranges).toHaveLength(2)
    expect(ranges?.[0]?.startLine).toBe(1)
    expect(ranges?.[1]?.startLine).toBe(8)
  })

  test('falls back to current time for invalid lastAccessedAt', () => {
    const json = JSON.stringify({
      version: 3,
      branches: {
        main: {
          lastAccessedAt: 'not-a-number',
          files: {},
        },
      },
    })
    const before = Date.now()
    const result = deserializeState(json)
    const after = Date.now()
    const ts = result.branches['main']?.lastAccessedAt
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  test('strips invalid branch entries', () => {
    const json = JSON.stringify({
      version: 3,
      branches: {
        good: { lastAccessedAt: 1, files: {} },
        broken: 'not-a-scope',
      },
    })
    const result = deserializeState(json)
    expect(Object.keys(result.branches)).toEqual(['good'])
  })

  test('returns default for branches as array', () => {
    const result = deserializeState('{"version":3,"branches":[]}')
    expect(result).toEqual(createDefaultState())
  })
})
