export interface ChangedLineRange {
  startLine: number // 1-based
  endLine: number // 1-based, inclusive
}

export interface FileChange {
  relativePath: string
  changedRanges: ChangedLineRange[]
}

/** Parse a unified diff hunk header to extract new-file line range */
export function parseHunkHeader(
  header: string,
): { newStart: number; newCount: number } | undefined {
  // Format: @@ -oldStart[,oldCount] +newStart[,newCount] @@
  const match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(header)
  if (!match) return undefined

  const newStart = Number(match[1])
  const newCount = match[2] !== undefined ? Number(match[2]) : 1

  return { newStart, newCount }
}

/** Parse full `git diff` output into per-file changed line ranges */
export function parseGitDiff(diffOutput: string): FileChange[] {
  if (!diffOutput.trim()) return []

  const files: FileChange[] = []
  const lines = diffOutput.split('\n')

  let currentPath: string | undefined
  let currentRanges: ChangedLineRange[] = []

  for (const line of lines) {
    // New file section
    if (line.startsWith('diff --git ')) {
      // Flush previous file
      if (currentPath !== undefined && currentRanges.length > 0) {
        files.push({ relativePath: currentPath, changedRanges: currentRanges })
      }
      currentPath = undefined
      currentRanges = []
      continue
    }

    // Extract path from +++ line (handles renames correctly)
    if (line.startsWith('+++ ')) {
      const pathPart = line.slice(4)
      if (pathPart === '/dev/null') {
        // Deleted file — skip
        currentPath = undefined
      } else {
        // Strip the b/ prefix
        currentPath = pathPart.startsWith('b/') ? pathPart.slice(2) : pathPart
      }
      continue
    }

    // Parse hunk headers
    if (line.startsWith('@@') && currentPath !== undefined) {
      const hunk = parseHunkHeader(line)
      if (hunk && hunk.newCount > 0) {
        currentRanges.push({
          startLine: hunk.newStart,
          endLine: hunk.newStart + hunk.newCount - 1,
        })
      }
    }
  }

  // Flush last file
  if (currentPath !== undefined && currentRanges.length > 0) {
    files.push({ relativePath: currentPath, changedRanges: currentRanges })
  }

  return files
}

/**
 * Get all 1-based line numbers that are part of import statements.
 * Handles single-line and multiline imports, and includes blank/comment
 * lines between consecutive import blocks.
 */
export function getImportLines(documentLines: string[]): Set<number> {
  const importLines = new Set<number>()
  let inMultilineImport = false

  for (let i = 0; i < documentLines.length; i++) {
    const line = documentLines[i]
    if (line === undefined) continue

    const trimmed = line.trim()

    if (inMultilineImport) {
      importLines.add(i + 1)
      // Check if this line closes the multiline import
      if (trimmed.includes('}') && /from\s+['"]/.test(trimmed)) {
        inMultilineImport = false
      } else if (trimmed.startsWith('}') && /}\s*from\s+['"]/.test(trimmed)) {
        inMultilineImport = false
      }
      continue
    }

    // Single-line import: import ... from '...' or import '...'
    if (/^\s*import\s/.test(line) && /['"]/.test(trimmed) && !trimmed.endsWith('{')) {
      // Check it's a complete single-line import (has a string literal and semicolon or end)
      if (/from\s+['"]/.test(trimmed) || /^import\s+['"]/.test(trimmed)) {
        importLines.add(i + 1)
        continue
      }
    }

    // Multiline import start: import { or import type {
    if (/^\s*import\s/.test(line) && (trimmed.endsWith('{') || (trimmed.includes('{') && !trimmed.includes('}')))) {
      importLines.add(i + 1)
      inMultilineImport = true
      continue
    }

    // Blank lines and comments between imports are considered part of the import region
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      // Only include if there are already import lines before this
      // and there are import lines after (we'll do a forward scan)
      if (importLines.size > 0 && hasImportAfter(documentLines, i + 1)) {
        importLines.add(i + 1)
        continue
      }
    }

    // If we hit a non-import, non-blank line and we're not in a multiline import,
    // stop scanning (imports are at the top of the file)
    if (trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')) {
      break
    }
  }

  return importLines
}

function hasImportAfter(documentLines: string[], startIndex: number): boolean {
  for (let i = startIndex; i < documentLines.length; i++) {
    const line = documentLines[i]
    if (line === undefined) continue

    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue
    }
    return /^\s*import\s/.test(line)
  }
  return false
}

/**
 * Filter out changed ranges that consist entirely of import lines.
 * Ranges with any non-import line are kept unchanged.
 */
export function filterImportOnlyRanges(
  ranges: ChangedLineRange[],
  documentLines: string[],
): ChangedLineRange[] {
  const importLineNumbers = getImportLines(documentLines)

  return ranges.filter((range) => {
    for (let line = range.startLine; line <= range.endLine; line++) {
      if (!importLineNumbers.has(line)) {
        return true
      }
    }
    return false
  })
}

/** Check if a file path is a TypeScript or JavaScript file */
export function isTypeScriptFile(filePath: string): boolean {
  return /\.(tsx?|jsx?)$/.test(filePath)
}
