import * as vscode from 'vscode'
import { ReviewStateManager } from './review-state-manager'
import { registerCommands } from './commands'
import { createDecorationTypes, updateDecorations } from './decorations'
import { ReviewTreeProvider } from './review-tree-provider'
import { ReviewFileDecorationProvider } from './file-decoration-provider'
import { ReviewStatusBar } from './status-bar'

export function activate(context: vscode.ExtensionContext): void {
  const manager = new ReviewStateManager()

  // Load persisted state (non-blocking - UI updates via onDidChange when ready)
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder) {
    void manager.load(folder)
  }

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

  // Update the when-clause context for the active file
  function updateActiveFileContext(): void {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      vscode.commands.executeCommand(
        'setContext',
        'reviewHelper.activeFileTracked',
        false,
      )
      return
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0]
    if (!wsFolder) return
    const relativePath = vscode.workspace
      .asRelativePath(editor.document.uri, false)
      .replace(/\\/g, '/')
    const isTracked = !!manager.getFileState(relativePath)
    vscode.commands.executeCommand(
      'setContext',
      'reviewHelper.activeFileTracked',
      isTracked,
    )
  }

  // Listen for state changes
  context.subscriptions.push(
    manager.onDidChange(() => {
      updateAllEditors()
      updateActiveFileContext()
    }),
  )

  // Listen for active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateActiveFileContext()
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
        manager.handleDocumentChange(
          relativePath,
          event.contentChanges,
          event.document.lineCount,
        )
      }
    }),
  )

  // Track file renames/moves
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((event) => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0]
      if (!wsFolder) return

      for (const { oldUri, newUri } of event.files) {
        const oldPath = vscode.workspace
          .asRelativePath(oldUri, false)
          .replace(/\\/g, '/')
        const newPath = vscode.workspace
          .asRelativePath(newUri, false)
          .replace(/\\/g, '/')
        manager.renameFile(oldPath, newPath)
      }
    }),
  )

  // Initial updates
  updateAllEditors()
  updateActiveFileContext()

  // Disposables
  context.subscriptions.push(manager)
  context.subscriptions.push(treeProvider)
  context.subscriptions.push(fileDecorationProvider)
}

export function deactivate(): void {}
