import type { ReviewedRange } from './types'
import { hashLine, normalizeRanges } from './review-state'

interface ContentChange {
  /** 1-based start line of the change in the original document */
  startLine: number
  /** Number of lines removed from the original document */
  linesRemoved: number
  /** Number of lines inserted */
  linesInserted: number
}

/**
 * Adjust reviewed ranges for document content changes.
 * Shifts line numbers for insertions/deletions, then re-verifies hashes
 * for lines in the affected area.
 */
export function adjustRangesForChanges(
  ranges: ReviewedRange[],
  changes: ContentChange[],
  documentLines: string[],
): ReviewedRange[] {
  let adjusted = ranges.map((r) => ({ ...r, lineHashes: { ...r.lineHashes } }))

  // Apply each change, sorted from bottom to top to avoid cascading offsets
  const sortedChanges = [...changes].sort((a, b) => b.startLine - a.startLine)

  for (const change of sortedChanges) {
    adjusted = applyChange(adjusted, change)
  }

  // Re-verify hashes against current document content
  adjusted = reverifyHashes(adjusted, documentLines)

  return normalizeRanges(adjusted)
}

function applyChange(
  ranges: ReviewedRange[],
  change: ContentChange,
): ReviewedRange[] {
  const { startLine, linesRemoved, linesInserted } = change
  const endOfRemoval = startLine + linesRemoved - 1
  const delta = linesInserted - linesRemoved
  const result: ReviewedRange[] = []

  for (const range of ranges) {
    if (range.endLine < startLine) {
      // Range is entirely before the change - keep as is
      result.push(range)
    } else if (range.startLine > endOfRemoval) {
      // Range is entirely after the change - shift by delta
      const shiftedHashes: Record<number, string> = {}
      for (const [lineStr, hash] of Object.entries(range.lineHashes)) {
        shiftedHashes[Number(lineStr) + delta] = hash
      }
      result.push({
        startLine: range.startLine + delta,
        endLine: range.endLine + delta,
        lineHashes: shiftedHashes,
      })
    } else {
      // Range overlaps with the change
      // Build a single range with remapped hashes, then let reverification
      // decide which lines are still valid (supports undo scenarios)
      const newHashes: Record<number, string> = {}

      // Lines before the change zone (within this range)
      for (let line = range.startLine; line < startLine; line++) {
        const hash = range.lineHashes[line]
        if (hash !== undefined) {
          newHashes[line] = hash
        }
      }

      // Lines in the change zone: keep hashes for 1:1 mapped positions
      // so reverification can check if content was restored (undo)
      const mappable = Math.min(linesRemoved, linesInserted)
      for (let i = 0; i < mappable; i++) {
        const oldLine = startLine + i
        if (oldLine <= range.endLine) {
          const hash = range.lineHashes[oldLine]
          if (hash !== undefined) {
            newHashes[startLine + i] = hash
          }
        }
      }

      // Lines after the change zone (within this range), shifted by delta
      for (let line = endOfRemoval + 1; line <= range.endLine; line++) {
        const hash = range.lineHashes[line]
        if (hash !== undefined) {
          newHashes[line + delta] = hash
        }
      }

      const newEnd = range.endLine + delta
      if (newEnd >= range.startLine && Object.keys(newHashes).length > 0) {
        result.push({
          startLine: range.startLine,
          endLine: newEnd,
          lineHashes: newHashes,
        })
      }
    }
  }

  return result
}

/** Re-verify hashes: any line whose hash doesn't match current content is removed */
function reverifyHashes(
  ranges: ReviewedRange[],
  documentLines: string[],
): ReviewedRange[] {
  const result: ReviewedRange[] = []

  for (const range of ranges) {
    const validLines: number[] = []

    for (let line = range.startLine; line <= range.endLine; line++) {
      const content = documentLines[line - 1]
      const storedHash = range.lineHashes[line]

      if (
        content !== undefined &&
        storedHash !== undefined &&
        hashLine(content) === storedHash
      ) {
        validLines.push(line)
      }
    }

    // Convert valid lines back into contiguous ranges
    let subStart = -1
    let subEnd = -1
    const subHashes: Record<number, string> = {}

    for (const line of validLines) {
      const hash = range.lineHashes[line]
      if (hash === undefined) continue

      if (subStart === -1) {
        subStart = line
        subEnd = line
        subHashes[line] = hash
      } else if (line === subEnd + 1) {
        subEnd = line
        subHashes[line] = hash
      } else {
        result.push({
          startLine: subStart,
          endLine: subEnd,
          lineHashes: { ...subHashes },
        })
        // Reset for new sub-range
        for (const key of Object.keys(subHashes)) {
          delete subHashes[Number(key)]
        }
        subStart = line
        subEnd = line
        subHashes[line] = hash
      }
    }

    if (subStart !== -1) {
      result.push({
        startLine: subStart,
        endLine: subEnd,
        lineHashes: { ...subHashes },
      })
    }
  }

  return result
}

/**
 * Full re-verification of all reviewed ranges against current document content.
 * Used when a file is opened to catch external changes (git operations, etc.).
 */
export function fullReverify(
  ranges: ReviewedRange[],
  documentLines: string[],
): ReviewedRange[] {
  return normalizeRanges(reverifyHashes(ranges, documentLines))
}
