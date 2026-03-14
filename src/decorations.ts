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

interface ColorWithAlpha {
  hex: string
  alpha: number
}

interface DecorationColors {
  gutterDot: ColorWithAlpha
  background: ColorWithAlpha
  overviewRuler: ColorWithAlpha
}

function hexToRgba(color: ColorWithAlpha): string {
  const hex = color.hex.replace('#', '')
  const r = parseInt(hex.substring(0, 2), 16)
  const g = parseInt(hex.substring(2, 4), 16)
  const b = parseInt(hex.substring(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${color.alpha})`
}

function getDecorationColors(): DecorationColors {
  const config = vscode.workspace.getConfiguration('reviewHelper')
  return {
    gutterDot: {
      hex: config.get<string>('colors.gutterDotHex', '#00BCD4'),
      alpha: config.get<number>('colors.gutterDotAlpha', 0.85),
    },
    background: {
      hex: config.get<string>('colors.backgroundHex', '#00BCD4'),
      alpha: config.get<number>('colors.backgroundAlpha', 0.06),
    },
    overviewRuler: {
      hex: config.get<string>('colors.overviewRulerHex', '#00BCD4'),
      alpha: config.get<number>('colors.overviewRulerAlpha', 0.4),
    },
  }
}

function buildGutterDotSvg(color: ColorWithAlpha): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">',
    `  <circle cx="8" cy="8" r="4" fill="${color.hex}" fill-opacity="${color.alpha}"/>`,
    '</svg>',
  ].join('\n')
}

let previousSvgUri: vscode.Uri | undefined

async function writeGutterDotSvg(
  context: vscode.ExtensionContext,
  color: ColorWithAlpha,
): Promise<vscode.Uri> {
  const dir = context.globalStorageUri
  await vscode.workspace.fs.createDirectory(dir)
  // Use a unique filename each time to bust VSCode's icon cache
  const filename = `gutter-dot-${Date.now()}.svg`
  const svgUri = vscode.Uri.joinPath(dir, filename)
  const content = new TextEncoder().encode(buildGutterDotSvg(color))
  await vscode.workspace.fs.writeFile(svgUri, content)

  if (previousSvgUri) {
    vscode.workspace.fs.delete(previousSvgUri).then(undefined, () => {})
  }
  previousSvgUri = svgUri

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
    backgroundColor: hexToRgba(colors.background),
    isWholeLine: true,
    overviewRulerColor: hexToRgba(colors.overviewRuler),
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

  const unreviewed = getUnreviewedRanges(
    { ...fileState, totalLines: editor.document.lineCount },
    fileState.reviewedRanges,
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
