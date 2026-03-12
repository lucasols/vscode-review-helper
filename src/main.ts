import * as vscode from 'vscode'
import { ReviewStateManager } from './review-state-manager'
import { registerCommands } from './commands'
import {
  createDecorationTypes,
  createGutterDotSvg,
  updateDecorations,
} from './decorations'
import { ReviewTreeProvider } from './review-tree-provider'
import { ReviewFileDecorationProvider } from './file-decoration-provider'
import { ReviewStatusBar } from './status-bar'

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const manager = new ReviewStateManager()

  // Load persisted state
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder) {
    await manager.load(folder)
  }

  // Write gutter dot SVG to dist
  const gutterDotUri = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'gutter-dot.svg',
  )
  await vscode.workspace.fs.writeFile(
    gutterDotUri,
    new TextEncoder().encode(createGutterDotSvg()),
  )

  // Watch for external changes to review-state.json
  const stateWatcher = vscode.workspace.createFileSystemWatcher(
    '**/.vscode/review-state.json',
  )
  stateWatcher.onDidChange(() => manager.reloadFromDisk())
  stateWatcher.onDidCreate(() => manager.reloadFromDisk())
  stateWatcher.onDidDelete(() => manager.reloadFromDisk())
  context.subscriptions.push(stateWatcher)

  // Create decorations
  const { bgDecoration, gutterDecoration } = createDecorationTypes(context)

  // Register commands
  registerCommands(context, manager)

  // Register tree view
  const treeProvider = new ReviewTreeProvider(manager)
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('reviewHelper.files', treeProvider),
  )

  // Register file decoration provider
  const fileDecorationProvider = new ReviewFileDecorationProvider(manager)
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(fileDecorationProvider),
  )

  // Status bar
  const statusBar = new ReviewStatusBar(manager)
  context.subscriptions.push(statusBar)

  // Update decorations for visible editors
  function updateAllEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      updateDecorations(editor, manager, bgDecoration, gutterDecoration)
    }
  }

  // Listen for state changes
  manager.onDidChange(() => {
    updateAllEditors()
  })

  // Listen for active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return

      // Re-verify on file open
      const wsFolder = vscode.workspace.workspaceFolders?.[0]
      if (wsFolder) {
        const relativePath = vscode.workspace
          .asRelativePath(editor.document.uri, false)
          .replace(/\\/g, '/')
        const lines: string[] = []
        for (let i = 0; i < editor.document.lineCount; i++) {
          lines.push(editor.document.lineAt(i).text)
        }
        manager.handleFileOpened(relativePath, lines)
      }

      updateDecorations(editor, manager, bgDecoration, gutterDecoration)
    }),
  )

  // Listen for document changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0]
      if (!wsFolder) return

      const relativePath = vscode.workspace
        .asRelativePath(event.document.uri, false)
        .replace(/\\/g, '/')

      if (event.contentChanges.length > 0) {
        const lines: string[] = []
        for (let i = 0; i < event.document.lineCount; i++) {
          lines.push(event.document.lineAt(i).text)
        }
        manager.handleDocumentChange(relativePath, event.contentChanges, lines)
      }
    }),
  )

  // Initial decoration update
  updateAllEditors()

  // Disposables
  context.subscriptions.push(manager)
  context.subscriptions.push(treeProvider)
  context.subscriptions.push(fileDecorationProvider)
}

export function deactivate(): void {}
