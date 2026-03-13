import * as vscode from 'vscode'
import type { FileReviewState, ReviewState } from './types'
import {
  markLinesReviewed,
  removeReviewedLines,
  createEmptyFileState,
  normalizeRanges,
  hashLine,
} from './review-state'
import { adjustRangesForChanges, fullReverify } from './change-tracker'
import {
  createDefaultState,
  deserializeState,
  serializeState,
} from './state-persistence'

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
    } catch {
      this.state = createDefaultState()
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
    } finally {
      // Small delay so the file watcher event can be ignored
      setTimeout(() => {
        this.isSaving = false
      }, 100)
    }
  }

  async reloadFromDisk(): Promise<void> {
    if (this.isSaving) return

    const folder = this.getWorkspaceFolder()
    if (!folder) return

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
    if (this.state.files[relativePath]) return

    this.state.files[relativePath] = createEmptyFileState(
      relativePath,
      totalLines,
    )
    this._onDidChange.fire()
    this.scheduleSave()
  }

  removeFile(relativePath: string): void {
    if (!this.state.files[relativePath]) return

    delete this.state.files[relativePath]
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
    }
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
    this._onDidChange.fire()
    this.scheduleSave()
  }

  clearAll(): void {
    this.state = createDefaultState()
    this._onDidChange.fire()
    this.scheduleSave()
  }

  handleDocumentChange(
    relativePath: string,
    changes: ReadonlyArray<{
      range: { start: { line: number }; end: { line: number } }
      text: string
    }>,
    totalLines: number,
  ): void {
    const fileState = this.state.files[relativePath]
    if (!fileState) return
    if (fileState.reviewedRanges.length === 0) return

    const contentChanges = changes.map((change) => {
      const startLine = change.range.start.line + 1 // 0-based to 1-based
      const linesRemoved = change.range.end.line - change.range.start.line + 1
      const linesInserted = change.text.split('\n').length

      return { startLine, linesRemoved, linesInserted }
    })

    const adjusted = adjustRangesForChanges(
      fileState.reviewedRanges,
      contentChanges,
    )

    this.state.files[relativePath] = {
      ...fileState,
      totalLines,
      reviewedRanges: adjusted,
    }
    this._onDidChange.fire()
    this.scheduleSave()
  }

  handleFileOpened(relativePath: string, documentLines: string[]): void {
    const fileState = this.state.files[relativePath]
    if (!fileState) return
    if (fileState.reviewedRanges.length === 0) return

    const reverified = fullReverify(fileState.reviewedRanges, documentLines)

    this.state.files[relativePath] = {
      ...fileState,
      totalLines: documentLines.length,
      reviewedRanges: reverified,
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
