import { describe, expect, test } from 'vitest'
import { ReviewStateManager } from './review-state-manager'
import { fingerprintDocumentLineHashes, hashDocumentLines } from './review-state'

function getReviewedLines(manager: ReviewStateManager, relativePath: string): Set<number> {
  const reviewedLines = new Set<number>()
  const fileState = manager.getFileState(relativePath)
  if (!fileState) {
    return reviewedLines
  }

  for (const range of fileState.reviewedRanges) {
    for (let line = range.startLine; line <= range.endLine; line++) {
      reviewedLines.add(line)
    }
  }

  return reviewedLines
}

function makeWholeDocumentReplacement(
  previousLines: string[],
  nextLines: string[],
): Array<{
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  text: string
}> {
  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: {
          line: Math.max(previousLines.length - 1, 0),
          character: previousLines.at(-1)?.length ?? 0,
        },
      },
      text: nextLines.join('\n'),
    },
  ]
}

describe('ReviewStateManager.handleDocumentChange', () => {
  test('keeps reviewed lines shifted by a pure line insertion before the range', () => {
    const manager = new ReviewStateManager()
    const relativePath = 'example.ts'
    const originalLines = ['header', 'keep-a', 'keep-b']

    manager.markSelectionReviewed(relativePath, 2, 3, originalLines)

    const updatedLines = ['header', 'new-a', 'new-b', 'keep-a', 'keep-b']
    manager.handleDocumentChange(
      relativePath,
      [
        {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 0 },
          },
          text: 'new-a\nnew-b\n',
        },
      ],
      updatedLines.length,
      updatedLines,
    )

    expect(getReviewedLines(manager, relativePath)).toEqual(new Set([4, 5]))

    manager.dispose()
  })

  test('restores the exact original state after switching A -> B -> A', () => {
    const manager = new ReviewStateManager()
    const relativePath = 'example.ts'
    const versionA = [
      'interface User {',
      '  id: number',
      '  name: string',
      '  email: string',
      '  avatar?: string',
      '  bio?: string',
      '  createdAt: Date',
      '  lastLoginAt?: Date',
      '  isActive: boolean',
      '  permissions: string[]',
      '  test?: string',
      "  role: 'admin' | 'user' | 'viewer'",
      '}',
      '',
    ]

    manager.markSelectionReviewed(relativePath, 1, 9, versionA)
    manager.markSelectionReviewed(relativePath, 11, 14, versionA)

    const versionB = [
      'interface User {',
      '  id: number',
      '  name: string',
      '  email: string',
      '  avatar?: string',
      '  bio?: string',
      '  createdAt: Date',
      '  lastLoginAt?: Date',
      '  isActive: boolean',
      "  department?: 'engineering' | 'design' | 'support'",
      '  location?: string',
      '  permissions: string[]',
      "  role: 'admin' | 'user' | 'viewer'",
      '}',
      '',
    ]

    manager.handleDocumentChange(
      relativePath,
      makeWholeDocumentReplacement(versionA, versionB),
      versionB.length,
      versionB,
    )

    expect(getReviewedLines(manager, relativePath)).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15]),
    )
    expect(manager.getFileState(relativePath)?.deletionAdjacentLines).toEqual([12, 13])

    manager.handleDocumentChange(
      relativePath,
      makeWholeDocumentReplacement(versionB, versionA),
      versionA.length,
      versionA,
    )

    const restored = manager.getFileState(relativePath)
    expect(getReviewedLines(manager, relativePath)).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14]),
    )
    expect(restored?.deletionAdjacentLines).toBeUndefined()
    expect(restored?.snapshots).toHaveLength(2)

    manager.dispose()
  })

  test('restores reviewed lines after undo and redo return to previous fingerprints', () => {
    const manager = new ReviewStateManager()
    const relativePath = 'undo.ts'
    const originalLines = ['const value = 1', 'const label = "kept"']

    manager.markSelectionReviewed(relativePath, 1, 1, originalLines)

    const changedLines = ['const value = 2', 'const label = "kept"']
    manager.handleDocumentChange(
      relativePath,
      makeWholeDocumentReplacement(originalLines, changedLines),
      changedLines.length,
      changedLines,
    )
    expect(getReviewedLines(manager, relativePath)).toEqual(new Set())

    manager.handleDocumentChange(
      relativePath,
      makeWholeDocumentReplacement(changedLines, originalLines),
      originalLines.length,
      originalLines,
    )
    expect(getReviewedLines(manager, relativePath)).toEqual(new Set([1]))

    manager.handleDocumentChange(
      relativePath,
      makeWholeDocumentReplacement(originalLines, changedLines),
      changedLines.length,
      changedLines,
    )
    expect(getReviewedLines(manager, relativePath)).toEqual(new Set())

    manager.dispose()
  })

  test('keeps separate manual review state per document version', () => {
    const manager = new ReviewStateManager()
    const relativePath = 'branch.ts'
    const versionA = ['keep-a', 'keep-b', 'keep-c']

    manager.markSelectionReviewed(relativePath, 1, 1, versionA)

    const versionB = ['intro', 'keep-a', 'keep-b', 'keep-c']
    manager.handleDocumentChange(
      relativePath,
      makeWholeDocumentReplacement(versionA, versionB),
      versionB.length,
      versionB,
    )
    expect(getReviewedLines(manager, relativePath)).toEqual(new Set([2]))

    manager.markSelectionReviewed(relativePath, 1, 1, versionB)
    expect(getReviewedLines(manager, relativePath)).toEqual(new Set([1, 2]))

    manager.handleDocumentChange(
      relativePath,
      makeWholeDocumentReplacement(versionB, versionA),
      versionA.length,
      versionA,
    )
    expect(getReviewedLines(manager, relativePath)).toEqual(new Set([1]))

    manager.handleDocumentChange(
      relativePath,
      makeWholeDocumentReplacement(versionA, versionB),
      versionB.length,
      versionB,
    )
    expect(getReviewedLines(manager, relativePath)).toEqual(new Set([1, 2]))

    manager.dispose()
  })

  test('prunes snapshot history to the active fingerprint plus the newest 19 others', () => {
    const manager = new ReviewStateManager()
    const relativePath = 'history.ts'

    for (let version = 0; version <= 20; version++) {
      manager.markSelectionReviewed(relativePath, 1, 1, [`line-${String(version)}`])
    }

    const fileState = manager.getFileState(relativePath)
    const snapshots = fileState?.snapshots ?? []
    const oldestPrunedFingerprint = fingerprintDocumentLineHashes(
      hashDocumentLines(['line-0']),
    )

    expect(snapshots).toHaveLength(20)
    expect(snapshots[0]?.fingerprint).toBe(fileState?.documentFingerprint)
    expect(snapshots.some((entry) => entry.fingerprint === oldestPrunedFingerprint)).toBe(false)

    manager.dispose()
  })

  test('does not create an extra snapshot when a new fingerprint keeps the same effective review state', () => {
    const manager = new ReviewStateManager()
    const relativePath = 'stable.ts'
    const versionA = ['reviewed line', 'todo: first']

    manager.markSelectionReviewed(relativePath, 1, 1, versionA)
    const before = manager.getFileState(relativePath)

    const versionB = ['reviewed line', 'todo: second']
    manager.handleDocumentChange(
      relativePath,
      makeWholeDocumentReplacement(versionA, versionB),
      versionB.length,
      versionB,
    )

    const after = manager.getFileState(relativePath)
    expect(after?.documentFingerprint).not.toBe(before?.documentFingerprint)
    expect(after?.snapshots).toHaveLength(1)
    expect(after?.snapshots?.[0]?.fingerprint).toBe(before?.documentFingerprint)

    manager.dispose()
  })
})
