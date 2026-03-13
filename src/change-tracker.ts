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
 * Only shifts line numbers for insertions/deletions - does NOT verify hashes.
 * Hashes are preserved so that undo can restore reviewed status.
 * Use `verifyRanges` or `fullReverify` for hash verification.
 */
export function adjustRangesForChanges(
  ranges: ReviewedRange[],
  changes: ContentChange[],
): ReviewedRange[] {
  let adjusted = ranges.map((r) => ({ ...r, lineHashes: { ...r.lineHashes } }))

  // Apply each change, sorted from bottom to top to avoid cascading offsets
  const sortedChanges = [...changes].sort((a, b) => b.startLine - a.startLine)

  for (const change of sortedChanges) {
    adjusted = applyChange(adjusted, change)
  }

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
 * Verify hashes against current document content, returning only lines
 * that still match. Used for computing decorations and progress.
 * Does NOT mutate stored state - returns a filtered view.
 */
export function verifyRanges(
  ranges: ReviewedRange[],
  documentLines: string[],
): ReviewedRange[] {
  return normalizeRanges(reverifyHashes(ranges, documentLines))
}

/**
 * Realign reviewed hashes to new line positions by matching content order.
 * Handles external edits (git operations, other editors) where lines shifted
 * without going through handleDocumentChange.
 *
 * Uses a greedy ordered match: walks through old hashes and document lines
 * in parallel, matching hashes to their new positions.
 */
export function realignRanges(
  ranges: ReviewedRange[],
  documentLines: string[],
): ReviewedRange[] {
  // Collect all (oldLine, hash) pairs sorted by line number
  const oldEntries: Array<{ hash: string }> = []
  const sorted = normalizeRanges(ranges)
  for (const range of sorted) {
    for (let line = range.startLine; line <= range.endLine; line++) {
      const hash = range.lineHashes[line]
      if (hash !== undefined) {
        oldEntries.push({ hash })
      }
    }
  }

  if (oldEntries.length === 0) return []

  // Hash all lines in the current document
  const docHashes = documentLines.map((line) => hashLine(line))

  // Greedy ordered match: for each old hash, find the next occurrence
  // in the document. If not found, skip that old entry.
  let docIdx = 0
  const matchedLines: Array<{ newLine: number; hash: string }> = []

  for (const entry of oldEntries) {
    let found = false
    for (let j = docIdx; j < docHashes.length; j++) {
      if (docHashes[j] === entry.hash) {
        matchedLines.push({ newLine: j + 1, hash: entry.hash }) // 1-based
        docIdx = j + 1
        found = true
        break
      }
    }
    if (!found) {
      // This old line was deleted or modified - skip it
    }
  }

  // Build ranges from matched lines
  return linesToRanges(matchedLines)
}

function linesToRanges(
  lines: Array<{ newLine: number; hash: string }>,
): ReviewedRange[] {
  if (lines.length === 0) return []

  const result: ReviewedRange[] = []
  const first = lines[0]
  if (!first) return result

  let start = first.newLine
  let end = first.newLine
  let hashes: Record<number, string> = { [first.newLine]: first.hash }

  for (let i = 1; i < lines.length; i++) {
    const entry = lines[i]
    if (!entry) continue

    if (entry.newLine === end + 1) {
      end = entry.newLine
      hashes[entry.newLine] = entry.hash
    } else {
      result.push({ startLine: start, endLine: end, lineHashes: hashes })
      start = entry.newLine
      end = entry.newLine
      hashes = { [entry.newLine]: entry.hash }
    }
  }

  result.push({ startLine: start, endLine: end, lineHashes: hashes })
  return result
}

/**
 * Full re-verification that realigns hashes to new positions then prunes
 * any that no longer match. Used when a file is opened to catch external
 * changes (git operations, other editors, etc.).
 * The result should be stored back to state.
 */
export function fullReverify(
  ranges: ReviewedRange[],
  documentLines: string[],
): ReviewedRange[] {
  const realigned = realignRanges(ranges, documentLines)
  return normalizeRanges(reverifyHashes(realigned, documentLines))
}
