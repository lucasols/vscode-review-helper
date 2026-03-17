import { describe, expect, test } from 'vitest'
import {
  realignRanges,
  fullReverify,
  detectDeletionAdjacentLines,
} from './change-tracker'
import { hashLine } from './review-state'
import type { ReviewedRange } from './types'

function makeRange(
  start: number,
  end: number,
  lines: string[],
): ReviewedRange {
  const lineHashes: Record<number, string> = {}
  for (let i = start; i <= end; i++) {
    const content = lines[i - 1]
    if (content !== undefined) {
      lineHashes[i] = hashLine(content)
    }
  }
  return { startLine: start, endLine: end, lineHashes }
}

describe('realignRanges', () => {
  test('handles lines inserted above reviewed range', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    // Two new lines inserted at the top
    const newDoc = ['X', 'Y', 'a', 'b', 'c', 'd', 'e']
    const result = realignRanges(ranges, newDoc)

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(3)
    expect(result[0]?.endLine).toBe(7)
  })

  test('handles lines inserted in the middle of reviewed range', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    // Two new lines inserted between b and c
    const newDoc = ['a', 'b', 'X', 'Y', 'c', 'd', 'e']
    const result = realignRanges(ranges, newDoc)

    // a(1), b(2) then c(5), d(6), e(7) - split into two ranges
    expect(result).toHaveLength(2)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(2)
    expect(result[1]?.startLine).toBe(5)
    expect(result[1]?.endLine).toBe(7)
  })

  test('handles lines deleted from reviewed range', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    // c was deleted - remaining a,b,d,e are contiguous at 1-4
    const newDoc = ['a', 'b', 'd', 'e']
    const result = realignRanges(ranges, newDoc)

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(4)
  })

  test('handles lines deleted above reviewed range', () => {
    const originalLines = ['X', 'Y', 'a', 'b', 'c']
    const ranges = [makeRange(3, 5, originalLines)]
    // X and Y deleted
    const newDoc = ['a', 'b', 'c']
    const result = realignRanges(ranges, newDoc)

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(3)
  })

  test('handles completely different document', () => {
    const originalLines = ['a', 'b', 'c']
    const ranges = [makeRange(1, 3, originalLines)]
    const newDoc = ['X', 'Y', 'Z']
    const result = realignRanges(ranges, newDoc)

    expect(result).toHaveLength(0)
  })

  test('handles empty ranges', () => {
    const result = realignRanges([], ['a', 'b'])
    expect(result).toHaveLength(0)
  })

  test('handles duplicate lines without misalignment', () => {
    // Greedy would match '}' at position 3, then fail to find 'a' after it
    const originalLines = ['}', 'a', '}']
    const ranges = [makeRange(1, 3, originalLines)]
    const newDoc = ['x', 'a', '}']
    const result = realignRanges(ranges, newDoc)

    // Should match 'a' at 2 and '}' at 3 (2 matches, not just 1)
    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(2)
    expect(result[0]?.endLine).toBe(3)
  })

  test('handles blank lines without consuming them prematurely', () => {
    // Greedy would consume blank line at position 2, then miss 'a'
    const originalLines = ['', 'a', '', 'b']
    const ranges = [makeRange(1, 4, originalLines)]
    const newDoc = ['a', '', 'b']
    const result = realignRanges(ranges, newDoc)

    // Should match a(1), ''(2), b(3) — 3 matches, not 2
    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(3)
  })

  test('handles regions with no unique lines via LCS fallback', () => {
    // All closing braces — no unique anchors, falls back to LCS
    const originalLines = ['}', '}', 'a', '}']
    const ranges = [makeRange(1, 4, originalLines)]
    const newDoc = ['x', '}', 'a', '}']
    const result = realignRanges(ranges, newDoc)

    // LCS matches }(2), a(3), }(4) — 3 matches
    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(2)
    expect(result[0]?.endLine).toBe(4)
  })

  test('handles common prefix and suffix trimming', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    // Same prefix (a) and suffix (e), middle changed
    const newDoc = ['a', 'X', 'c', 'Y', 'e']
    const result = realignRanges(ranges, newDoc)

    // Should match a(1), c(3), e(5)
    const reviewedLines = new Set<number>()
    for (const range of result) {
      for (let l = range.startLine; l <= range.endLine; l++) {
        reviewedLines.add(l)
      }
    }
    expect(reviewedLines.has(1)).toBe(true)
    expect(reviewedLines.has(3)).toBe(true)
    expect(reviewedLines.has(5)).toBe(true)
    expect(reviewedLines.has(2)).toBe(false)
    expect(reviewedLines.has(4)).toBe(false)
  })

  test('preserves more lines than greedy when code blocks are reordered', () => {
    // Simulates a function with braces where a line was removed above
    const originalLines = ['{', '  return 1', '}', '', 'export default foo']
    const ranges = [makeRange(1, 5, originalLines)]
    const newDoc = ['import bar', '{', '  return 1', '}', '', 'export default foo']
    const result = realignRanges(ranges, newDoc)

    // Should match all 5 original lines at their new positions
    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(2)
    expect(result[0]?.endLine).toBe(6)
  })
})

describe('fullReverify', () => {
  test('keeps lines with matching hashes', () => {
    const lines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, lines)]
    const result = fullReverify(ranges, lines)

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(5)
  })

  test('removes lines with non-matching hashes', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    const modifiedLines = ['a', 'b', 'CHANGED', 'd', 'e']
    const result = fullReverify(ranges, modifiedLines)

    const reviewedLines = new Set<number>()
    for (const range of result) {
      for (let l = range.startLine; l <= range.endLine; l++) {
        reviewedLines.add(l)
      }
    }
    expect(reviewedLines.has(1)).toBe(true)
    expect(reviewedLines.has(2)).toBe(true)
    expect(reviewedLines.has(3)).toBe(false)
    expect(reviewedLines.has(4)).toBe(true)
    expect(reviewedLines.has(5)).toBe(true)
  })

  test('handles empty ranges', () => {
    const result = fullReverify([], ['a', 'b'])
    expect(result).toEqual([])
  })

  test('handles document shorter than reviewed range', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    const shorterDoc = ['a', 'b']
    const result = fullReverify(ranges, shorterDoc)

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(2)
  })

  test('preserves reviewed lines when lines are inserted externally', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    // External edit: two lines inserted at the top
    const newDoc = ['NEW1', 'NEW2', 'a', 'b', 'c', 'd', 'e']
    const result = fullReverify(ranges, newDoc)

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(3)
    expect(result[0]?.endLine).toBe(7)
  })

  test('preserves reviewed lines when lines are deleted externally', () => {
    const originalLines = ['X', 'a', 'b', 'c']
    const ranges = [makeRange(2, 4, originalLines)]
    // External edit: first line deleted
    const newDoc = ['a', 'b', 'c']
    const result = fullReverify(ranges, newDoc)

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(3)
  })

  test('prefers the closest shifted duplicate block over an earlier duplicate', () => {
    const originalLines = ['x1', 'x2', 'x3', 'x4', 'a', 'b', 'c']
    const ranges = [makeRange(5, 7, originalLines)]
    const newDoc = ['a', 'b', 'c', 'x1', 'x2', 'x3', 'x4', 'a', 'b', 'c']
    const result = fullReverify(
      ranges,
      newDoc,
      originalLines.map((line) => hashLine(line)),
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(8)
    expect(result[0]?.endLine).toBe(10)
  })
})

describe('detectDeletionAdjacentLines', () => {
  test('single line deleted in middle returns adjacent lines above and below', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    const previousHashes = originalLines.map((l) => hashLine(l))
    // Delete 'c' (line 3)
    const newDoc = ['a', 'b', 'd', 'e']
    const result = detectDeletionAdjacentLines(ranges, previousHashes, newDoc, [])

    // Line 'b' (was old line 2, now new line 2) and 'd' (was old line 4, now new line 3)
    expect(result).toEqual([2, 3])
  })

  test('multiple consecutive lines deleted returns only boundary adjacents', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    const previousHashes = originalLines.map((l) => hashLine(l))
    // Delete 'b', 'c', 'd' (lines 2-4)
    const newDoc = ['a', 'e']
    const result = detectDeletionAdjacentLines(ranges, previousHashes, newDoc, [])

    // Line 'a' (new line 1) and 'e' (new line 2)
    expect(result).toEqual([1, 2])
  })

  test('deletion at start of file returns only line below', () => {
    const originalLines = ['a', 'b', 'c', 'd']
    const ranges = [makeRange(1, 4, originalLines)]
    const previousHashes = originalLines.map((l) => hashLine(l))
    // Delete 'a' (line 1)
    const newDoc = ['b', 'c', 'd']
    const result = detectDeletionAdjacentLines(ranges, previousHashes, newDoc, [])

    // Only 'b' (new line 1) is adjacent
    expect(result).toEqual([1])
  })

  test('deletion at end of file returns only line above', () => {
    const originalLines = ['a', 'b', 'c', 'd']
    const ranges = [makeRange(1, 4, originalLines)]
    const previousHashes = originalLines.map((l) => hashLine(l))
    // Delete 'd' (line 4)
    const newDoc = ['a', 'b', 'c']
    const result = detectDeletionAdjacentLines(ranges, previousHashes, newDoc, [])

    // Only 'c' (new line 3) is adjacent
    expect(result).toEqual([3])
  })

  test('no deletions returns empty result', () => {
    const originalLines = ['a', 'b', 'c']
    const ranges = [makeRange(1, 3, originalLines)]
    const previousHashes = originalLines.map((l) => hashLine(l))
    // Same doc, no deletions
    const newDoc = ['a', 'b', 'c']
    const result = detectDeletionAdjacentLines(ranges, previousHashes, newDoc, [])

    expect(result).toEqual([])
  })

  test('carry-forward of existing deletion-adjacent lines through document changes', () => {
    const originalLines = ['a', 'b', 'c', 'd']
    const ranges = [makeRange(1, 4, originalLines)]
    const previousHashes = originalLines.map((l) => hashLine(l))
    // No new deletions, but line 2 was previously marked as deletion-adjacent
    // and lines shifted: insert 'X' at start
    const newDoc = ['X', 'a', 'b', 'c', 'd']
    const result = detectDeletionAdjacentLines(ranges, previousHashes, newDoc, [2])

    // Old line 2 ('b') maps to new line 3
    expect(result).toEqual([3])
  })

  test('deletion of unreviewed lines has no effect', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    // Only lines 1-2 reviewed
    const ranges = [makeRange(1, 2, originalLines)]
    const previousHashes = originalLines.map((l) => hashLine(l))
    // Delete 'd' (line 4) - not reviewed
    const newDoc = ['a', 'b', 'c', 'e']
    const result = detectDeletionAdjacentLines(ranges, previousHashes, newDoc, [])

    expect(result).toEqual([])
  })

  test('empty ranges returns empty result', () => {
    const previousHashes = ['a', 'b'].map((l) => hashLine(l))
    const result = detectDeletionAdjacentLines([], previousHashes, ['a'], [])
    expect(result).toEqual([])
  })

  test('empty previous hashes returns empty result', () => {
    const ranges = [makeRange(1, 2, ['a', 'b'])]
    const result = detectDeletionAdjacentLines(ranges, [], ['a'], [])
    expect(result).toEqual([])
  })

  test('modified lines are not treated as deleted', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    const previousHashes = originalLines.map((l) => hashLine(l))
    // Lines 2,3 modified (content changed but lines still exist)
    const newDoc = ['a', 'B', 'C', 'd', 'e']
    const result = detectDeletionAdjacentLines(ranges, previousHashes, newDoc, [])

    // No lines were deleted, just modified — should not flag anything
    expect(result).toEqual([])
  })

  test('mixed modification and deletion flags only deletion adjacents', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    const previousHashes = originalLines.map((l) => hashLine(l))
    // Line 2 modified to 'B', line 3 deleted
    const newDoc = ['a', 'B', 'd', 'e']
    const result = detectDeletionAdjacentLines(ranges, previousHashes, newDoc, [])

    // Gap between a(0→0) and d(3→2): oldGap=2, newGap=1 → 1 deletion
    expect(result).toEqual([1, 3])
  })
})
