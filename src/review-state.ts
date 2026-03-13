import type { FileReviewState, ReviewedRange } from './types'

/** DJB2 hash - fast, lightweight string hash. Trims trailing spaces so whitespace-only changes don't invalidate reviews. */
export function hashLine(content: string): string {
  const trimmed = content.trimEnd()
  let hash = 5381
  for (let i = 0; i < trimmed.length; i++) {
    // hash * 33 + char
    hash = ((hash << 5) + hash + trimmed.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/** Sort and merge overlapping/adjacent ranges */
export function normalizeRanges(ranges: ReviewedRange[]): ReviewedRange[] {
  if (ranges.length <= 1) return ranges

  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine)
  const result: ReviewedRange[] = []

  let current = sorted[0]
  if (!current) return result

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]
    if (!next) continue

    if (next.startLine <= current.endLine + 1) {
      // Merge overlapping or adjacent ranges
      const mergedHashes: Record<number, string> = { ...current.lineHashes }
      for (const [line, hash] of Object.entries(next.lineHashes)) {
        mergedHashes[Number(line)] = hash
      }
      current = {
        startLine: current.startLine,
        endLine: Math.max(current.endLine, next.endLine),
        lineHashes: mergedHashes,
      }
    } else {
      result.push(current)
      current = next
    }
  }
  result.push(current)

  return result
}

/** Mark a range of lines as reviewed, given the document lines */
export function markLinesReviewed(
  state: FileReviewState,
  startLine: number,
  endLine: number,
  documentLines: string[],
): FileReviewState {
  const lineHashes: Record<number, string> = {}
  for (let line = startLine; line <= endLine; line++) {
    const content = documentLines[line - 1]
    if (content !== undefined) {
      lineHashes[line] = hashLine(content)
    }
  }

  const newRange: ReviewedRange = { startLine, endLine, lineHashes }
  const merged = normalizeRanges([...state.reviewedRanges, newRange])

  return {
    ...state,
    reviewedRanges: merged,
    totalLines: documentLines.length,
  }
}

/** Remove reviewed status from a range of lines */
export function removeReviewedLines(
  state: FileReviewState,
  startLine: number,
  endLine: number,
): FileReviewState {
  const newRanges: ReviewedRange[] = []

  for (const range of state.reviewedRanges) {
    if (range.endLine < startLine || range.startLine > endLine) {
      // No overlap - keep as is
      newRanges.push(range)
    } else {
      // Has overlap - split
      if (range.startLine < startLine) {
        const beforeHashes: Record<number, string> = {}
        for (let line = range.startLine; line < startLine; line++) {
          const hash = range.lineHashes[line]
          if (hash !== undefined) {
            beforeHashes[line] = hash
          }
        }
        newRanges.push({
          startLine: range.startLine,
          endLine: startLine - 1,
          lineHashes: beforeHashes,
        })
      }
      if (range.endLine > endLine) {
        const afterHashes: Record<number, string> = {}
        for (let line = endLine + 1; line <= range.endLine; line++) {
          const hash = range.lineHashes[line]
          if (hash !== undefined) {
            afterHashes[line] = hash
          }
        }
        newRanges.push({
          startLine: endLine + 1,
          endLine: range.endLine,
          lineHashes: afterHashes,
        })
      }
    }
  }

  return { ...state, reviewedRanges: newRanges }
}

/** Compute review progress for a single file (0 to 1) */
export function computeFileProgress(
  state: FileReviewState,
  verifiedRanges?: ReviewedRange[],
  documentLines?: string[],
): number {
  const lastLine = effectiveLastLine(state.totalLines, documentLines)
  if (lastLine === 0) return 1

  const ranges = verifiedRanges ?? state.reviewedRanges
  let reviewedCount = 0
  for (const range of ranges) {
    if (range.startLine > lastLine) break
    const clampedEnd = Math.min(range.endLine, lastLine)
    reviewedCount += clampedEnd - range.startLine + 1
  }

  return Math.min(reviewedCount / lastLine, 1)
}

/** Compute total review progress across all files (0 to 1) */
export function computeTotalProgress(
  files: Record<string, FileReviewState>,
): number {
  const entries = Object.values(files)
  if (entries.length === 0) return 0

  let totalLines = 0
  let reviewedLines = 0

  for (const file of entries) {
    totalLines += file.totalLines
    for (const range of file.reviewedRanges) {
      reviewedLines += range.endLine - range.startLine + 1
    }
  }

  if (totalLines === 0) return 1
  return Math.min(reviewedLines / totalLines, 1)
}

/** Find the last non-whitespace-only line (1-based). Returns 0 if all lines are whitespace. */
function effectiveLastLine(
  totalLines: number,
  documentLines?: string[],
): number {
  if (!documentLines) return totalLines

  let last = totalLines
  while (last > 0) {
    const content = documentLines[last - 1]
    if (content !== undefined && content.trim().length > 0) break
    last--
  }
  return last
}

/** Get all unreviewed line ranges for a file */
export function getUnreviewedRanges(
  state: FileReviewState,
  verifiedRanges?: ReviewedRange[],
  documentLines?: string[],
): Array<{ startLine: number; endLine: number }> {
  if (state.totalLines === 0) return []

  const lastLine = effectiveLastLine(state.totalLines, documentLines)
  if (lastLine === 0) return []

  const reviewed = normalizeRanges(verifiedRanges ?? state.reviewedRanges)
  const unreviewed: Array<{ startLine: number; endLine: number }> = []
  let currentLine = 1

  for (const range of reviewed) {
    if (range.startLine > lastLine) break
    const clampedEnd = Math.min(range.endLine, lastLine)
    if (currentLine < range.startLine) {
      unreviewed.push({ startLine: currentLine, endLine: range.startLine - 1 })
    }
    currentLine = clampedEnd + 1
  }

  if (currentLine <= lastLine) {
    unreviewed.push({ startLine: currentLine, endLine: lastLine })
  }

  return unreviewed
}

/** Create an empty file review state */
export function createEmptyFileState(
  relativePath: string,
  totalLines: number,
): FileReviewState {
  return {
    relativePath,
    reviewedRanges: [],
    totalLines,
  }
}
