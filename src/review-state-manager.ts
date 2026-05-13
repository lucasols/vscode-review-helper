import * as vscode from 'vscode'
import type {
  BranchReviewScope,
  FileReviewSnapshot,
  FileReviewState,
  ReviewedRange,
  ReviewState,
} from './types'
import {
  createEmptyFileState,
  fingerprintDocumentLineHashes,
  hashDocumentLines,
  hashLine,
  markLinesReviewed,
  normalizeRanges,
  removeReviewedLines,
} from './review-state'
import { detectDeletionAdjacentLines, fullReverify } from './change-tracker'
import {
  DEFAULT_BRANCH_KEY,
  createDefaultState,
  deserializeState,
  serializeState,
} from './state-persistence'
import { logDebug, logError, logInfo, logWarn } from './logger'

const REVIEW_STATE_FILE = '.vscode/review-state.json'
const SAVE_DEBOUNCE_MS = 500
const MAX_SNAPSHOTS_PER_FILE = 5
const MAX_UNDO_STACK = 50
const UNDO_TTL_MS = 5 * 60 * 1000
/** Branch scopes not accessed within this window are deleted on load / branch switch. */
const BRANCH_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000

interface UndoEntry {
  /** Branch this entry belongs to */
  branch: string
  /** Previous state of each affected file (null = file didn't exist) */
  files: Map<string, FileReviewState | null>
  timestamp: number
}

interface DocumentIdentity {
  totalLines: number
  documentLineHashes: string[]
  documentFingerprint: string
}

export class ReviewStateManager {
  private state: ReviewState = createDefaultState()
  private currentBranch: string = DEFAULT_BRANCH_KEY
  private saveTimeout: ReturnType<typeof setTimeout> | undefined
  private isSaving = false
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []

  async load(
    workspaceFolder: vscode.WorkspaceFolder,
    currentBranch: string = DEFAULT_BRANCH_KEY,
  ): Promise<void> {
    this.currentBranch = currentBranch
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, REVIEW_STATE_FILE)
    try {
      const data = await vscode.workspace.fs.readFile(uri)
      this.state = deserializeState(new TextDecoder().decode(data), currentBranch)
      const branchCount = Object.keys(this.state.branches).length
      const scope = this.state.branches[currentBranch]
      const fileCount = scope ? Object.keys(scope.files).length : 0
      logInfo(
        `State loaded: branch "${currentBranch}" with ${fileCount} tracked file(s); ${branchCount} branch scope(s) total`,
      )
    } catch {
      this.state = createDefaultState()
      logInfo('No existing state file found, starting fresh')
    }
    this.pruneExpiredBranches()
    this.touchCurrentScope()
    this.scheduleSave()
    this._onDidChange.fire()
  }

  /**
   * Switch the active branch. Stale branch scopes are pruned; the new scope
   * (created if missing) gets its `lastAccessedAt` updated.
   */
  setCurrentBranch(branch: string): void {
    if (branch === this.currentBranch) return

    const previous = this.currentBranch
    this.currentBranch = branch
    this.pruneExpiredBranches()
    this.touchCurrentScope()
    this.undoStack = []
    this.redoStack = []
    const scope = this.state.branches[branch]
    const fileCount = scope ? Object.keys(scope.files).length : 0
    logInfo(
      `Branch switched: "${previous}" → "${branch}" (${fileCount} tracked file(s))`,
    )
    this.fireDidChange()
  }

  getCurrentBranch(): string {
    return this.currentBranch
  }

  private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0]
  }

  private scheduleSave(): void {
    if (this.saveTimeout !== undefined) {
      clearTimeout(this.saveTimeout)
    }
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = undefined
      this.saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private async saveNow(): Promise<void> {
    const folder = this.getWorkspaceFolder()
    if (!folder) return

    const uri = vscode.Uri.joinPath(folder.uri, REVIEW_STATE_FILE)
    const data = new TextEncoder().encode(serializeState(this.state))
    this.isSaving = true
    try {
      await vscode.workspace.fs.writeFile(uri, data)
      logDebug('State saved to disk')
    } catch (err) {
      logError(`Failed to save state: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      // Small delay so the file watcher event can be ignored
      setTimeout(() => {
        this.isSaving = false
      }, 100)
    }
  }

  async reloadFromDisk(): Promise<void> {
    if (this.isSaving) {
      logDebug('Skipping reload (save in progress)')
      return
    }

    const folder = this.getWorkspaceFolder()
    if (!folder) return

    logInfo('Reloading state from disk (external change detected)')
    await this.load(folder, this.currentBranch)
  }

  getState(): ReviewState {
    return this.state
  }

  /** Files for the active branch only. */
  getActiveFiles(): Record<string, FileReviewState> {
    return this.getCurrentScope().files
  }

  getFileState(relativePath: string): FileReviewState | undefined {
    return this.getCurrentScope().files[relativePath]
  }

  getTrackedFiles(): string[] {
    return Object.keys(this.getCurrentScope().files)
  }

  saveUndoSnapshot(affectedPaths: string[]): void {
    this.pruneExpiredEntries()
    const files = this.getCurrentScope().files
    const entry: UndoEntry = {
      branch: this.currentBranch,
      files: new Map(),
      timestamp: Date.now(),
    }
    for (const path of affectedPaths) {
      const current = files[path]
      entry.files.set(path, current ? structuredClone(current) : null)
    }
    this.undoStack.push(entry)
    if (this.undoStack.length > MAX_UNDO_STACK) {
      this.undoStack.shift()
    }
    this.redoStack = []
  }

  undo(): boolean {
    this.pruneExpiredEntries()
    const entry = this.undoStack.pop()
    if (!entry) return false
    if (entry.branch !== this.currentBranch) {
      logDebug('Undo skipped: entry belongs to a different branch')
      return false
    }

    const files = this.getCurrentScope().files
    const redoEntry: UndoEntry = {
      branch: this.currentBranch,
      files: new Map(),
      timestamp: Date.now(),
    }
    for (const [path, previousState] of entry.files) {
      const currentState = files[path]
      redoEntry.files.set(path, currentState ? structuredClone(currentState) : null)

      if (previousState === null) {
        delete files[path]
      } else {
        files[path] = previousState
      }
    }

    this.redoStack.push(redoEntry)
    logInfo('Undo review state change')
    this.fireDidChange()
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    if (entry.branch !== this.currentBranch) {
      logDebug('Redo skipped: entry belongs to a different branch')
      return false
    }

    const files = this.getCurrentScope().files
    const undoEntry: UndoEntry = {
      branch: this.currentBranch,
      files: new Map(),
      timestamp: Date.now(),
    }
    for (const [path, nextState] of entry.files) {
      const currentState = files[path]
      undoEntry.files.set(path, currentState ? structuredClone(currentState) : null)

      if (nextState === null) {
        delete files[path]
      } else {
        files[path] = nextState
      }
    }

    this.undoStack.push(undoEntry)
    logInfo('Redo review state change')
    this.fireDidChange()
    return true
  }

  addFile(relativePath: string, totalLines: number): void {
    const files = this.getCurrentScope().files
    if (files[relativePath]) {
      logDebug(`File already tracked: ${relativePath}`)
      return
    }

    files[relativePath] = createEmptyFileState(relativePath, totalLines)
    logInfo(`File added: ${relativePath} (${totalLines} lines)`)
    this.fireDidChange()
  }

  removeFile(relativePath: string): void {
    const files = this.getCurrentScope().files
    if (!files[relativePath]) return

    delete files[relativePath]
    logInfo(`File removed: ${relativePath}`)
    this.fireDidChange()
  }

  renameFile(oldPath: string, newPath: string): void {
    const files = this.getCurrentScope().files
    const fileState = files[oldPath]
    if (!fileState) return

    delete files[oldPath]
    files[newPath] = {
      ...fileState,
      relativePath: newPath,
    }
    logInfo(`File renamed: ${oldPath} → ${newPath}`)
    this.fireDidChange()
  }

  markSelectionReviewed(
    relativePath: string,
    startLine: number,
    endLine: number,
    documentLines: string[],
  ): void {
    const files = this.getCurrentScope().files
    const fileState = files[relativePath]
      ?? createEmptyFileState(relativePath, documentLines.length)

    const updated = markLinesReviewed(
      fileState,
      startLine,
      endLine,
      documentLines,
    )

    if (updated.deletionAdjacentLines && updated.deletionAdjacentLines.length > 0) {
      updated.deletionAdjacentLines = updated.deletionAdjacentLines.filter(
        (line) => line < startLine || line > endLine,
      )
      if (updated.deletionAdjacentLines.length === 0) {
        updated.deletionAdjacentLines = undefined
      }
    }

    files[relativePath] = this.syncSnapshots(
      fileState,
      this.hydrateDocumentIdentity(updated, documentLines),
      { manualMutation: true },
    )
    logInfo(`Marked reviewed: ${relativePath} lines ${startLine}-${endLine}`)
    this.fireDidChange()
  }

  markSelectionUnreviewed(
    relativePath: string,
    startLine: number,
    endLine: number,
    documentLines?: string[],
  ): void {
    const files = this.getCurrentScope().files
    const fileState = files[relativePath]
    if (!fileState) return

    const updated = removeReviewedLines(
      fileState,
      startLine,
      endLine,
    )

    files[relativePath] = this.syncSnapshots(
      fileState,
      this.hydrateDocumentIdentity(updated, documentLines),
      { manualMutation: true },
    )
    logInfo(`Marked unreviewed: ${relativePath} lines ${startLine}-${endLine}`)
    this.fireDidChange()
  }

  markDeletionAdjacentLines(
    relativePath: string,
    lines: number[],
    documentLines: string[],
  ): void {
    const files = this.getCurrentScope().files
    const fileState = files[relativePath]
    if (!fileState) return

    const validLines = lines.filter(
      (line) => line >= 1 && line <= documentLines.length,
    )
    if (validLines.length === 0) return

    let updated: FileReviewState = fileState
    for (const line of validLines) {
      updated = removeReviewedLines(updated, line, line)
    }

    const existing = fileState.deletionAdjacentLines ?? []
    const merged = Array.from(new Set([...existing, ...validLines])).sort(
      (a, b) => a - b,
    )

    updated = { ...updated, deletionAdjacentLines: merged }

    files[relativePath] = this.syncSnapshots(
      fileState,
      this.hydrateDocumentIdentity(updated, documentLines),
      { manualMutation: true },
    )
    logInfo(
      `Marked deletion-adjacent: ${relativePath} lines ${validLines.join(',')}`,
    )
    this.fireDidChange()
  }

  markFileReviewed(relativePath: string, documentLines: string[]): void {
    const files = this.getCurrentScope().files
    const fileState = files[relativePath]
      ?? createEmptyFileState(relativePath, documentLines.length)

    const lineHashes: Record<number, string> = {}
    for (let i = 0; i < documentLines.length; i++) {
      const content = documentLines[i]
      if (content !== undefined) {
        lineHashes[i + 1] = hashLine(content)
      }
    }

    files[relativePath] = this.syncSnapshots(
      fileState,
      this.hydrateDocumentIdentity(
        {
          ...fileState,
          totalLines: documentLines.length,
          reviewedRanges: normalizeRanges([
            {
              startLine: 1,
              endLine: documentLines.length,
              lineHashes,
            },
          ]),
          deletionAdjacentLines: undefined,
        },
        documentLines,
      ),
      { manualMutation: true },
    )
    logInfo(`Marked entire file reviewed: ${relativePath} (${documentLines.length} lines)`)
    this.fireDidChange()
  }

  clearFileReview(relativePath: string, documentLines?: string[]): void {
    const files = this.getCurrentScope().files
    const fileState = files[relativePath]
    if (!fileState) return

    files[relativePath] = this.syncSnapshots(
      fileState,
      this.hydrateDocumentIdentity(
        {
          ...fileState,
          reviewedRanges: [],
          deletionAdjacentLines: undefined,
        },
        documentLines,
      ),
      { manualMutation: true },
    )
    logInfo(`Cleared review: ${relativePath}`)
    this.fireDidChange()
  }

  /** Clear all reviews on the active branch. Other branches are untouched. */
  clearAll(): void {
    const scope = this.getCurrentScope()
    scope.files = {}
    scope.lastAccessedAt = Date.now()
    logInfo(`Cleared review state for branch "${this.currentBranch}"`)
    this.fireDidChange()
  }

  handleDocumentChange(
    relativePath: string,
    changes: ReadonlyArray<{
      range: {
        start: { line: number; character?: number }
        end: { line: number; character?: number }
      }
      text: string
    }>,
    totalLines: number,
    documentLines: string[],
  ): void {
    const files = this.getCurrentScope().files
    const fileState = files[relativePath]
    if (!fileState || !this.hasVersionedState(fileState)) return

    logDebug(`Document change: ${relativePath} (${changes.length} change(s), totalLines=${totalLines})`)

    const resolved = this.resolveDocumentState(
      relativePath,
      fileState,
      documentLines,
    )
    if (this.sameFileState(fileState, resolved)) return

    files[relativePath] = resolved
    this.fireDidChange()
  }

  async recheckAllFiles(): Promise<void> {
    const folder = this.getWorkspaceFolder()
    if (!folder) return

    logInfo('Rechecking all tracked files')
    let changed = false
    let checkedCount = 0
    const files = this.getCurrentScope().files
    for (const [relativePath, fileState] of Object.entries(files)) {
      if (!this.hasVersionedState(fileState)) continue

      const uri = vscode.Uri.joinPath(folder.uri, relativePath)
      try {
        const data = await vscode.workspace.fs.readFile(uri)
        const content = new TextDecoder().decode(data)
        const documentLines = content.split('\n')

        const resolved = this.resolveDocumentState(
          relativePath,
          fileState,
          documentLines,
        )

        if (!this.sameFileState(fileState, resolved)) {
          files[relativePath] = resolved
          changed = true
        }
        checkedCount++
      } catch {
        logWarn(`Recheck skipped (file not found): ${relativePath}`)
      }
    }

    logInfo(`Recheck complete: ${checkedCount} file(s) verified`)
    if (changed) {
      this.fireDidChange()
    }
  }

  handleFileOpened(relativePath: string, documentLines: string[]): void {
    const files = this.getCurrentScope().files
    const fileState = files[relativePath]
    if (!fileState || !this.hasVersionedState(fileState)) return

    logDebug(`File opened, reverifying: ${relativePath}`)
    const resolved = this.resolveDocumentState(
      relativePath,
      fileState,
      documentLines,
    )

    if (this.sameFileState(fileState, resolved)) return

    files[relativePath] = resolved
    this.fireDidChange()
  }

  private pruneExpiredEntries(): void {
    const cutoff = Date.now() - UNDO_TTL_MS
    while (this.undoStack[0] && this.undoStack[0].timestamp < cutoff) {
      this.undoStack.shift()
    }
    while (this.redoStack[0] && this.redoStack[0].timestamp < cutoff) {
      this.redoStack.shift()
    }
  }

  private pruneExpiredBranches(): void {
    const cutoff = Date.now() - BRANCH_EXPIRATION_MS
    let pruned = 0
    for (const [branch, scope] of Object.entries(this.state.branches)) {
      if (branch === this.currentBranch) continue
      if (scope.lastAccessedAt < cutoff) {
        delete this.state.branches[branch]
        pruned++
      }
    }
    if (pruned > 0) {
      logInfo(`Pruned ${pruned} expired branch scope(s)`)
    }
  }

  private getCurrentScope(): BranchReviewScope {
    let scope = this.state.branches[this.currentBranch]
    if (!scope) {
      scope = { files: {}, lastAccessedAt: Date.now() }
      this.state.branches[this.currentBranch] = scope
    }
    return scope
  }

  private touchCurrentScope(): void {
    this.getCurrentScope().lastAccessedAt = Date.now()
  }

  private fireDidChange(): void {
    this.touchCurrentScope()
    this._onDidChange.fire()
    this.scheduleSave()
  }

  private hasVersionedState(fileState: FileReviewState): boolean {
    return fileState.reviewedRanges.length > 0
      || (fileState.documentLineHashes?.length ?? 0) > 0
      || (fileState.snapshots?.length ?? 0) > 0
  }

  private createDocumentIdentity(documentLines: string[]): DocumentIdentity {
    const documentLineHashes = hashDocumentLines(documentLines)
    return {
      totalLines: documentLines.length,
      documentLineHashes,
      documentFingerprint: fingerprintDocumentLineHashes(documentLineHashes),
    }
  }

  private ensureDocumentFingerprint(fileState: FileReviewState): FileReviewState {
    const documentFingerprint = fileState.documentLineHashes
      && fileState.documentLineHashes.length > 0
      ? fingerprintDocumentLineHashes(fileState.documentLineHashes)
      : undefined

    return { ...fileState, documentFingerprint }
  }

  private hydrateDocumentIdentity(
    fileState: FileReviewState,
    documentLines?: string[],
  ): FileReviewState {
    if (!documentLines) {
      return this.ensureDocumentFingerprint(fileState)
    }

    return {
      ...fileState,
      ...this.createDocumentIdentity(documentLines),
    }
  }

  private createSnapshot(fileState: FileReviewState): FileReviewSnapshot | undefined {
    if (!fileState.documentLineHashes || fileState.documentLineHashes.length === 0) {
      return undefined
    }

    const fingerprint = fileState.documentFingerprint
      ?? fingerprintDocumentLineHashes(fileState.documentLineHashes)

    return {
      fingerprint,
      totalLines: fileState.totalLines,
      reviewedRanges: fileState.reviewedRanges,
      documentLineHashes: fileState.documentLineHashes,
      deletionAdjacentLines: fileState.deletionAdjacentLines,
    }
  }

  private syncSnapshots(
    previousState: FileReviewState,
    nextState: FileReviewState,
    options: {
      manualMutation?: boolean
      touchSnapshot?: boolean
    } = {},
  ): FileReviewState {
    const normalizedNextState = this.ensureDocumentFingerprint(nextState)
    const snapshot = this.createSnapshot(normalizedNextState)
    const existingSnapshots = previousState.snapshots ?? []
    const shouldStoreSnapshot = options.touchSnapshot
      || options.manualMutation
      || this.hasEffectiveReviewChange(previousState, normalizedNextState)

    if (!snapshot || !shouldStoreSnapshot) {
      return existingSnapshots.length > 0
        ? { ...normalizedNextState, snapshots: existingSnapshots }
        : normalizedNextState
    }

    const snapshots = [
      snapshot,
      ...existingSnapshots.filter((entry) => entry.fingerprint !== snapshot.fingerprint),
    ].slice(0, MAX_SNAPSHOTS_PER_FILE)

    return { ...normalizedNextState, snapshots }
  }

  private resolveDocumentState(
    relativePath: string,
    fileState: FileReviewState,
    documentLines: string[],
  ): FileReviewState {
    const identity = this.createDocumentIdentity(documentLines)
    const snapshot = fileState.snapshots?.find(
      (entry) => entry.fingerprint === identity.documentFingerprint,
    )

    if (snapshot) {
      logDebug(`Restored snapshot: ${relativePath} (${snapshot.fingerprint})`)
      return this.syncSnapshots(
        fileState,
        {
          ...fileState,
          ...identity,
          reviewedRanges: snapshot.reviewedRanges,
          deletionAdjacentLines: snapshot.deletionAdjacentLines,
        },
        { touchSnapshot: true },
      )
    }

    const reverified = fullReverify(
      fileState.reviewedRanges,
      documentLines,
      fileState.documentLineHashes,
    )

    const rangesBefore = fileState.reviewedRanges.length
    const rangesAfter = reverified.length
    if (rangesBefore !== rangesAfter) {
      logInfo(`Reverify ${relativePath}: ranges ${rangesBefore} → ${rangesAfter}`)
    }

    const deletionAdjacentLines = this.resolveDeletionAdjacentLines(
      fileState,
      documentLines,
    )

    return this.syncSnapshots(
      fileState,
      {
        ...fileState,
        ...identity,
        reviewedRanges: this.removeDeletionAdjacentLines(
          fileState,
          reverified,
          deletionAdjacentLines,
        ),
        deletionAdjacentLines,
      },
    )
  }

  private resolveDeletionAdjacentLines(
    fileState: FileReviewState,
    documentLines: string[],
  ): number[] | undefined {
    if (!fileState.documentLineHashes || fileState.documentLineHashes.length === 0) {
      return undefined
    }

    const detected = detectDeletionAdjacentLines(
      fileState.reviewedRanges,
      fileState.documentLineHashes,
      documentLines,
      fileState.deletionAdjacentLines ?? [],
    )

    return detected.length > 0 ? detected : undefined
  }

  private removeDeletionAdjacentLines(
    fileState: FileReviewState,
    reviewedRanges: ReviewedRange[],
    deletionAdjacentLines?: number[],
  ): ReviewedRange[] {
    if (!deletionAdjacentLines || deletionAdjacentLines.length === 0) {
      return reviewedRanges
    }

    let state: FileReviewState = {
      ...fileState,
      reviewedRanges,
    }
    for (const line of deletionAdjacentLines) {
      state = removeReviewedLines(state, line, line)
    }
    return state.reviewedRanges
  }

  private hasEffectiveReviewChange(
    previousState: FileReviewState,
    nextState: FileReviewState,
  ): boolean {
    return previousState.totalLines !== nextState.totalLines
      || !this.sameReviewedRanges(previousState.reviewedRanges, nextState.reviewedRanges)
      || !this.sameNumberArray(
        previousState.deletionAdjacentLines,
        nextState.deletionAdjacentLines,
      )
  }

  private sameFileState(
    left: FileReviewState,
    right: FileReviewState,
  ): boolean {
    return left.totalLines === right.totalLines
      && left.relativePath === right.relativePath
      && left.documentFingerprint === right.documentFingerprint
      && this.sameStringArray(left.documentLineHashes, right.documentLineHashes)
      && this.sameReviewedRanges(left.reviewedRanges, right.reviewedRanges)
      && this.sameNumberArray(left.deletionAdjacentLines, right.deletionAdjacentLines)
      && this.sameSnapshots(left.snapshots, right.snapshots)
  }

  private sameSnapshots(
    left?: FileReviewSnapshot[],
    right?: FileReviewSnapshot[],
  ): boolean {
    if (!left && !right) return true
    if (!left || !right || left.length !== right.length) return false

    for (let i = 0; i < left.length; i++) {
      const leftEntry = left[i]
      const rightEntry = right[i]
      if (!leftEntry || !rightEntry) return false

      if (
        leftEntry.fingerprint !== rightEntry.fingerprint
        || leftEntry.totalLines !== rightEntry.totalLines
        || !this.sameStringArray(
          leftEntry.documentLineHashes,
          rightEntry.documentLineHashes,
        )
        || !this.sameReviewedRanges(
          leftEntry.reviewedRanges,
          rightEntry.reviewedRanges,
        )
        || !this.sameNumberArray(
          leftEntry.deletionAdjacentLines,
          rightEntry.deletionAdjacentLines,
        )
      ) {
        return false
      }
    }

    return true
  }

  private sameReviewedRanges(
    left: ReviewedRange[],
    right: ReviewedRange[],
  ): boolean {
    if (left.length !== right.length) return false

    for (let i = 0; i < left.length; i++) {
      const leftRange = left[i]
      const rightRange = right[i]
      if (!leftRange || !rightRange) return false

      if (
        leftRange.startLine !== rightRange.startLine
        || leftRange.endLine !== rightRange.endLine
        || !this.sameLineHashes(leftRange.lineHashes, rightRange.lineHashes)
      ) {
        return false
      }
    }

    return true
  }

  private sameLineHashes(
    left: Record<number, string>,
    right: Record<number, string>,
  ): boolean {
    const leftEntries = Object.entries(left)
    const rightEntries = Object.entries(right)
    if (leftEntries.length !== rightEntries.length) return false

    for (const [line, hash] of leftEntries) {
      if (right[Number(line)] !== hash) {
        return false
      }
    }

    return true
  }

  private sameNumberArray(left?: number[], right?: number[]): boolean {
    if (!left && !right) return true
    if (!left || !right || left.length !== right.length) return false

    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) {
        return false
      }
    }

    return true
  }

  private sameStringArray(left?: string[], right?: string[]): boolean {
    if (!left && !right) return true
    if (!left || !right || left.length !== right.length) return false

    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) {
        return false
      }
    }

    return true
  }

  dispose(): void {
    if (this.saveTimeout !== undefined) {
      clearTimeout(this.saveTimeout)
      this.saveNow()
    }
    this._onDidChange.dispose()
  }
}
