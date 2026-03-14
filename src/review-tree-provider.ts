import * as vscode from 'vscode'
import type { ReviewStateManager } from './review-state-manager'
import { computeFileProgress } from './review-state'

export class ReviewTreeItem extends vscode.TreeItem {
  readonly relativePath: string

  constructor(
    relativePath: string,
    progress: number,
    fileExists: boolean,
  ) {
    const percentage = Math.floor(progress * 100)
    const fileName = relativePath.split('/').pop() ?? relativePath
    const label = fileExists
      ? `${fileName} (${String(percentage)}%)`
      : `${fileName} (missing)`

    super(label, vscode.TreeItemCollapsibleState.None)

    this.relativePath = relativePath
    this.description = relativePath.includes('/')
      ? relativePath.slice(0, relativePath.lastIndexOf('/'))
      : ''

    if (fileExists) {
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
    } else {
      this.tooltip = `${relativePath} - file not found on disk`
      this.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('list.warningForeground'),
      )
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
  private readonly onDidChangeSubscription: vscode.Disposable
  private refreshTimeout: ReturnType<typeof setTimeout> | undefined

  private static readonly REFRESH_DEBOUNCE_MS = 300

  constructor(private readonly manager: ReviewStateManager) {
    this.onDidChangeSubscription = manager.onDidChange(() => {
      if (this.refreshTimeout !== undefined) {
        clearTimeout(this.refreshTimeout)
      }
      this.refreshTimeout = setTimeout(() => {
        this.refreshTimeout = undefined
        this._onDidChangeTreeData.fire()
      }, ReviewTreeProvider.REFRESH_DEBOUNCE_MS)
    })
  }

  getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
    return element
  }

  async getChildren(): Promise<ReviewTreeItem[]> {
    const state = this.manager.getState()
    const folder = vscode.workspace.workspaceFolders?.[0]
    const items: ReviewTreeItem[] = []

    for (const [relativePath, fileState] of Object.entries(state.files)) {
      const progress = computeFileProgress(fileState)
      let fileExists = true
      if (folder) {
        const uri = vscode.Uri.joinPath(folder.uri, relativePath)
        try {
          await vscode.workspace.fs.stat(uri)
        } catch {
          fileExists = false
        }
      }
      items.push(new ReviewTreeItem(relativePath, progress, fileExists))
    }

    return items.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }

  dispose(): void {
    if (this.refreshTimeout !== undefined) {
      clearTimeout(this.refreshTimeout)
    }
    this.onDidChangeSubscription.dispose()
    this._onDidChangeTreeData.dispose()
  }
}
