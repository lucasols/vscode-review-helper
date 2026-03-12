import * as vscode from 'vscode'
import type { ReviewStateManager } from './review-state-manager'
import { getUnreviewedRanges } from './review-state'

function getRelativePath(editor: vscode.TextEditor): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return undefined
  return vscode.workspace
    .asRelativePath(editor.document.uri, false)
    .replace(/\\/g, '/')
}

export function createDecorationTypes(
  context: vscode.ExtensionContext,
): {
  bgDecoration: vscode.TextEditorDecorationType
  gutterDecoration: vscode.TextEditorDecorationType
} {
  const bgDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 165, 0, 0.06)',
    isWholeLine: true,
    overviewRulerColor: 'rgba(255, 165, 0, 0.4)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })

  const gutterDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(
      context.extensionUri,
      'dist',
      'gutter-dot.svg',
    ).fsPath,
    gutterIconSize: '60%',
  })

  context.subscriptions.push(bgDecoration, gutterDecoration)

  return { bgDecoration, gutterDecoration }
}

export function createGutterDotSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">',
    '  <circle cx="8" cy="8" r="4" fill="rgba(255, 165, 0, 0.7)"/>',
    '</svg>',
  ].join('\n')
}

export function updateDecorations(
  editor: vscode.TextEditor,
  manager: ReviewStateManager,
  bgDecoration: vscode.TextEditorDecorationType,
  gutterDecoration: vscode.TextEditorDecorationType,
): void {
  const relativePath = getRelativePath(editor)
  if (!relativePath) {
    editor.setDecorations(bgDecoration, [])
    editor.setDecorations(gutterDecoration, [])
    return
  }

  const fileState = manager.getFileState(relativePath)
  if (!fileState) {
    editor.setDecorations(bgDecoration, [])
    editor.setDecorations(gutterDecoration, [])
    return
  }

  const unreviewed = getUnreviewedRanges(fileState)
  const decorationRanges = unreviewed.map(
    (range) =>
      new vscode.Range(
        new vscode.Position(range.startLine - 1, 0),
        new vscode.Position(range.endLine - 1, Number.MAX_SAFE_INTEGER),
      ),
  )

  editor.setDecorations(bgDecoration, decorationRanges)
  editor.setDecorations(gutterDecoration, decorationRanges)
}

export function clearDecorations(
  editor: vscode.TextEditor,
  bgDecoration: vscode.TextEditorDecorationType,
  gutterDecoration: vscode.TextEditorDecorationType,
): void {
  editor.setDecorations(bgDecoration, [])
  editor.setDecorations(gutterDecoration, [])
}
