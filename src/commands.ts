import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as vscode from 'vscode'
import type { ReviewStateManager } from './review-state-manager'
import { logInfo, logWarn, logError } from './logger'
import {
  filterImportOnlyRanges,
  isTypeScriptFile,
  parseGitDiff,
  type FileChange,
} from './git-diff'

const execFileAsync = promisify(execFile)

const TEST_FILE_GLOB = '**/*.{test,spec}.{ts,tsx,js,jsx}'

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

interface FileFilterChoice {
  label: string
  value: 'all' | 'tests' | 'glob' | 'select'
}

const FILE_FILTER_CHOICES: FileFilterChoice[] = [
  { label: 'All files', value: 'all' },
  { label: 'Test files only', value: 'tests' },
  { label: 'Filter by glob pattern', value: 'glob' },
  { label: 'Select files...', value: 'select' },
]

async function selectFilesToInclude(
  allFiles: FileChange[],
  folder: vscode.WorkspaceFolder,
): Promise<FileChange[] | undefined> {
  const choice = await vscode.window.showQuickPick(
    FILE_FILTER_CHOICES.map((c) => ({ label: c.label, value: c.value })),
    { placeHolder: 'Which files to include?' },
  )

  if (!choice) return undefined

  switch (choice.value) {
    case 'all':
      return allFiles

    case 'tests': {
      const testPattern = new vscode.RelativePattern(folder, TEST_FILE_GLOB)
      const testFiles = await vscode.workspace.findFiles(testPattern)
      const testPaths = new Set(testFiles.map((f) => getRelativePath(f, folder)))
      return allFiles.filter((fc) => testPaths.has(fc.relativePath))
    }

    case 'glob': {
      const globPattern = await vscode.window.showInputBox({
        prompt: 'Enter glob pattern (e.g., src/**/*.ts)',
        placeHolder: '**/*.ts',
      })
      if (!globPattern) return undefined

      const pattern = new vscode.RelativePattern(folder, globPattern)
      const matchingFiles = await vscode.workspace.findFiles(pattern)
      const matchingPaths = new Set(
        matchingFiles.map((f) => getRelativePath(f, folder)),
      )
      return allFiles.filter((fc) => matchingPaths.has(fc.relativePath))
    }

    case 'select': {
      const items = allFiles.map((fc) => ({
        label: fc.relativePath,
        picked: true,
        fileChange: fc,
      }))
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select files to include',
      })
      if (!selected) return undefined
      return selected.map((s) => s.fileChange)
    }

    default:
      return allFiles
  }
}

async function getUncommittedFileChanges(
  cwd: string,
  folder: vscode.WorkspaceFolder,
): Promise<FileChange[] | undefined> {
  let diffOutput: string
  let untrackedOutput: string

  try {
    const [diffResult, untrackedResult] = await Promise.all([
      execFileAsync('git', ['diff', 'HEAD', '--unified=0'], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      }).catch(async (err: unknown) => {
        if (err instanceof Error && err.message.includes('unknown revision')) {
          return execFileAsync('git', ['diff', '--cached', '--unified=0'], {
            cwd,
            maxBuffer: 10 * 1024 * 1024,
          })
        }
        throw err
      }),
      execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ])

    diffOutput = diffResult.stdout
    untrackedOutput = untrackedResult.stdout
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logError(`Failed to run git: ${message}`)
    vscode.window.showWarningMessage(
      'Failed to get uncommitted changes. Is this a git repository?',
    )
    return undefined
  }

  const fileChanges = parseGitDiff(diffOutput)

  const untrackedFiles = untrackedOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  for (const filePath of untrackedFiles) {
    if (fileChanges.some((fc) => fc.relativePath === filePath)) continue

    try {
      const fileUri = vscode.Uri.joinPath(folder.uri, filePath)
      const doc = await vscode.workspace.openTextDocument(fileUri)
      if (doc.lineCount > 0) {
        fileChanges.push({
          relativePath: filePath,
          changedRanges: [{ startLine: 1, endLine: doc.lineCount }],
        })
      }
    } catch {
      logWarn(`Skipping untracked file (could not open): ${filePath}`)
    }
  }

  return fileChanges
}

async function getPRFileChanges(
  cwd: string,
): Promise<FileChange[] | undefined> {
  let diffOutput: string

  try {
    // Get the base branch for the current PR
    const prResult = await execFileAsync(
      'gh',
      ['pr', 'view', '--json', 'baseRefName', '-q', '.baseRefName'],
      { cwd },
    )
    const baseBranch = prResult.stdout.trim()

    if (!baseBranch) {
      vscode.window.showWarningMessage('Could not determine PR base branch')
      return undefined
    }

    // Get diff between base branch and current HEAD
    const diffResult = await execFileAsync(
      'git',
      ['diff', `${baseBranch}...HEAD`, '--unified=0'],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
    )

    diffOutput = diffResult.stdout
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logError(`Failed to get PR changes: ${message}`)
    vscode.window.showWarningMessage(
      'Failed to get PR changes. Is gh CLI installed and authenticated? Is this branch associated with a PR?',
    )
    return undefined
  }

  return parseGitDiff(diffOutput)
}

async function addFileChangesToReview(
  fileChanges: FileChange[],
  folder: vscode.WorkspaceFolder,
  manager: ReviewStateManager,
  commandName: string,
): Promise<number> {
  const ignoreImports = vscode.workspace
    .getConfiguration('reviewHelper')
    .get<boolean>('ignoreImportChanges', false)

  const affectedPaths = fileChanges.map((fc) => fc.relativePath)
  manager.saveUndoSnapshot(affectedPaths)

  let addedCount = 0
  for (const fileChange of fileChanges) {
    try {
      const fileUri = vscode.Uri.joinPath(folder.uri, fileChange.relativePath)
      const doc = await vscode.workspace.openTextDocument(fileUri)
      const documentLines = getDocumentLines(doc)

      let changedRanges = fileChange.changedRanges
      if (ignoreImports && isTypeScriptFile(fileChange.relativePath)) {
        changedRanges = filterImportOnlyRanges(changedRanges, documentLines)
      }

      const isTracked = manager.getFileState(fileChange.relativePath) !== undefined
      if (!isTracked) {
        manager.markFileReviewed(fileChange.relativePath, documentLines)
      }

      for (const range of changedRanges) {
        manager.markSelectionUnreviewed(
          fileChange.relativePath,
          range.startLine,
          range.endLine,
          documentLines,
        )
      }

      addedCount++
    } catch {
      logWarn(`Skipping file (could not open): ${fileChange.relativePath}`)
    }
  }

  logInfo(`Command: ${commandName} → ${addedCount} file(s)`)
  return addedCount
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
          logWarn('addFile: no file selected')
          vscode.window.showWarningMessage('No file selected')
          return
        }

        const relativePath = getRelativePath(targetUri, folder)
        logInfo(`Command: addFile → ${relativePath}`)
        const document = await vscode.workspace.openTextDocument(targetUri)
        manager.saveUndoSnapshot([relativePath])
        manager.addFile(relativePath, document.lineCount)

        vscode.window.showInformationMessage(
          `Added "${relativePath}" to review`,
        )
      },
    ),

    vscode.commands.registerCommand(
      'reviewHelper.removeFile',
      async (item?: { relativePath?: string }) => {
        const folder = getActiveWorkspaceFolder()
        if (!folder) return

        let relativePath = item?.relativePath
        if (!relativePath) {
          const editor = vscode.window.activeTextEditor
          if (!editor) return
          relativePath = getRelativePath(editor.document.uri, folder)
        }

        const confirm = await vscode.window.showWarningMessage(
          `Remove "${relativePath}" from review?`,
          { modal: true },
          'Remove',
        )
        if (confirm !== 'Remove') return

        logInfo(`Command: removeFile → ${relativePath}`)
        manager.saveUndoSnapshot([relativePath])
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
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1
      const documentLines = getDocumentLines(editor.document)

      logInfo(`Command: markReviewed → ${relativePath} lines ${startLine}-${endLine}`)
      manager.saveUndoSnapshot([relativePath])
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
      const documentLines = getDocumentLines(editor.document)

      logInfo(`Command: markUnreviewed → ${relativePath} lines ${startLine}-${endLine}`)
      manager.saveUndoSnapshot([relativePath])
      if (!manager.getFileState(relativePath)) {
        manager.markFileReviewed(relativePath, documentLines)
      }

      manager.markSelectionUnreviewed(relativePath, startLine, endLine, documentLines)
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

        logInfo(`Command: markFileReviewed → ${relativePath}`)
        manager.saveUndoSnapshot([relativePath])
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
          logInfo(`Command: clearFileReview → ${relativePath}`)
          manager.saveUndoSnapshot([relativePath])
          manager.clearFileReview(relativePath, getDocumentLines(editor.document))
          return
        }

        logInfo(`Command: clearFileReview → ${relativePath}`)
        manager.saveUndoSnapshot([relativePath])
        manager.clearFileReview(relativePath)
      },
    ),

    vscode.commands.registerCommand('reviewHelper.clearAllReviews', () => {
      logInfo('Command: clearAllReviews')
      manager.saveUndoSnapshot(manager.getTrackedFiles())
      manager.clearAll()
      vscode.window.showInformationMessage('Cleared all review state')
    }),

    vscode.commands.registerCommand('reviewHelper.recheckAll', async () => {
      logInfo('Command: recheckAll')
      await manager.recheckAllFiles()
      vscode.window.showInformationMessage('Recheck complete')
    }),

    vscode.commands.registerCommand('reviewHelper.undo', () => {
      logInfo('Command: undo')
      if (!manager.undo()) {
        vscode.window.showInformationMessage('Nothing to undo')
      }
    }),

    vscode.commands.registerCommand('reviewHelper.redo', () => {
      logInfo('Command: redo')
      if (!manager.redo()) {
        vscode.window.showInformationMessage('Nothing to redo')
      }
    }),

    // Single file: add uncommitted changes
    vscode.commands.registerCommand(
      'reviewHelper.addUncommittedChanges',
      async (uri?: vscode.Uri) => {
        const folder = getActiveWorkspaceFolder()
        if (!folder) return

        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri
        if (!targetUri) {
          logWarn('addUncommittedChanges: no file selected')
          vscode.window.showWarningMessage('No file selected')
          return
        }

        const relativePath = getRelativePath(targetUri, folder)
        const cwd = folder.uri.fsPath

        let diffOutput: string
        let isUntracked = false

        try {
          const diffResult = await execFileAsync(
            'git',
            ['diff', 'HEAD', '--unified=0', '--', relativePath],
            { cwd, maxBuffer: 10 * 1024 * 1024 },
          ).catch(async (err: unknown) => {
            if (
              err instanceof Error
              && err.message.includes('unknown revision')
            ) {
              return execFileAsync(
                'git',
                ['diff', '--cached', '--unified=0', '--', relativePath],
                { cwd, maxBuffer: 10 * 1024 * 1024 },
              )
            }
            throw err
          })

          diffOutput = diffResult.stdout

          if (!diffOutput.trim()) {
            const lsResult = await execFileAsync(
              'git',
              ['ls-files', '--others', '--exclude-standard', '--', relativePath],
              { cwd },
            )
            isUntracked = lsResult.stdout.trim().length > 0
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logError(`Failed to run git: ${message}`)
          vscode.window.showWarningMessage(
            'Failed to get uncommitted changes. Is this a git repository?',
          )
          return
        }

        const document = await vscode.workspace.openTextDocument(targetUri)
        const documentLines = getDocumentLines(document)

        let changedRanges: Array<{ startLine: number; endLine: number }>

        if (isUntracked) {
          changedRanges = [{ startLine: 1, endLine: document.lineCount }]
        } else {
          const fileChanges = parseGitDiff(diffOutput)
          const fileChange = fileChanges.find(
            (fc) => fc.relativePath === relativePath,
          )

          if (!fileChange) {
            vscode.window.showInformationMessage(
              `No uncommitted changes in "${relativePath}"`,
            )
            return
          }

          changedRanges = fileChange.changedRanges
        }

        const ignoreImports = vscode.workspace
          .getConfiguration('reviewHelper')
          .get<boolean>('ignoreImportChanges', false)

        if (ignoreImports && isTypeScriptFile(relativePath)) {
          changedRanges = filterImportOnlyRanges(changedRanges, documentLines)
        }

        logInfo(`Command: addUncommittedChanges → ${relativePath}`)
        manager.saveUndoSnapshot([relativePath])

        const isTracked = manager.getFileState(relativePath) !== undefined
        if (!isTracked) {
          manager.markFileReviewed(relativePath, documentLines)
        }

        for (const range of changedRanges) {
          manager.markSelectionUnreviewed(
            relativePath,
            range.startLine,
            range.endLine,
            documentLines,
          )
        }

        vscode.window.showInformationMessage(
          `Added uncommitted changes in "${relativePath}" to review`,
        )
      },
    ),

    // Multiple files: add uncommitted changes with file picker
    vscode.commands.registerCommand(
      'reviewHelper.addMultipleUncommittedChanges',
      async () => {
        const folder = getActiveWorkspaceFolder()
        if (!folder) return

        const cwd = folder.uri.fsPath
        const allFileChanges = await getUncommittedFileChanges(cwd, folder)
        if (!allFileChanges) return

        if (allFileChanges.length === 0) {
          vscode.window.showInformationMessage('No uncommitted changes found')
          return
        }

        const selectedFiles = await selectFilesToInclude(allFileChanges, folder)
        if (!selectedFiles || selectedFiles.length === 0) {
          return
        }

        const addedCount = await addFileChangesToReview(
          selectedFiles,
          folder,
          manager,
          'addMultipleUncommittedChanges',
        )

        vscode.window.showInformationMessage(
          `Added ${addedCount} file(s) with uncommitted changes to review`,
        )
      },
    ),

    // Single file: add PR changes
    vscode.commands.registerCommand(
      'reviewHelper.addPRChanges',
      async (uri?: vscode.Uri) => {
        const folder = getActiveWorkspaceFolder()
        if (!folder) return

        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri
        if (!targetUri) {
          logWarn('addPRChanges: no file selected')
          vscode.window.showWarningMessage('No file selected')
          return
        }

        const relativePath = getRelativePath(targetUri, folder)
        const cwd = folder.uri.fsPath

        const allFileChanges = await getPRFileChanges(cwd)
        if (!allFileChanges) return

        const fileChange = allFileChanges.find(
          (fc) => fc.relativePath === relativePath,
        )

        if (!fileChange) {
          vscode.window.showInformationMessage(
            `No PR changes in "${relativePath}"`,
          )
          return
        }

        const document = await vscode.workspace.openTextDocument(targetUri)
        const documentLines = getDocumentLines(document)

        let changedRanges = fileChange.changedRanges

        const ignoreImports = vscode.workspace
          .getConfiguration('reviewHelper')
          .get<boolean>('ignoreImportChanges', false)

        if (ignoreImports && isTypeScriptFile(relativePath)) {
          changedRanges = filterImportOnlyRanges(changedRanges, documentLines)
        }

        logInfo(`Command: addPRChanges → ${relativePath}`)
        manager.saveUndoSnapshot([relativePath])

        const isTracked = manager.getFileState(relativePath) !== undefined
        if (!isTracked) {
          manager.markFileReviewed(relativePath, documentLines)
        }

        for (const range of changedRanges) {
          manager.markSelectionUnreviewed(
            relativePath,
            range.startLine,
            range.endLine,
            documentLines,
          )
        }

        vscode.window.showInformationMessage(
          `Added PR changes in "${relativePath}" to review`,
        )
      },
    ),

    // Multiple files: add PR changes with file picker
    vscode.commands.registerCommand(
      'reviewHelper.addMultiplePRChanges',
      async () => {
        const folder = getActiveWorkspaceFolder()
        if (!folder) return

        const cwd = folder.uri.fsPath
        const allFileChanges = await getPRFileChanges(cwd)
        if (!allFileChanges) return

        if (allFileChanges.length === 0) {
          vscode.window.showInformationMessage('No PR changes found')
          return
        }

        const selectedFiles = await selectFilesToInclude(allFileChanges, folder)
        if (!selectedFiles || selectedFiles.length === 0) {
          return
        }

        const addedCount = await addFileChangesToReview(
          selectedFiles,
          folder,
          manager,
          'addMultiplePRChanges',
        )

        vscode.window.showInformationMessage(
          `Added ${addedCount} file(s) with PR changes to review`,
        )
      },
    ),
  )
}
