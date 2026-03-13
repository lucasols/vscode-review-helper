import * as vscode from 'vscode'
import type { ReviewStateManager } from './review-state-manager'
import { computeFileProgress } from './review-state'

export class ReviewFileDecorationProvider
  implements vscode.FileDecorationProvider
{
  private readonly _onDidChangeFileDecorations =
    new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event
  private readonly onDidChangeSubscription: vscode.Disposable

  constructor(private readonly manager: ReviewStateManager) {
    this.onDidChangeSubscription = manager.onDidChange(() => {
      this._onDidChangeFileDecorations.fire(undefined)
    })
  }

  provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.FileDecoration | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return undefined

    const relativePath = vscode.workspace
      .asRelativePath(uri, false)
      .replace(/\\/g, '/')
    const fileState = this.manager.getFileState(relativePath)
    if (!fileState) return undefined

    const progress = computeFileProgress(fileState)
    const percentage = Math.round(progress * 100)

    if (progress >= 1) {
      return new vscode.FileDecoration(
        '\u2713',
        `Reviewed (${String(percentage)}%)`,
        new vscode.ThemeColor('testing.iconPassed'),
      )
    }

    return new vscode.FileDecoration(
      `${String(percentage)}%`,
      `Review progress: ${String(percentage)}%`,
      new vscode.ThemeColor('testing.iconQueued'),
    )
  }

  dispose(): void {
    this.onDidChangeSubscription.dispose()
    this._onDidChangeFileDecorations.dispose()
  }
}
