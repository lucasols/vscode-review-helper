import { describe, expect, test } from 'vitest'
import {
  adjustRangesForChanges,
  verifyRanges,
  realignRanges,
  fullReverify,
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

describe('adjustRangesForChanges', () => {
  const originalLines = [
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

  test('insertion above reviewed range shifts it down', () => {
    const ranges = [makeRange(5, 8, originalLines)]
    const result = adjustRangesForChanges(ranges, [
      { startLine: 2, linesRemoved: 0, linesInserted: 2 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(7)
    expect(result[0]?.endLine).toBe(10)
  })

  test('deletion above reviewed range shifts it up', () => {
    const ranges = [makeRange(5, 8, originalLines)]
    const result = adjustRangesForChanges(ranges, [
      { startLine: 1, linesRemoved: 2, linesInserted: 0 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(3)
    expect(result[0]?.endLine).toBe(6)
  })

  test('modification keeps hashes for reverification later', () => {
    const ranges = [makeRange(1, 5, originalLines)]
    // Replace line 3 with 1 new line - hashes are preserved (not verified here)
    const result = adjustRangesForChanges(ranges, [
      { startLine: 3, linesRemoved: 1, linesInserted: 1 },
    ])

    // Range should still be [1-5] with all hashes preserved
    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(5)
    // Line 3's hash is kept for later verification
    expect(result[0]?.lineHashes[3]).toBe(hashLine('line3'))
  })

  test('undo preserves hashes (same line count, same positions)', () => {
    const ranges = [makeRange(1, 5, originalLines)]
    const result = adjustRangesForChanges(ranges, [
      { startLine: 3, linesRemoved: 1, linesInserted: 1 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(5)
  })

  test('insertion within reviewed range expands it', () => {
    const ranges = [makeRange(1, 5, originalLines)]
    const result = adjustRangesForChanges(ranges, [
      { startLine: 4, linesRemoved: 0, linesInserted: 2 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(7)
    // Original lines 4-5 shifted to 6-7
    expect(result[0]?.lineHashes[6]).toBe(hashLine('line4'))
    expect(result[0]?.lineHashes[7]).toBe(hashLine('line5'))
    // New lines 4-5 have no hashes
    expect(result[0]?.lineHashes[4]).toBeUndefined()
    expect(result[0]?.lineHashes[5]).toBeUndefined()
  })

  test('deletion within reviewed range shrinks it', () => {
    const ranges = [makeRange(1, 10, originalLines)]
    const result = adjustRangesForChanges(ranges, [
      { startLine: 4, linesRemoved: 3, linesInserted: 0 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(7)
  })

  test('change below reviewed range does not affect it', () => {
    const ranges = [makeRange(1, 3, originalLines)]
    const result = adjustRangesForChanges(ranges, [
      { startLine: 5, linesRemoved: 1, linesInserted: 1 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(3)
  })
})

describe('verifyRanges', () => {
  test('keeps lines with matching hashes', () => {
    const lines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, lines)]
    const result = verifyRanges(ranges, lines)

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(5)
  })

  test('removes lines with non-matching hashes', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]
    const modifiedLines = ['a', 'b', 'CHANGED', 'd', 'e']
    const result = verifyRanges(ranges, modifiedLines)

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

  test('edit then undo: hashes survive and match again', () => {
    const originalLines = ['a', 'b', 'c', 'd', 'e']
    const ranges = [makeRange(1, 5, originalLines)]

    // Step 1: edit line 3 (shift only, no verify)
    const afterEdit = adjustRangesForChanges(ranges, [
      { startLine: 3, linesRemoved: 1, linesInserted: 1 },
    ])

    // Verify against modified content - line 3 should be unreviewed
    const modifiedLines = ['a', 'b', 'CHANGED', 'd', 'e']
    const verifiedAfterEdit = verifyRanges(afterEdit, modifiedLines)
    const editReviewed = new Set<number>()
    for (const range of verifiedAfterEdit) {
      for (let l = range.startLine; l <= range.endLine; l++) {
        editReviewed.add(l)
      }
    }
    expect(editReviewed.has(3)).toBe(false)

    // Step 2: undo (shift only, hashes still preserved in afterEdit)
    const afterUndo = adjustRangesForChanges(afterEdit, [
      { startLine: 3, linesRemoved: 1, linesInserted: 1 },
    ])

    // Verify against original content - line 3 should be reviewed again
    const verifiedAfterUndo = verifyRanges(afterUndo, originalLines)
    expect(verifiedAfterUndo).toHaveLength(1)
    expect(verifiedAfterUndo[0]?.startLine).toBe(1)
    expect(verifiedAfterUndo[0]?.endLine).toBe(5)
  })
})

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
})
