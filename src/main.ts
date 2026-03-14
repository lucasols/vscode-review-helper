import * as vscode from 'vscode'
import { ReviewStateManager } from './review-state-manager'
import { registerCommands } from './commands'
import { createDecorationTypes, updateDecorations } from './decorations'
import { ReviewTreeProvider } from './review-tree-provider'
import { ReviewFileDecorationProvider } from './file-decoration-provider'
import { ReviewStatusBar } from './status-bar'
import { initLogger, logInfo } from './logger'
import {
  findAbsolutePathEntries,
  notifyAbsolutePathEntries,
} from './absolute-path-detector'

export function activate(context: vscode.ExtensionContext): void {
  const channel = initLogger()
  context.subscriptions.push(channel)
  logInfo('Extension activating')

  const manager = new ReviewStateManager()

  // Load persisted state (non-blocking - UI updates via onDidChange when ready)
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder) {
    logInfo(`Loading state from workspace: ${folder.uri.fsPath}`)
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

  // Mutable decoration references (updated on config change)
  let bgDecoration: vscode.TextEditorDecorationType | undefined
  let gutterDecoration: vscode.TextEditorDecorationType | undefined

  function updateAllEditors(): void {
    if (!bgDecoration || !gutterDecoration) return
    for (const editor of vscode.window.visibleTextEditors) {
      updateDecorations(editor, manager, bgDecoration, gutterDecoration)
    }
  }

  async function initDecorations(): Promise<void> {
    bgDecoration?.dispose()
    gutterDecoration?.dispose()

    const decorations = await createDecorationTypes(context)
    bgDecoration = decorations.bgDecoration
    gutterDecoration = decorations.gutterDecoration

    updateAllEditors()
  }

  // Create decorations (async)
  void initDecorations()

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

  // Detect absolute paths in review state
  const notifiedAbsolutePaths = new Set<string>()
  context.subscriptions.push(
    manager.onDidChange(() => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0]
      if (!wsFolder) return
      const entries = findAbsolutePathEntries(
        manager.getState(),
        wsFolder.uri.fsPath,
      )
      if (entries.length > 0) {
        notifyAbsolutePathEntries(entries, manager, notifiedAbsolutePaths)
      }
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

      if (bgDecoration && gutterDecoration) {
        updateDecorations(editor, manager, bgDecoration, gutterDecoration)
      }
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
        const documentLines: string[] = []
        for (let i = 0; i < event.document.lineCount; i++) {
          documentLines.push(event.document.lineAt(i).text)
        }
        manager.handleDocumentChange(
          relativePath,
          event.contentChanges,
          event.document.lineCount,
          documentLines,
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

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('reviewHelper.colors')) {
        void initDecorations()
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

  logInfo('Extension activated')
}

export function deactivate(): void {}
