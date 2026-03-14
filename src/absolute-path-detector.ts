import * as path from 'path'
import * as vscode from 'vscode'
import type { ReviewState } from './types'
import type { ReviewStateManager } from './review-state-manager'
import { logInfo, logWarn } from './logger'

export interface AbsolutePathEntry {
  absolutePath: string
  computedRelativePath: string | undefined
  isRelativeAlreadyTracked: boolean
}

export function findAbsolutePathEntries(
  state: ReviewState,
  workspaceFolderFsPath: string,
): AbsolutePathEntry[] {
  const entries: AbsolutePathEntry[] = []
  const normalizedWorkspace = path.normalize(workspaceFolderFsPath)

  for (const key of Object.keys(state.files)) {
    if (!path.isAbsolute(key)) continue

    const normalizedKey = path.normalize(key)
    const prefix = normalizedWorkspace + path.sep

    let computedRelativePath: string | undefined
    let isRelativeAlreadyTracked = false

    if (normalizedKey.startsWith(prefix)) {
      computedRelativePath = path
        .relative(normalizedWorkspace, normalizedKey)
        .replace(/\\/g, '/')
      isRelativeAlreadyTracked = computedRelativePath in state.files
    }

    entries.push({ absolutePath: key, computedRelativePath, isRelativeAlreadyTracked })
  }

  return entries
}

export function notifyAbsolutePathEntries(
  entries: AbsolutePathEntry[],
  manager: ReviewStateManager,
  notifiedPaths: Set<string>,
): void {
  for (const entry of entries) {
    if (notifiedPaths.has(entry.absolutePath)) continue
    notifiedPaths.add(entry.absolutePath)

    const canAddAsRelative =
      entry.computedRelativePath !== undefined && !entry.isRelativeAlreadyTracked

    const message = `Review state contains an absolute path: ${entry.absolutePath}`
    const buttons: string[] = canAddAsRelative
      ? ['Add as relative path', 'Remove']
      : ['Remove']

    logWarn(message)

    void vscode.window
      .showWarningMessage(message, ...buttons)
      .then((choice) => {
        if (choice === 'Add as relative path' && entry.computedRelativePath !== undefined) {
          logInfo(`Converting absolute path to relative: ${entry.absolutePath} → ${entry.computedRelativePath}`)
          manager.renameFile(entry.absolutePath, entry.computedRelativePath)
        } else if (choice === 'Remove') {
          logInfo(`Removing absolute path entry: ${entry.absolutePath}`)
          manager.removeFile(entry.absolutePath)
        }
      })
  }
}
