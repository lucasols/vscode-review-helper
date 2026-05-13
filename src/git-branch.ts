import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as vscode from 'vscode'
import { logDebug, logWarn } from './logger'
import { DEFAULT_BRANCH_KEY } from './state-persistence'

const execFileAsync = promisify(execFile)

export { DEFAULT_BRANCH_KEY }

/**
 * Detect the current branch for the given workspace folder.
 * Returns `detached:<short-sha>` for detached HEAD, the branch name otherwise,
 * or `DEFAULT_BRANCH_KEY` if the folder is not a git repository.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    const result = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd },
    )
    const branch = result.stdout.trim()

    if (branch === 'HEAD') {
      const shaResult = await execFileAsync(
        'git',
        ['rev-parse', '--short', 'HEAD'],
        { cwd },
      )
      const sha = shaResult.stdout.trim()
      return sha ? `detached:${sha}` : DEFAULT_BRANCH_KEY
    }

    return branch || DEFAULT_BRANCH_KEY
  } catch (err) {
    logDebug(
      `Branch detection failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return DEFAULT_BRANCH_KEY
  }
}

/**
 * Resolve the path that should be watched to detect branch switches.
 * For the common case this is `<workspace>/.git/HEAD`. For worktrees the
 * `.git` entry is a file pointing at the actual gitdir; we follow that link.
 * Returns undefined if the path cannot be resolved (not a git workspace).
 */
export async function resolveGitHeadUri(
  folder: vscode.WorkspaceFolder,
): Promise<vscode.Uri | undefined> {
  const gitEntry = vscode.Uri.joinPath(folder.uri, '.git')
  try {
    const stat = await vscode.workspace.fs.stat(gitEntry)

    if (stat.type === vscode.FileType.Directory) {
      return vscode.Uri.joinPath(gitEntry, 'HEAD')
    }

    if (stat.type === vscode.FileType.File) {
      const data = await vscode.workspace.fs.readFile(gitEntry)
      const content = new TextDecoder().decode(data).trim()
      const match = /^gitdir:\s*(.+)$/.exec(content)
      if (!match || !match[1]) return undefined

      const gitdirPath = match[1].trim()
      const gitdirUri = gitdirPath.startsWith('/')
        ? vscode.Uri.file(gitdirPath)
        : vscode.Uri.joinPath(folder.uri, gitdirPath)
      return vscode.Uri.joinPath(gitdirUri, 'HEAD')
    }

    return undefined
  } catch (err) {
    logWarn(
      `Could not locate .git/HEAD: ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
}
