import * as vscode from 'vscode'
import type { ReviewStateManager } from './review-state-manager'
import { getUnreviewedRanges } from './review-state'
import { verifyRanges } from './change-tracker'

function getRelativePath(editor: vscode.TextEditor): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return undefined
  return vscode.workspace
    .asRelativePath(editor.document.uri, false)
    .replace(/\\/g, '/')
}

interface DecorationColors {
  gutterDot: string
  background: string
  overviewRuler: string
}

function getDecorationColors(): DecorationColors {
  const config = vscode.workspace.getConfiguration('reviewHelper')
  return {
    gutterDot: config.get<string>('colors.gutterDot', 'rgba(0, 188, 212, 0.85)'),
    background: config.get<string>('colors.background', 'rgba(0, 188, 212, 0.06)'),
    overviewRuler: config.get<string>(
      'colors.overviewRuler',
      'rgba(0, 188, 212, 0.4)',
    ),
  }
}

function buildGutterDotSvg(color: string): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">',
    `  <circle cx="8" cy="8" r="4" fill="${color}"/>`,
    '</svg>',
  ].join('\n')
}

async function writeGutterDotSvg(
  context: vscode.ExtensionContext,
  color: string,
): Promise<vscode.Uri> {
  const dir = context.globalStorageUri
  await vscode.workspace.fs.createDirectory(dir)
  const svgUri = vscode.Uri.joinPath(dir, 'gutter-dot.svg')
  const content = new TextEncoder().encode(buildGutterDotSvg(color))
  await vscode.workspace.fs.writeFile(svgUri, content)
  return svgUri
}

export async function createDecorationTypes(
  context: vscode.ExtensionContext,
): Promise<{
  bgDecoration: vscode.TextEditorDecorationType
  gutterDecoration: vscode.TextEditorDecorationType
}> {
  const colors = getDecorationColors()

  const bgDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: colors.background,
    isWholeLine: true,
    overviewRulerColor: colors.overviewRuler,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })

  const svgUri = await writeGutterDotSvg(context, colors.gutterDot)

  const gutterDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: svgUri.fsPath,
    gutterIconSize: '60%',
  })

  return { bgDecoration, gutterDecoration }
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

  const documentLines: string[] = []
  for (let i = 0; i < editor.document.lineCount; i++) {
    documentLines.push(editor.document.lineAt(i).text)
  }

  const verified = verifyRanges(fileState.reviewedRanges, documentLines)
  const unreviewed = getUnreviewedRanges(
    { ...fileState, totalLines: editor.document.lineCount },
    verified,
    documentLines,
  )
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
