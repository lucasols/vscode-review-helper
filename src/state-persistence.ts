import type { FileReviewState, ReviewedRange, ReviewState } from './types'
import { logWarn, logError, logDebug } from './logger'

/** Create a default empty review state */
export function createDefaultState(): ReviewState {
  return { version: 1, files: {} }
}

/** Serialize review state to JSON string */
export function serializeState(state: ReviewState): string {
  return JSON.stringify(state, null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateLineHashes(value: unknown): Record<number, string> | null {
  if (!isRecord(value)) return null

  const result: Record<number, string> = {}
  for (const [key, hash] of Object.entries(value)) {
    const lineNum = Number(key)
    if (Number.isFinite(lineNum) && lineNum >= 1 && typeof hash === 'string') {
      result[lineNum] = hash
    }
  }
  return result
}

function validateRange(value: unknown): ReviewedRange | null {
  if (!isRecord(value)) return null

  const { startLine, endLine, lineHashes } = value
  if (
    typeof startLine !== 'number' ||
    typeof endLine !== 'number' ||
    !Number.isFinite(startLine) ||
    !Number.isFinite(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return null
  }

  const validatedHashes = validateLineHashes(lineHashes)
  if (!validatedHashes) return null

  return { startLine, endLine, lineHashes: validatedHashes }
}

function validateFileState(
  key: string,
  value: unknown,
): FileReviewState | null {
  if (!isRecord(value)) return null

  const { relativePath, reviewedRanges, totalLines } = value
  if (typeof relativePath !== 'string' || relativePath !== key) return null
  if (typeof totalLines !== 'number' || !Number.isFinite(totalLines) || totalLines < 0) {
    return null
  }
  if (!Array.isArray(reviewedRanges)) return null

  const validRanges: ReviewedRange[] = []
  for (const range of reviewedRanges) {
    const validated = validateRange(range)
    if (validated) {
      validRanges.push(validated)
    }
  }

  return { relativePath, totalLines, reviewedRanges: validRanges }
}

/** Deserialize JSON string to review state. Invalid entries are stripped. */
export function deserializeState(json: string): ReviewState {
  try {
    const parsed: unknown = JSON.parse(json)

    if (!isRecord(parsed)) {
      logWarn('Deserialization: invalid root structure')
      return createDefaultState()
    }
    if (parsed['version'] !== 1) {
      logWarn(`Deserialization: unsupported version ${String(parsed['version'])}`)
      return createDefaultState()
    }

    const filesValue = parsed['files']
    if (!isRecord(filesValue)) {
      logWarn('Deserialization: invalid files structure')
      return createDefaultState()
    }

    const files: Record<string, FileReviewState> = {}
    let skipped = 0
    for (const [key, value] of Object.entries(filesValue)) {
      const validated = validateFileState(key, value)
      if (validated) {
        files[key] = validated
      } else {
        skipped++
      }
    }

    if (skipped > 0) {
      logWarn(`Deserialization: stripped ${skipped} invalid file entry/entries`)
    }
    logDebug(`Deserialized state: ${Object.keys(files).length} valid file(s)`)

    return { version: 1, files }
  } catch (err) {
    logError(`Deserialization failed: ${err instanceof Error ? err.message : String(err)}`)
    return createDefaultState()
  }
}
