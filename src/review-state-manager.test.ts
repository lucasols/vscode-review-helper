import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as vscode from 'vscode'
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

describe('ReviewStateManager state file watching', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  test('does not rewrite the state after a delayed watcher event from its own save', async () => {
    const workspaceFolder: vscode.WorkspaceFolder = {
      uri: vscode.Uri.file('/tmp/review-helper-workspace'),
      name: 'review-helper-workspace',
      index: 0,
    }
    let diskContents = JSON.stringify({
      version: 3,
      branches: {
        main: {
          files: {},
          lastAccessedAt: 1,
        },
      },
    })

    vi.spyOn(vscode.workspace, 'workspaceFolders', 'get').mockReturnValue([
      workspaceFolder,
    ])
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(() => (
      Promise.resolve(new TextEncoder().encode(diskContents))
    ))
    const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile')
      .mockImplementation((_uri, data) => {
        diskContents = new TextDecoder().decode(data)
        return Promise.resolve()
      })

    const manager = new ReviewStateManager()
    await manager.load(workspaceFolder, 'main')
    await vi.advanceTimersByTimeAsync(500)
    expect(writeFile).toHaveBeenCalledOnce()

    // Reproduce a watcher notification arriving after the old timing-based
    // self-write suppression window had elapsed.
    await vi.advanceTimersByTimeAsync(101)
    await manager.reloadFromDisk()
    await vi.advanceTimersByTimeAsync(500)

    expect(writeFile).toHaveBeenCalledOnce()
    manager.dispose()
  })
})

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

  test('prunes snapshot history to the active fingerprint plus the newest 4 others', () => {
    const manager = new ReviewStateManager()
    const relativePath = 'history.ts'

    for (let version = 0; version <= 5; version++) {
      manager.markSelectionReviewed(relativePath, 1, 1, [`line-${String(version)}`])
    }

    const fileState = manager.getFileState(relativePath)
    const snapshots = fileState?.snapshots ?? []
    const oldestPrunedFingerprint = fingerprintDocumentLineHashes(
      hashDocumentLines(['line-0']),
    )

    expect(snapshots).toHaveLength(5)
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

describe('ReviewStateManager branch scoping', () => {
  test('keeps separate file state per branch', () => {
    const manager = new ReviewStateManager()
    const file = 'src/main.ts'

    manager.setCurrentBranch('feature/a')
    manager.markSelectionReviewed(file, 1, 3, ['a', 'b', 'c'])
    expect(getReviewedLines(manager, file)).toEqual(new Set([1, 2, 3]))

    manager.setCurrentBranch('feature/b')
    expect(manager.getFileState(file)).toBeUndefined()
    expect(getReviewedLines(manager, file)).toEqual(new Set())

    manager.markSelectionReviewed(file, 1, 1, ['x'])
    expect(getReviewedLines(manager, file)).toEqual(new Set([1]))

    manager.setCurrentBranch('feature/a')
    expect(getReviewedLines(manager, file)).toEqual(new Set([1, 2, 3]))

    manager.dispose()
  })

  test('clearAll only clears the active branch', () => {
    const manager = new ReviewStateManager()
    const file = 'a.ts'

    manager.setCurrentBranch('main')
    manager.markSelectionReviewed(file, 1, 1, ['a'])

    manager.setCurrentBranch('dev')
    manager.markSelectionReviewed(file, 1, 1, ['a'])

    manager.clearAll()
    expect(manager.getTrackedFiles()).toEqual([])

    manager.setCurrentBranch('main')
    expect(manager.getTrackedFiles()).toEqual([file])

    manager.dispose()
  })

  test('switching to the same branch is a no-op', () => {
    const manager = new ReviewStateManager()
    let events = 0
    const sub = manager.onDidChange(() => {
      events++
    })

    manager.setCurrentBranch('main')
    manager.setCurrentBranch('main')
    expect(events).toBe(1)

    sub.dispose()
    manager.dispose()
  })

  test('clears undo/redo history on branch switch', () => {
    const manager = new ReviewStateManager()
    const file = 'a.ts'

    manager.setCurrentBranch('main')
    manager.saveUndoSnapshot([file])
    manager.markSelectionReviewed(file, 1, 1, ['a'])

    manager.setCurrentBranch('dev')
    expect(manager.undo()).toBe(false)

    manager.setCurrentBranch('main')
    expect(manager.undo()).toBe(false)
    // The mark is still there — undo history was just discarded on switch.
    expect(manager.getFileState(file)).toBeDefined()

    manager.dispose()
  })

  test('serialized state preserves both branches', () => {
    const manager = new ReviewStateManager()

    manager.setCurrentBranch('main')
    manager.markSelectionReviewed('a.ts', 1, 1, ['a'])

    manager.setCurrentBranch('feature/x')
    manager.markSelectionReviewed('b.ts', 1, 1, ['b'])

    const state = manager.getState()
    expect(state.version).toBe(3)
    expect(Object.keys(state.branches).sort()).toEqual(['feature/x', 'main'])
    expect(Object.keys(state.branches['main']?.files ?? {})).toEqual(['a.ts'])
    expect(Object.keys(state.branches['feature/x']?.files ?? {})).toEqual(['b.ts'])

    manager.dispose()
  })
})

describe('ReviewStateManager branch expiration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('prunes branches not accessed within 7 days when switching away', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const manager = new ReviewStateManager()

    manager.setCurrentBranch('stale')
    manager.markSelectionReviewed('a.ts', 1, 1, ['a'])

    // Jump 8 days into the future, then switch branches — pruning runs and
    // removes "stale" because it has not been touched within the window.
    vi.setSystemTime(new Date('2026-01-09T00:00:00Z'))
    manager.setCurrentBranch('fresh')

    const state = manager.getState()
    expect(Object.keys(state.branches)).toEqual(['fresh'])

    manager.dispose()
  })

  test('keeps branches that were accessed within the expiration window', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const manager = new ReviewStateManager()

    manager.setCurrentBranch('recent')
    manager.markSelectionReviewed('a.ts', 1, 1, ['a'])

    // Only 6 days later — recent branch should survive.
    vi.setSystemTime(new Date('2026-01-07T00:00:00Z'))
    manager.setCurrentBranch('other')

    const state = manager.getState()
    expect(Object.keys(state.branches).sort()).toEqual(['other', 'recent'])

    manager.dispose()
  })

  test('does not prune the currently active branch', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const manager = new ReviewStateManager()

    manager.setCurrentBranch('only')
    manager.markSelectionReviewed('a.ts', 1, 1, ['a'])

    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    manager.setCurrentBranch('only')

    expect(manager.getTrackedFiles()).toEqual(['a.ts'])

    manager.dispose()
  })

  test('switching back to a stale branch creates a fresh empty scope', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const manager = new ReviewStateManager()

    manager.setCurrentBranch('A')
    manager.markSelectionReviewed('a.ts', 1, 1, ['a'])

    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
    manager.setCurrentBranch('B')

    // A was pruned; switching back gives an empty scope.
    manager.setCurrentBranch('A')
    expect(manager.getTrackedFiles()).toEqual([])

    manager.dispose()
  })
})
