import * as vscode from 'vscode'
import type { ReviewStateManager } from './review-state-manager'

function getRelativePath(
  uri: vscode.Uri,
  _workspaceFolder: vscode.WorkspaceFolder,
): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
}

function getDocumentLines(document: vscode.TextDocument): string[] {
  const lines: string[] = []
  for (let i = 0; i < document.lineCount; i++) {
    lines.push(document.lineAt(i).text)
  }
  return lines
}

function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0]
}

export function registerCommands(
  context: vscode.ExtensionContext,
  manager: ReviewStateManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'reviewHelper.addFile',
      async (uri?: vscode.Uri) => {
        const folder = getActiveWorkspaceFolder()
        if (!folder) return

        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri
        if (!targetUri) {
          vscode.window.showWarningMessage('No file selected')
          return
        }

        const relativePath = getRelativePath(targetUri, folder)
        const document = await vscode.workspace.openTextDocument(targetUri)
        manager.addFile(relativePath, document.lineCount)

        vscode.window.showInformationMessage(
          `Added "${relativePath}" to review`,
        )
      },
    ),

    vscode.commands.registerCommand(
      'reviewHelper.removeFile',
      (item?: { relativePath?: string }) => {
        const folder = getActiveWorkspaceFolder()
        if (!folder) return

        let relativePath = item?.relativePath
        if (!relativePath) {
          const editor = vscode.window.activeTextEditor
          if (!editor) return
          relativePath = getRelativePath(editor.document.uri, folder)
        }

        manager.removeFile(relativePath)
        vscode.window.showInformationMessage(
          `Removed "${relativePath}" from review`,
        )
      },
    ),

    vscode.commands.registerCommand('reviewHelper.markReviewed', () => {
      const folder = getActiveWorkspaceFolder()
      if (!folder) return

      const editor = vscode.window.activeTextEditor
      if (!editor) return

      const relativePath = getRelativePath(editor.document.uri, folder)
      const selection = editor.selection
      const startLine = selection.start.line + 1 // 0-based to 1-based
      const endLine = selection.end.line + 1
      const documentLines = getDocumentLines(editor.document)

      manager.markSelectionReviewed(
        relativePath,
        startLine,
        endLine,
        documentLines,
      )
    }),

    vscode.commands.registerCommand('reviewHelper.markUnreviewed', () => {
      const folder = getActiveWorkspaceFolder()
      if (!folder) return

      const editor = vscode.window.activeTextEditor
      if (!editor) return

      const relativePath = getRelativePath(editor.document.uri, folder)
      const selection = editor.selection
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1

      if (!manager.getFileState(relativePath)) {
        manager.addFile(relativePath, editor.document.lineCount)
      }

      manager.markSelectionUnreviewed(relativePath, startLine, endLine)
    }),

    vscode.commands.registerCommand(
      'reviewHelper.markFileReviewed',
      async (item?: { relativePath?: string }) => {
        const folder = getActiveWorkspaceFolder()
        if (!folder) return

        let relativePath = item?.relativePath
        let documentLines: string[]

        if (relativePath) {
          const uri = vscode.Uri.joinPath(folder.uri, relativePath)
          const document = await vscode.workspace.openTextDocument(uri)
          documentLines = getDocumentLines(document)
        } else {
          const editor = vscode.window.activeTextEditor
          if (!editor) return
          relativePath = getRelativePath(editor.document.uri, folder)
          documentLines = getDocumentLines(editor.document)
        }

        manager.markFileReviewed(relativePath, documentLines)
      },
    ),

    vscode.commands.registerCommand(
      'reviewHelper.clearFileReview',
      (item?: { relativePath?: string }) => {
        const folder = getActiveWorkspaceFolder()
        if (!folder) return

        let relativePath = item?.relativePath
        if (!relativePath) {
          const editor = vscode.window.activeTextEditor
          if (!editor) return
          relativePath = getRelativePath(editor.document.uri, folder)
        }

        manager.clearFileReview(relativePath)
      },
    ),

    vscode.commands.registerCommand('reviewHelper.clearAllReviews', () => {
      manager.clearAll()
      vscode.window.showInformationMessage('Cleared all review state')
    }),
  )
}
