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
 * Uses a patience-diff algorithm: anchors on lines unique in both sequences,
 * then recursively matches between anchors using LCS for non-unique regions.
 * This avoids the greedy misalignment problem with duplicate lines (blank
 * lines, closing braces, etc.).
 */
export function realignRanges(
  ranges: ReviewedRange[],
  documentLines: string[],
): ReviewedRange[] {
  // Collect all hash entries sorted by line number
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

  const docHashes = documentLines.map((line) => hashLine(line))
  const oldHashes = oldEntries.map((e) => e.hash)

  const matches = patienceMatch(oldHashes, 0, oldHashes.length, docHashes, 0, docHashes.length)

  const matchedLines: Array<{ newLine: number; hash: string }> = []
  for (const match of matches) {
    const hash = docHashes[match.newIdx]
    if (hash !== undefined) {
      matchedLines.push({ newLine: match.newIdx + 1, hash })
    }
  }

  return linesToRanges(matchedLines)
}

interface SeqMatch {
  oldIdx: number
  newIdx: number
}

/**
 * Patience-diff sequence matching.
 * 1. Trim common prefix and suffix
 * 2. Find lines unique in both subsequences → anchors via LIS
 * 3. Recursively match regions between anchors
 * 4. Fall back to LCS when no unique anchors exist
 */
function patienceMatch(
  oldSeq: string[],
  oldStart: number,
  oldEnd: number,
  newSeq: string[],
  newStart: number,
  newEnd: number,
): SeqMatch[] {
  if (oldStart >= oldEnd || newStart >= newEnd) return []

  const result: SeqMatch[] = []

  // Trim common prefix
  let oS = oldStart
  let nS = newStart
  while (oS < oldEnd && nS < newEnd && oldSeq[oS] === newSeq[nS]) {
    result.push({ oldIdx: oS, newIdx: nS })
    oS++
    nS++
  }

  // Trim common suffix
  let oE = oldEnd
  let nE = newEnd
  const suffixMatches: SeqMatch[] = []
  while (oE > oS && nE > nS && oldSeq[oE - 1] === newSeq[nE - 1]) {
    oE--
    nE--
    suffixMatches.push({ oldIdx: oE, newIdx: nE })
  }

  if (oS < oE && nS < nE) {
    const anchors = findPatienceAnchors(oldSeq, oS, oE, newSeq, nS, nE)

    if (anchors.length > 0) {
      // Recursively match regions between anchors
      let prevOldEnd = oS
      let prevNewEnd = nS

      for (const anchor of anchors) {
        const subMatches = patienceMatch(
          oldSeq,
          prevOldEnd,
          anchor.oldIdx,
          newSeq,
          prevNewEnd,
          anchor.newIdx,
        )
        result.push(...subMatches)
        result.push(anchor)
        prevOldEnd = anchor.oldIdx + 1
        prevNewEnd = anchor.newIdx + 1
      }

      const tailMatches = patienceMatch(oldSeq, prevOldEnd, oE, newSeq, prevNewEnd, nE)
      result.push(...tailMatches)
    } else {
      // No unique anchors — fall back to LCS
      const lcsMatches = computeLCS(oldSeq, oS, oE, newSeq, nS, nE)
      result.push(...lcsMatches)
    }
  }

  // Append suffix matches (collected in reverse order)
  for (let i = suffixMatches.length - 1; i >= 0; i--) {
    const m = suffixMatches[i]
    if (m) result.push(m)
  }

  return result
}

/**
 * Find patience anchors: lines unique in both subsequences,
 * ordered via LIS (Longest Increasing Subsequence) on new positions.
 */
function findPatienceAnchors(
  oldSeq: string[],
  oldStart: number,
  oldEnd: number,
  newSeq: string[],
  newStart: number,
  newEnd: number,
): SeqMatch[] {
  const oldPositions = new Map<string, number[]>()
  for (let i = oldStart; i < oldEnd; i++) {
    const h = oldSeq[i]
    if (h === undefined) continue
    const positions = oldPositions.get(h)
    if (positions) {
      positions.push(i)
    } else {
      oldPositions.set(h, [i])
    }
  }

  const newPositions = new Map<string, number[]>()
  for (let j = newStart; j < newEnd; j++) {
    const h = newSeq[j]
    if (h === undefined) continue
    const positions = newPositions.get(h)
    if (positions) {
      positions.push(j)
    } else {
      newPositions.set(h, [j])
    }
  }

  // Lines unique in both sequences
  const uniquePairs: SeqMatch[] = []
  for (const [hash, oldPos] of oldPositions) {
    if (oldPos.length !== 1) continue
    const newPos = newPositions.get(hash)
    if (!newPos || newPos.length !== 1) continue
    const oldIndex = oldPos[0]
    const newIndex = newPos[0]
    if (oldIndex !== undefined && newIndex !== undefined) {
      uniquePairs.push({ oldIdx: oldIndex, newIdx: newIndex })
    }
  }

  uniquePairs.sort((a, b) => a.oldIdx - b.oldIdx)
  if (uniquePairs.length === 0) return []

  const newIndices = uniquePairs.map((p) => p.newIdx)
  const lisIndices = longestIncreasingSubsequence(newIndices)

  const anchors: SeqMatch[] = []
  for (const i of lisIndices) {
    const pair = uniquePairs[i]
    if (pair !== undefined) {
      anchors.push(pair)
    }
  }
  return anchors
}

/**
 * Standard LCS via dynamic programming.
 * Falls back to greedy matching for very large regions to avoid excessive memory.
 */
function computeLCS(
  oldSeq: string[],
  oldStart: number,
  oldEnd: number,
  newSeq: string[],
  newStart: number,
  newEnd: number,
): SeqMatch[] {
  const n = oldEnd - oldStart
  const m = newEnd - newStart

  if (n === 0 || m === 0) return []

  // Safety bound: fall back to greedy for very large regions
  if (n * m > 1_000_000) {
    return greedyMatch(oldSeq, oldStart, oldEnd, newSeq, newStart, newEnd)
  }

  const w = m + 1
  const dp = new Array<number>((n + 1) * w).fill(0)

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldSeq[oldStart + i - 1] === newSeq[newStart + j - 1]) {
        dp[i * w + j] = (dp[(i - 1) * w + (j - 1)] ?? 0) + 1
      } else {
        dp[i * w + j] = Math.max(dp[(i - 1) * w + j] ?? 0, dp[i * w + (j - 1)] ?? 0)
      }
    }
  }

  const result: SeqMatch[] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (oldSeq[oldStart + i - 1] === newSeq[newStart + j - 1]) {
      result.push({ oldIdx: oldStart + i - 1, newIdx: newStart + j - 1 })
      i--
      j--
    } else if ((dp[(i - 1) * w + j] ?? 0) > (dp[i * w + (j - 1)] ?? 0)) {
      i--
    } else {
      j--
    }
  }

  return result.reverse()
}

/**
 * Greedy forward matching — fallback for very large sequences where
 * LCS DP would use too much memory.
 */
function greedyMatch(
  oldSeq: string[],
  oldStart: number,
  oldEnd: number,
  newSeq: string[],
  newStart: number,
  newEnd: number,
): SeqMatch[] {
  const result: SeqMatch[] = []
  let nIdx = newStart

  for (let oIdx = oldStart; oIdx < oldEnd; oIdx++) {
    for (let j = nIdx; j < newEnd; j++) {
      if (newSeq[j] === oldSeq[oIdx]) {
        result.push({ oldIdx: oIdx, newIdx: j })
        nIdx = j + 1
        break
      }
    }
  }

  return result
}

/**
 * Longest Increasing Subsequence — O(n log n).
 * Returns indices into the input array that form the LIS.
 */
function longestIncreasingSubsequence(values: number[]): number[] {
  if (values.length === 0) return []

  const n = values.length
  const tails: number[] = []
  const tailIndices: number[] = []
  const parent = new Array<number>(n).fill(-1)

  for (let i = 0; i < n; i++) {
    const val = values[i]
    if (val === undefined) continue

    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const tailVal = tails[mid]
      if (tailVal !== undefined && tailVal < val) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }

    tails[lo] = val
    tailIndices[lo] = i

    if (lo > 0) {
      const prevIdx = tailIndices[lo - 1]
      if (prevIdx !== undefined) {
        parent[i] = prevIdx
      }
    }
  }

  const result: number[] = []
  let idx = tailIndices[tails.length - 1]
  while (idx !== undefined && idx !== -1) {
    result.push(idx)
    const nextIdx = parent[idx]
    if (nextIdx === undefined || nextIdx === -1) break
    idx = nextIdx
  }

  return result.reverse()
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
