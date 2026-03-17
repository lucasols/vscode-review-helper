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
  deletionGutterDot: ColorWithAlpha
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
    deletionGutterDot: {
      hex: config.get<string>('colors.deletionGutterDotHex', '#F44336'),
      alpha: config.get<number>('colors.deletionGutterDotAlpha', 0.85),
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

const previousSvgUris: vscode.Uri[] = []

async function writeGutterDotSvg(
  context: vscode.ExtensionContext,
  color: ColorWithAlpha,
  prefix: string,
): Promise<vscode.Uri> {
  const dir = context.globalStorageUri
  await vscode.workspace.fs.createDirectory(dir)
  // Use a unique filename each time to bust VSCode's icon cache
  const filename = `${prefix}-${Date.now()}.svg`
  const svgUri = vscode.Uri.joinPath(dir, filename)
  const content = new TextEncoder().encode(buildGutterDotSvg(color))
  await vscode.workspace.fs.writeFile(svgUri, content)

  previousSvgUris.push(svgUri)

  return svgUri
}

export async function createDecorationTypes(
  context: vscode.ExtensionContext,
): Promise<{
  bgDecoration: vscode.TextEditorDecorationType
  gutterDecoration: vscode.TextEditorDecorationType
  deletionGutterDecoration: vscode.TextEditorDecorationType
}> {
  const colors = getDecorationColors()

  // Clean up previous SVGs
  for (const uri of previousSvgUris) {
    vscode.workspace.fs.delete(uri).then(undefined, () => {})
  }
  previousSvgUris.length = 0

  const bgDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: hexToRgba(colors.background),
    isWholeLine: true,
    overviewRulerColor: hexToRgba(colors.overviewRuler),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })

  const svgUri = await writeGutterDotSvg(context, colors.gutterDot, 'gutter-dot')

  const gutterDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: svgUri.fsPath,
    gutterIconSize: '60%',
  })

  const deletionSvgUri = await writeGutterDotSvg(context, colors.deletionGutterDot, 'deletion-gutter-dot')

  const deletionGutterDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: deletionSvgUri.fsPath,
    gutterIconSize: '60%',
  })

  return { bgDecoration, gutterDecoration, deletionGutterDecoration }
}

export function updateDecorations(
  editor: vscode.TextEditor,
  manager: ReviewStateManager,
  bgDecoration: vscode.TextEditorDecorationType,
  gutterDecoration: vscode.TextEditorDecorationType,
  deletionGutterDecoration: vscode.TextEditorDecorationType,
): void {
  const relativePath = getRelativePath(editor)
  if (!relativePath) {
    editor.setDecorations(bgDecoration, [])
    editor.setDecorations(gutterDecoration, [])
    editor.setDecorations(deletionGutterDecoration, [])
    return
  }

  const fileState = manager.getFileState(relativePath)
  if (!fileState) {
    editor.setDecorations(bgDecoration, [])
    editor.setDecorations(gutterDecoration, [])
    editor.setDecorations(deletionGutterDecoration, [])
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

  // Determine which unreviewed lines are deletion-adjacent
  const deletionAdjacentSet = new Set(fileState.deletionAdjacentLines ?? [])
  const regularGutterRanges: vscode.Range[] = []
  const deletionGutterRanges: vscode.Range[] = []

  for (const range of unreviewed) {
    for (let line = range.startLine; line <= range.endLine; line++) {
      const vsRange = new vscode.Range(
        new vscode.Position(line - 1, 0),
        new vscode.Position(line - 1, Number.MAX_SAFE_INTEGER),
      )
      if (deletionAdjacentSet.has(line)) {
        deletionGutterRanges.push(vsRange)
      } else {
        regularGutterRanges.push(vsRange)
      }
    }
  }

  editor.setDecorations(bgDecoration, decorationRanges)
  editor.setDecorations(gutterDecoration, regularGutterRanges)
  editor.setDecorations(deletionGutterDecoration, deletionGutterRanges)
}

export function clearDecorations(
  editor: vscode.TextEditor,
  bgDecoration: vscode.TextEditorDecorationType,
  gutterDecoration: vscode.TextEditorDecorationType,
  deletionGutterDecoration: vscode.TextEditorDecorationType,
): void {
  editor.setDecorations(bgDecoration, [])
  editor.setDecorations(gutterDecoration, [])
  editor.setDecorations(deletionGutterDecoration, [])
}
