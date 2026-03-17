import { describe, expect, test } from 'vitest'
import { ReviewStateManager } from './review-state-manager'

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

  test('uses snapshot reverify for whole-document replacements', () => {
    const manager = new ReviewStateManager()
    const relativePath = 'example.ts'
    const originalLines = [
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

    manager.markSelectionReviewed(relativePath, 1, 9, originalLines)
    manager.markSelectionReviewed(relativePath, 11, 14, originalLines)

    const updatedLines = [
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
      [
        {
          range: {
            start: { line: 0, character: 0 },
            end: {
              line: originalLines.length - 1,
              character: originalLines.at(-1)?.length ?? 0,
            },
          },
          text: updatedLines.join('\n'),
        },
      ],
      updatedLines.length,
      updatedLines,
    )

    // Line 13 is now deletion-adjacent (old reviewed line 11 'test?: string' was deleted)
    // so it is removed from reviewed ranges and marked for re-review
    expect(getReviewedLines(manager, relativePath)).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15]),
    )

    const fileState = manager.getFileState(relativePath)
    // Old line 10 ('permissions') maps to new line 12, old line 12 ('role') maps to new line 13
    expect(fileState?.deletionAdjacentLines).toEqual([12, 13])

    manager.dispose()
  })
})
