import * as vscode from 'vscode'
import type { ReviewStateManager } from './review-state-manager'
import { computeFileProgress } from './review-state'

export class ReviewTreeItem extends vscode.TreeItem {
  readonly relativePath: string

  constructor(relativePath: string, progress: number) {
    const percentage = Math.round(progress * 100)
    const fileName = relativePath.split('/').pop() ?? relativePath
    const label = `${fileName} (${String(percentage)}%)`

    super(label, vscode.TreeItemCollapsibleState.None)

    this.relativePath = relativePath
    this.description = relativePath.includes('/')
      ? relativePath.slice(0, relativePath.lastIndexOf('/'))
      : ''
    this.tooltip = `${relativePath} - ${String(percentage)}% reviewed`
    this.iconPath =
      progress >= 1
        ? new vscode.ThemeIcon(
            'pass-filled',
            new vscode.ThemeColor('testing.iconPassed'),
          )
        : new vscode.ThemeIcon(
            'circle-large-outline',
            new vscode.ThemeColor('testing.iconQueued'),
          )

    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [
        vscode.Uri.joinPath(
          vscode.workspace.workspaceFolders?.[0]?.uri ??
            vscode.Uri.file('/'),
          relativePath,
        ),
      ],
    }

    this.contextValue = 'reviewFile'
  }
}

export class ReviewTreeProvider
  implements vscode.TreeDataProvider<ReviewTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<ReviewTreeItem | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly manager: ReviewStateManager) {
    manager.onDidChange(() => {
      this._onDidChangeTreeData.fire()
    })
  }

  getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): ReviewTreeItem[] {
    const state = this.manager.getState()
    const items: ReviewTreeItem[] = []

    for (const [relativePath, fileState] of Object.entries(state.files)) {
      const progress = computeFileProgress(fileState)
      items.push(new ReviewTreeItem(relativePath, progress))
    }

    return items.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose()
  }
}
