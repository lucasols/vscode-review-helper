import { describe, expect, test } from 'vitest'
import {
  hashLine,
  normalizeRanges,
  markLinesReviewed,
  removeReviewedLines,
  computeFileProgress,
  computeTotalProgress,
  getUnreviewedRanges,
  createEmptyFileState,
} from './review-state'

describe('hashLine', () => {
  test('returns consistent hash for same content', () => {
    expect(hashLine('hello world')).toBe(hashLine('hello world'))
  })

  test('returns different hash for different content', () => {
    expect(hashLine('hello')).not.toBe(hashLine('world'))
  })

  test('handles empty string', () => {
    expect(hashLine('')).toBe(hashLine(''))
  })
})

describe('normalizeRanges', () => {
  test('returns empty for empty input', () => {
    expect(normalizeRanges([])).toEqual([])
  })

  test('returns single range unchanged', () => {
    const ranges = [{ startLine: 1, endLine: 5, lineHashes: {} }]
    expect(normalizeRanges(ranges)).toEqual(ranges)
  })

  test('merges overlapping ranges', () => {
    const result = normalizeRanges([
      { startLine: 1, endLine: 5, lineHashes: { 1: 'a', 2: 'b' } },
      { startLine: 3, endLine: 8, lineHashes: { 6: 'c', 7: 'd' } },
    ])
    expect(result).toEqual([
      {
        startLine: 1,
        endLine: 8,
        lineHashes: { 1: 'a', 2: 'b', 6: 'c', 7: 'd' },
      },
    ])
  })

  test('merges adjacent ranges', () => {
    const result = normalizeRanges([
      { startLine: 1, endLine: 3, lineHashes: {} },
      { startLine: 4, endLine: 6, lineHashes: {} },
    ])
    expect(result).toEqual([{ startLine: 1, endLine: 6, lineHashes: {} }])
  })

  test('keeps non-overlapping ranges separate', () => {
    const result = normalizeRanges([
      { startLine: 1, endLine: 3, lineHashes: {} },
      { startLine: 10, endLine: 15, lineHashes: {} },
    ])
    expect(result).toHaveLength(2)
  })

  test('sorts unsorted ranges', () => {
    const result = normalizeRanges([
      { startLine: 10, endLine: 15, lineHashes: {} },
      { startLine: 1, endLine: 3, lineHashes: {} },
    ])
    expect(result[0]?.startLine).toBe(1)
    expect(result[1]?.startLine).toBe(10)
  })
})

describe('markLinesReviewed', () => {
  test('marks lines in empty state', () => {
    const state = createEmptyFileState('test.ts', 10)
    const lines = [
      'line1',
      'line2',
      'line3',
      'line4',
      'line5',
      'line6',
      'line7',
      'line8',
      'line9',
      'line10',
    ]
    const result = markLinesReviewed(state, 1, 3, lines)

    expect(result.reviewedRanges).toHaveLength(1)
    expect(result.reviewedRanges[0]?.startLine).toBe(1)
    expect(result.reviewedRanges[0]?.endLine).toBe(3)
    expect(result.reviewedRanges[0]?.lineHashes[1]).toBe(hashLine('line1'))
    expect(result.reviewedRanges[0]?.lineHashes[2]).toBe(hashLine('line2'))
    expect(result.reviewedRanges[0]?.lineHashes[3]).toBe(hashLine('line3'))
  })

  test('merges with existing ranges', () => {
    const state = createEmptyFileState('test.ts', 10)
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
    const state1 = markLinesReviewed(state, 1, 3, lines)
    const state2 = markLinesReviewed(state1, 4, 6, lines)

    expect(state2.reviewedRanges).toHaveLength(1)
    expect(state2.reviewedRanges[0]?.startLine).toBe(1)
    expect(state2.reviewedRanges[0]?.endLine).toBe(6)
  })

  test('updates totalLines from document', () => {
    const state = createEmptyFileState('test.ts', 0)
    const lines = ['a', 'b', 'c']
    const result = markLinesReviewed(state, 1, 2, lines)
    expect(result.totalLines).toBe(3)
  })
})

describe('removeReviewedLines', () => {
  test('removes lines from middle of range', () => {
    const state = createEmptyFileState('test.ts', 10)
    const updatedState = {
      ...state,
      reviewedRanges: [
        {
          startLine: 1,
          endLine: 10,
          lineHashes: Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [i + 1, `h${i + 1}`]),
          ),
        },
      ],
    }
    const result = removeReviewedLines(updatedState, 4, 6)

    expect(result.reviewedRanges).toHaveLength(2)
    expect(result.reviewedRanges[0]?.startLine).toBe(1)
    expect(result.reviewedRanges[0]?.endLine).toBe(3)
    expect(result.reviewedRanges[1]?.startLine).toBe(7)
    expect(result.reviewedRanges[1]?.endLine).toBe(10)
  })

  test('removes entire range', () => {
    const state = {
      ...createEmptyFileState('test.ts', 10),
      reviewedRanges: [{ startLine: 3, endLine: 7, lineHashes: {} }],
    }
    const result = removeReviewedLines(state, 1, 10)
    expect(result.reviewedRanges).toHaveLength(0)
  })

  test('removes from start of range', () => {
    const state = {
      ...createEmptyFileState('test.ts', 10),
      reviewedRanges: [
        {
          startLine: 1,
          endLine: 10,
          lineHashes: Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [i + 1, `h${i + 1}`]),
          ),
        },
      ],
    }
    const result = removeReviewedLines(state, 1, 5)
    expect(result.reviewedRanges).toHaveLength(1)
    expect(result.reviewedRanges[0]?.startLine).toBe(6)
    expect(result.reviewedRanges[0]?.endLine).toBe(10)
  })

  test('no-op when no overlap', () => {
    const state = {
      ...createEmptyFileState('test.ts', 10),
      reviewedRanges: [{ startLine: 1, endLine: 3, lineHashes: {} }],
    }
    const result = removeReviewedLines(state, 5, 8)
    expect(result.reviewedRanges).toHaveLength(1)
  })
})

describe('computeFileProgress', () => {
  test('returns 1 for empty file', () => {
    const state = createEmptyFileState('test.ts', 0)
    expect(computeFileProgress(state)).toBe(1)
  })

  test('returns 0 for no reviewed lines', () => {
    const state = createEmptyFileState('test.ts', 10)
    expect(computeFileProgress(state)).toBe(0)
  })

  test('returns 0.5 for half reviewed', () => {
    const state = {
      ...createEmptyFileState('test.ts', 10),
      reviewedRanges: [{ startLine: 1, endLine: 5, lineHashes: {} }],
    }
    expect(computeFileProgress(state)).toBe(0.5)
  })

  test('returns 1 for fully reviewed', () => {
    const state = {
      ...createEmptyFileState('test.ts', 10),
      reviewedRanges: [{ startLine: 1, endLine: 10, lineHashes: {} }],
    }
    expect(computeFileProgress(state)).toBe(1)
  })
})

describe('computeTotalProgress', () => {
  test('returns 0 for no files', () => {
    expect(computeTotalProgress({})).toBe(0)
  })

  test('computes weighted progress across files', () => {
    const files = {
      'a.ts': {
        ...createEmptyFileState('a.ts', 10),
        reviewedRanges: [{ startLine: 1, endLine: 10, lineHashes: {} }],
      },
      'b.ts': createEmptyFileState('b.ts', 10),
    }
    expect(computeTotalProgress(files)).toBe(0.5)
  })
})

describe('getUnreviewedRanges', () => {
  test('returns all lines for unreviewed file', () => {
    const state = createEmptyFileState('test.ts', 10)
    const result = getUnreviewedRanges(state)
    expect(result).toEqual([{ startLine: 1, endLine: 10 }])
  })

  test('returns empty for fully reviewed file', () => {
    const state = {
      ...createEmptyFileState('test.ts', 10),
      reviewedRanges: [{ startLine: 1, endLine: 10, lineHashes: {} }],
    }
    expect(getUnreviewedRanges(state)).toEqual([])
  })

  test('returns gaps between reviewed ranges', () => {
    const state = {
      ...createEmptyFileState('test.ts', 20),
      reviewedRanges: [
        { startLine: 1, endLine: 5, lineHashes: {} },
        { startLine: 11, endLine: 15, lineHashes: {} },
      ],
    }
    const result = getUnreviewedRanges(state)
    expect(result).toEqual([
      { startLine: 6, endLine: 10 },
      { startLine: 16, endLine: 20 },
    ])
  })

  test('returns empty for empty file', () => {
    const state = createEmptyFileState('test.ts', 0)
    expect(getUnreviewedRanges(state)).toEqual([])
  })
})
