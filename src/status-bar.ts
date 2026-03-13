import * as vscode from 'vscode'
import type { ReviewStateManager } from './review-state-manager'
import { computeFileProgress, computeTotalProgress } from './review-state'
import { verifyRanges } from './change-tracker'

export class ReviewStatusBar {
  private readonly statusBarItem: vscode.StatusBarItem
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly manager: ReviewStateManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    )
    this.statusBarItem.command = 'reviewHelper.files.focus'

    this.disposables.push(
      manager.onDidChange(() => {
        this.update()
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.update()
      }),
    )

    this.update()
  }

  private update(): void {
    const editor = vscode.window.activeTextEditor
    const state = this.manager.getState()
    const fileCount = Object.keys(state.files).length

    if (fileCount === 0) {
      this.statusBarItem.hide()
      return
    }

    if (editor) {
      const folder = vscode.workspace.workspaceFolders?.[0]
      if (folder) {
        const relativePath = vscode.workspace
          .asRelativePath(editor.document.uri, false)
          .replace(/\\/g, '/')
        const fileState = this.manager.getFileState(relativePath)

        if (fileState) {
          const documentLines: string[] = []
          for (let i = 0; i < editor.document.lineCount; i++) {
            documentLines.push(editor.document.lineAt(i).text)
          }
          const verified = verifyRanges(
            fileState.reviewedRanges,
            documentLines,
          )
          const progress = Math.round(
            computeFileProgress(fileState, verified, documentLines) * 100,
          )
          const total = Math.round(
            computeTotalProgress(state.files) * 100,
          )
          this.statusBarItem.text = `$(checklist) Review: ${String(progress)}% | Total: ${String(total)}%`
          this.statusBarItem.tooltip = `${relativePath}: ${String(progress)}% reviewed\nTotal: ${String(total)}% across ${String(fileCount)} files`
          this.statusBarItem.show()
          return
        }
      }
    }

    const total = Math.round(computeTotalProgress(state.files) * 100)
    this.statusBarItem.text = `$(checklist) Review: ${String(total)}%`
    this.statusBarItem.tooltip = `Total: ${String(total)}% across ${String(fileCount)} files`
    this.statusBarItem.show()
  }

  dispose(): void {
    this.statusBarItem.dispose()
    for (const d of this.disposables) {
      d.dispose()
    }
  }
}
