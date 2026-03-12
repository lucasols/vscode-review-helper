import { describe, expect, test } from 'vitest'
import {
  createDefaultState,
  serializeState,
  deserializeState,
} from './state-persistence'

describe('createDefaultState', () => {
  test('creates state with version 1 and empty files', () => {
    const state = createDefaultState()
    expect(state.version).toBe(1)
    expect(state.files).toEqual({})
  })
})

describe('serializeState / deserializeState', () => {
  test('round-trips a default state', () => {
    const state = createDefaultState()
    const json = serializeState(state)
    const result = deserializeState(json)
    expect(result).toEqual(state)
  })

  test('round-trips a state with files', () => {
    const state = createDefaultState()
    state.files['src/main.ts'] = {
      relativePath: 'src/main.ts',
      totalLines: 50,
      reviewedRanges: [
        {
          startLine: 1,
          endLine: 10,
          lineHashes: { 1: 'abc', 5: 'def', 10: 'ghi' },
        },
        {
          startLine: 20,
          endLine: 30,
          lineHashes: {},
        },
      ],
    }
    const json = serializeState(state)
    const result = deserializeState(json)
    expect(result).toEqual(state)
  })

  test('returns default state for invalid JSON', () => {
    const result = deserializeState('not json')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for missing version', () => {
    const result = deserializeState('{"files":{}}')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for wrong version', () => {
    const result = deserializeState('{"version":2,"files":{}}')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for missing files', () => {
    const result = deserializeState('{"version":1}')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for null', () => {
    const result = deserializeState('null')
    expect(result).toEqual(createDefaultState())
  })

  test('strips file entries with invalid relativePath', () => {
    const json = JSON.stringify({
      version: 1,
      files: {
        'a.ts': { relativePath: 'WRONG', totalLines: 10, reviewedRanges: [] },
        'b.ts': { relativePath: 'b.ts', totalLines: 5, reviewedRanges: [] },
      },
    })
    const result = deserializeState(json)
    expect(Object.keys(result.files)).toEqual(['b.ts'])
  })

  test('strips file entries with non-object value', () => {
    const json = JSON.stringify({
      version: 1,
      files: {
        'a.ts': 'not an object',
        'b.ts': { relativePath: 'b.ts', totalLines: 5, reviewedRanges: [] },
      },
    })
    const result = deserializeState(json)
    expect(Object.keys(result.files)).toEqual(['b.ts'])
  })

  test('strips file entries with negative totalLines', () => {
    const json = JSON.stringify({
      version: 1,
      files: {
        'a.ts': { relativePath: 'a.ts', totalLines: -1, reviewedRanges: [] },
      },
    })
    const result = deserializeState(json)
    expect(Object.keys(result.files)).toEqual([])
  })

  test('strips invalid ranges but keeps valid ones', () => {
    const json = JSON.stringify({
      version: 1,
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
    })
    const result = deserializeState(json)
    const ranges = result.files['a.ts']?.reviewedRanges
    expect(ranges).toHaveLength(2)
    expect(ranges?.[0]?.startLine).toBe(1)
    expect(ranges?.[1]?.startLine).toBe(8)
  })

  test('strips invalid lineHashes entries', () => {
    const json = JSON.stringify({
      version: 1,
      files: {
        'a.ts': {
          relativePath: 'a.ts',
          totalLines: 10,
          reviewedRanges: [
            {
              startLine: 1,
              endLine: 5,
              lineHashes: { 1: 'valid', 2: 123, abc: 'invalid-key', 3: 'ok' },
            },
          ],
        },
      },
    })
    const result = deserializeState(json)
    const hashes = result.files['a.ts']?.reviewedRanges[0]?.lineHashes
    expect(hashes).toEqual({ 1: 'valid', 3: 'ok' })
  })

  test('returns default for files as array', () => {
    const result = deserializeState('{"version":1,"files":[]}')
    expect(result).toEqual(createDefaultState())
  })
})
