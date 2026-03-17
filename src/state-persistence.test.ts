import { describe, expect, test } from 'vitest'
import {
  createDefaultState,
  deserializeState,
  serializeState,
} from './state-persistence'
import { fingerprintDocumentLineHashes } from './review-state'

describe('createDefaultState', () => {
  test('creates state with version 2 and empty files', () => {
    const state = createDefaultState()
    expect(state.version).toBe(2)
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

  test('round-trips a version 2 state with snapshots', () => {
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
    }

    const json = serializeState(state)
    const result = deserializeState(json)
    expect(result).toEqual(state)
  })

  test('migrates version 1 state into version 2 snapshots', () => {
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

    const result = deserializeState(json)
    expect(result).toEqual({
      version: 2,
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
        },
      },
    })
  })

  test('returns default state for invalid JSON', () => {
    const result = deserializeState('not json')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for missing version', () => {
    const result = deserializeState('{"files":{}}')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for unsupported version', () => {
    const result = deserializeState('{"version":3,"files":{}}')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for missing files', () => {
    const result = deserializeState('{"version":2}')
    expect(result).toEqual(createDefaultState())
  })

  test('returns default state for null', () => {
    const result = deserializeState('null')
    expect(result).toEqual(createDefaultState())
  })

  test('strips file entries with invalid relativePath', () => {
    const json = JSON.stringify({
      version: 2,
      files: {
        'a.ts': { relativePath: 'WRONG', totalLines: 10, reviewedRanges: [] },
        'b.ts': { relativePath: 'b.ts', totalLines: 5, reviewedRanges: [] },
      },
    })
    const result = deserializeState(json)
    expect(Object.keys(result.files)).toEqual(['b.ts'])
  })

  test('strips invalid ranges but keeps valid ones', () => {
    const json = JSON.stringify({
      version: 2,
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
      version: 2,
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

  test('strips invalid documentLineHashes but keeps the file', () => {
    const json = JSON.stringify({
      version: 2,
      files: {
        'a.ts': {
          relativePath: 'a.ts',
          totalLines: 10,
          documentLineHashes: ['valid', 123],
          reviewedRanges: [],
        },
      },
    })
    const result = deserializeState(json)
    expect(result.files['a.ts']).toEqual({
      relativePath: 'a.ts',
      totalLines: 10,
      reviewedRanges: [],
      documentLineHashes: undefined,
      documentFingerprint: undefined,
      deletionAdjacentLines: undefined,
      snapshots: undefined,
    })
  })

  test('strips malformed snapshots but keeps valid ones', () => {
    const json = JSON.stringify({
      version: 2,
      files: {
        'a.ts': {
          relativePath: 'a.ts',
          totalLines: 2,
          reviewedRanges: [],
          snapshots: [
            {
              fingerprint: 'ignored',
              totalLines: 2,
              reviewedRanges: [{ startLine: 1, endLine: 1, lineHashes: { 1: 'ok' } }],
              documentLineHashes: ['doc-a', 'doc-b'],
            },
            {
              fingerprint: 'broken',
              totalLines: 2,
              reviewedRanges: [],
              documentLineHashes: ['ok', 123],
            },
            'not-a-snapshot',
          ],
        },
      },
    })

    const result = deserializeState(json)
    expect(result.files['a.ts']?.snapshots).toEqual([
      {
        fingerprint: fingerprintDocumentLineHashes(['doc-a', 'doc-b']),
        totalLines: 2,
        reviewedRanges: [{ startLine: 1, endLine: 1, lineHashes: { 1: 'ok' } }],
        documentLineHashes: ['doc-a', 'doc-b'],
        deletionAdjacentLines: undefined,
      },
    ])
  })

  test('returns default for files as array', () => {
    const result = deserializeState('{"version":2,"files":[]}')
    expect(result).toEqual(createDefaultState())
  })
})
