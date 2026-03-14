import * as vscode from 'vscode'
import type { FileReviewState, ReviewState } from './types'
import {
  markLinesReviewed,
  removeReviewedLines,
  createEmptyFileState,
  normalizeRanges,
  hashLine,
  hashDocumentLines,
} from './review-state'
import { fullReverify } from './change-tracker'
import {
  createDefaultState,
  deserializeState,
  serializeState,
} from './state-persistence'
import { logInfo, logError, logDebug, logWarn } from './logger'

const REVIEW_STATE_FILE = '.vscode/review-state.json'
const SAVE_DEBOUNCE_MS = 500

export class ReviewStateManager {
  private state: ReviewState = createDefaultState()
  private saveTimeout: ReturnType<typeof setTimeout> | undefined
  private isSaving = false
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  async load(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, REVIEW_STATE_FILE)
    try {
      const data = await vscode.workspace.fs.readFile(uri)
      this.state = deserializeState(new TextDecoder().decode(data))
      const fileCount = Object.keys(this.state.files).length
      logInfo(`State loaded: ${fileCount} tracked file(s) from ${REVIEW_STATE_FILE}`)
    } catch {
      this.state = createDefaultState()
      logInfo('No existing state file found, starting fresh')
    }
    this._onDidChange.fire()
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
    await this.load(folder)
  }

  getState(): ReviewState {
    return this.state
  }

  getFileState(relativePath: string): FileReviewState | undefined {
    return this.state.files[relativePath]
  }

  getTrackedFiles(): string[] {
    return Object.keys(this.state.files)
  }

  addFile(relativePath: string, totalLines: number): void {
    if (this.state.files[relativePath]) {
      logDebug(`File already tracked: ${relativePath}`)
      return
    }

    this.state.files[relativePath] = createEmptyFileState(
      relativePath,
      totalLines,
    )
    logInfo(`File added: ${relativePath} (${totalLines} lines)`)
    this._onDidChange.fire()
    this.scheduleSave()
  }

  removeFile(relativePath: string): void {
    if (!this.state.files[relativePath]) return

    delete this.state.files[relativePath]
    logInfo(`File removed: ${relativePath}`)
    this._onDidChange.fire()
    this.scheduleSave()
  }

  renameFile(oldPath: string, newPath: string): void {
    const fileState = this.state.files[oldPath]
    if (!fileState) return

    delete this.state.files[oldPath]
    this.state.files[newPath] = {
      ...fileState,
      relativePath: newPath,
    }
    logInfo(`File renamed: ${oldPath} → ${newPath}`)
    this._onDidChange.fire()
    this.scheduleSave()
  }

  markSelectionReviewed(
    relativePath: string,
    startLine: number,
    endLine: number,
    documentLines: string[],
  ): void {
    let fileState = this.state.files[relativePath]
    if (!fileState) {
      fileState = createEmptyFileState(relativePath, documentLines.length)
      this.state.files[relativePath] = fileState
    }

    this.state.files[relativePath] = markLinesReviewed(
      fileState,
      startLine,
      endLine,
      documentLines,
    )
    logInfo(`Marked reviewed: ${relativePath} lines ${startLine}-${endLine}`)
    this._onDidChange.fire()
    this.scheduleSave()
  }

  markSelectionUnreviewed(
    relativePath: string,
    startLine: number,
    endLine: number,
  ): void {
    const fileState = this.state.files[relativePath]
    if (!fileState) return

    this.state.files[relativePath] = removeReviewedLines(
      fileState,
      startLine,
      endLine,
    )
    logInfo(`Marked unreviewed: ${relativePath} lines ${startLine}-${endLine}`)
    this._onDidChange.fire()
    this.scheduleSave()
  }

  markFileReviewed(relativePath: string, documentLines: string[]): void {
    let fileState = this.state.files[relativePath]
    if (!fileState) {
      fileState = createEmptyFileState(relativePath, documentLines.length)
    }

    const lineHashes: Record<number, string> = {}
    for (let i = 0; i < documentLines.length; i++) {
      const content = documentLines[i]
      if (content !== undefined) {
        lineHashes[i + 1] = hashLine(content)
      }
    }

    this.state.files[relativePath] = {
      ...fileState,
      totalLines: documentLines.length,
      reviewedRanges: normalizeRanges([
        {
          startLine: 1,
          endLine: documentLines.length,
          lineHashes,
        },
      ]),
      documentLineHashes: hashDocumentLines(documentLines),
    }
    logInfo(`Marked entire file reviewed: ${relativePath} (${documentLines.length} lines)`)
    this._onDidChange.fire()
    this.scheduleSave()
  }

  clearFileReview(relativePath: string): void {
    const fileState = this.state.files[relativePath]
    if (!fileState) return

    this.state.files[relativePath] = {
      ...fileState,
      reviewedRanges: [],
    }
    logInfo(`Cleared review: ${relativePath}`)
    this._onDidChange.fire()
    this.scheduleSave()
  }

  clearAll(): void {
    this.state = createDefaultState()
    logInfo('Cleared all review state')
    this._onDidChange.fire()
    this.scheduleSave()
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
    const fileState = this.state.files[relativePath]
    if (!fileState) return
    if (fileState.reviewedRanges.length === 0) return

    logDebug(`Document change: ${relativePath} (${changes.length} change(s), totalLines=${totalLines})`)

    const reverified = fullReverify(
      fileState.reviewedRanges,
      documentLines,
      fileState.documentLineHashes,
    )

    this.state.files[relativePath] = {
      ...fileState,
      totalLines,
      reviewedRanges: reverified,
      documentLineHashes: hashDocumentLines(documentLines),
    }
    this._onDidChange.fire()
    this.scheduleSave()
  }

  async recheckAllFiles(): Promise<void> {
    const folder = this.getWorkspaceFolder()
    if (!folder) return

    logInfo('Rechecking all tracked files')
    let changed = false
    let checkedCount = 0
    for (const [relativePath, fileState] of Object.entries(this.state.files)) {
      if (fileState.reviewedRanges.length === 0) continue

      const uri = vscode.Uri.joinPath(folder.uri, relativePath)
      try {
        const data = await vscode.workspace.fs.readFile(uri)
        const content = new TextDecoder().decode(data)
        const documentLines = content.split('\n')

        const reverified = fullReverify(
          fileState.reviewedRanges,
          documentLines,
          fileState.documentLineHashes,
        )

        const rangesBefore = fileState.reviewedRanges.length
        const rangesAfter = reverified.length
        if (rangesBefore !== rangesAfter) {
          logDebug(`Recheck ${relativePath}: ranges ${rangesBefore} → ${rangesAfter}`)
        }

        this.state.files[relativePath] = {
          ...fileState,
          totalLines: documentLines.length,
          reviewedRanges: reverified,
          documentLineHashes: hashDocumentLines(documentLines),
        }
        changed = true
        checkedCount++
      } catch {
        logWarn(`Recheck skipped (file not found): ${relativePath}`)
      }
    }

    logInfo(`Recheck complete: ${checkedCount} file(s) verified`)
    if (changed) {
      this._onDidChange.fire()
      this.scheduleSave()
    }
  }

  handleFileOpened(relativePath: string, documentLines: string[]): void {
    const fileState = this.state.files[relativePath]
    if (!fileState) return
    if (fileState.reviewedRanges.length === 0) return

    logDebug(`File opened, reverifying: ${relativePath}`)
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

    this.state.files[relativePath] = {
      ...fileState,
      totalLines: documentLines.length,
      reviewedRanges: reverified,
      documentLineHashes: hashDocumentLines(documentLines),
    }
    this._onDidChange.fire()
    this.scheduleSave()
  }

  dispose(): void {
    if (this.saveTimeout !== undefined) {
      clearTimeout(this.saveTimeout)
      this.saveNow()
    }
    this._onDidChange.dispose()
  }
}
