import { describe, expect, test } from 'vitest'
import { adjustRangesForChanges, fullReverify } from './change-tracker'
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
    // Insert 2 lines at line 2
    const newLines = [
      'line1',
      'new1',
      'new2',
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
    const result = adjustRangesForChanges(
      ranges,
      [{ startLine: 2, linesRemoved: 0, linesInserted: 2 }],
      newLines,
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(7)
    expect(result[0]?.endLine).toBe(10)
  })

  test('deletion above reviewed range shifts it up', () => {
    const ranges = [makeRange(5, 8, originalLines)]
    // Delete lines 1-2
    const newLines = [
      'line3',
      'line4',
      'line5',
      'line6',
      'line7',
      'line8',
      'line9',
      'line10',
    ]
    const result = adjustRangesForChanges(
      ranges,
      [{ startLine: 1, linesRemoved: 2, linesInserted: 0 }],
      newLines,
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(3)
    expect(result[0]?.endLine).toBe(6)
  })

  test('modification within reviewed range invalidates changed lines', () => {
    const ranges = [makeRange(1, 5, originalLines)]
    // Modify line 3
    const newLines = [
      'line1',
      'line2',
      'MODIFIED',
      'line4',
      'line5',
      'line6',
      'line7',
      'line8',
      'line9',
      'line10',
    ]
    const result = adjustRangesForChanges(
      ranges,
      [{ startLine: 3, linesRemoved: 1, linesInserted: 1 }],
      newLines,
    )

    // Lines 1-2 and 4-5 should still be reviewed, line 3 should not
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

  test('undo restores reviewed status (content matches hash)', () => {
    const ranges = [makeRange(1, 5, originalLines)]
    // "Undo" - content is same as original
    const result = adjustRangesForChanges(
      ranges,
      [{ startLine: 3, linesRemoved: 1, linesInserted: 1 }],
      originalLines,
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(5)
  })

  test('insertion within reviewed range splits it', () => {
    const ranges = [makeRange(1, 5, originalLines)]
    // Insert 2 lines after line 3 (replace 0 lines at line 4)
    const newLines = [
      'line1',
      'line2',
      'line3',
      'new1',
      'new2',
      'line4',
      'line5',
      'line6',
      'line7',
      'line8',
      'line9',
      'line10',
    ]
    const result = adjustRangesForChanges(
      ranges,
      [{ startLine: 4, linesRemoved: 0, linesInserted: 2 }],
      newLines,
    )

    // Lines 1-3 should still be reviewed, 4-5 shifted to 6-7
    const reviewedLines = new Set<number>()
    for (const range of result) {
      for (let l = range.startLine; l <= range.endLine; l++) {
        reviewedLines.add(l)
      }
    }
    expect(reviewedLines.has(1)).toBe(true)
    expect(reviewedLines.has(2)).toBe(true)
    expect(reviewedLines.has(3)).toBe(true)
    expect(reviewedLines.has(4)).toBe(false) // new line
    expect(reviewedLines.has(5)).toBe(false) // new line
    expect(reviewedLines.has(6)).toBe(true) // was line 4
    expect(reviewedLines.has(7)).toBe(true) // was line 5
  })

  test('deletion within reviewed range removes those lines', () => {
    const ranges = [makeRange(1, 10, originalLines)]
    // Delete lines 4-6
    const newLines = [
      'line1',
      'line2',
      'line3',
      'line7',
      'line8',
      'line9',
      'line10',
    ]
    const result = adjustRangesForChanges(
      ranges,
      [{ startLine: 4, linesRemoved: 3, linesInserted: 0 }],
      newLines,
    )

    // All remaining lines should be reviewed
    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(7)
  })

  test('change below reviewed range does not affect it', () => {
    const ranges = [makeRange(1, 3, originalLines)]
    const newLines = [
      'line1',
      'line2',
      'line3',
      'line4',
      'MODIFIED',
      'line6',
      'line7',
      'line8',
      'line9',
      'line10',
    ]
    const result = adjustRangesForChanges(
      ranges,
      [{ startLine: 5, linesRemoved: 1, linesInserted: 1 }],
      newLines,
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.startLine).toBe(1)
    expect(result[0]?.endLine).toBe(3)
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

    // Lines 1-2 and 4-5 should remain, line 3 removed
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
})
