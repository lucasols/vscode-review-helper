import type {
  BranchReviewScope,
  FileReviewSnapshot,
  FileReviewState,
  ReviewedRange,
  ReviewState,
} from './types'
import { fingerprintDocumentLineHashes } from './review-state'
import { logWarn, logError, logDebug } from './logger'

/** Sentinel branch key used when no git branch is detected. */
export const DEFAULT_BRANCH_KEY = '__default__'

type PersistedVersion = 1 | 2 | 3

/** Create a default empty review state */
export function createDefaultState(): ReviewState {
  return { version: 3, branches: {} }
}

/** Serialize review state to JSON string */
export function serializeState(state: ReviewState): string {
  return JSON.stringify({ ...state, version: 3 }, null, 2)
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

function validateRanges(value: unknown): ReviewedRange[] | null {
  if (!Array.isArray(value)) return null

  const validRanges: ReviewedRange[] = []
  for (const range of value) {
    const validated = validateRange(range)
    if (validated) {
      validRanges.push(validated)
    }
  }
  return validRanges
}

function validateDocumentLineHashes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined

  const hashes: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined
    hashes.push(entry)
  }
  return hashes
}

function validateDeletionAdjacentLines(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined

  const lines: number[] = []
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 1) {
      lines.push(entry)
    }
  }
  return lines.length > 0 ? lines : undefined
}

function validateSnapshot(value: unknown): FileReviewSnapshot | null {
  if (!isRecord(value)) return null

  const {
    totalLines,
    reviewedRanges,
    documentLineHashes,
    deletionAdjacentLines,
  } = value

  if (
    typeof totalLines !== 'number' ||
    !Number.isFinite(totalLines) ||
    totalLines < 0
  ) {
    return null
  }

  const validRanges = validateRanges(reviewedRanges)
  const validatedDocumentHashes = validateDocumentLineHashes(documentLineHashes)
  if (!validRanges || !validatedDocumentHashes) {
    return null
  }

  return {
    fingerprint: fingerprintDocumentLineHashes(validatedDocumentHashes),
    totalLines,
    reviewedRanges: validRanges,
    documentLineHashes: validatedDocumentHashes,
    deletionAdjacentLines: validateDeletionAdjacentLines(deletionAdjacentLines),
  }
}

function validateSnapshots(value: unknown): FileReviewSnapshot[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined

  const snapshots: FileReviewSnapshot[] = []
  const seenFingerprints = new Set<string>()

  for (const entry of value) {
    const snapshot = validateSnapshot(entry)
    if (!snapshot || seenFingerprints.has(snapshot.fingerprint)) {
      continue
    }

    snapshots.push(snapshot)
    seenFingerprints.add(snapshot.fingerprint)
  }

  return snapshots.length > 0 ? snapshots : undefined
}

function validateFileState(
  key: string,
  value: unknown,
  sourceVersion: PersistedVersion,
): FileReviewState | null {
  if (!isRecord(value)) return null

  const {
    relativePath,
    reviewedRanges,
    totalLines,
    documentLineHashes,
    deletionAdjacentLines,
    snapshots,
  } = value

  if (typeof relativePath !== 'string' || relativePath !== key) return null
  if (typeof totalLines !== 'number' || !Number.isFinite(totalLines) || totalLines < 0) {
    return null
  }

  const validRanges = validateRanges(reviewedRanges)
  if (!validRanges) return null

  const validatedDocumentHashes = validateDocumentLineHashes(documentLineHashes)
  const validatedDeletionAdjacentLines = validateDeletionAdjacentLines(
    deletionAdjacentLines,
  )
  const documentFingerprint = validatedDocumentHashes
    ? fingerprintDocumentLineHashes(validatedDocumentHashes)
    : undefined

  const validatedSnapshots = sourceVersion === 1
    ? (
        validatedDocumentHashes && documentFingerprint
          ? [
              {
                fingerprint: documentFingerprint,
                totalLines,
                reviewedRanges: validRanges,
                documentLineHashes: validatedDocumentHashes,
                deletionAdjacentLines: validatedDeletionAdjacentLines,
              },
            ]
          : undefined
      )
    : validateSnapshots(snapshots)

  return {
    relativePath,
    totalLines,
    reviewedRanges: validRanges,
    documentLineHashes: validatedDocumentHashes,
    documentFingerprint,
    deletionAdjacentLines: validatedDeletionAdjacentLines,
    snapshots: validatedSnapshots,
  }
}

function validateFilesMap(
  value: unknown,
  sourceVersion: PersistedVersion,
): { files: Record<string, FileReviewState>; skipped: number } | null {
  if (!isRecord(value)) return null

  const files: Record<string, FileReviewState> = {}
  let skipped = 0
  for (const [key, entry] of Object.entries(value)) {
    const validated = validateFileState(key, entry, sourceVersion)
    if (validated) {
      files[key] = validated
    } else {
      skipped++
    }
  }
  return { files, skipped }
}

function validateBranchScope(
  value: unknown,
): BranchReviewScope | null {
  if (!isRecord(value)) return null

  const filesResult = validateFilesMap(value['files'], 3)
  if (!filesResult) return null

  const rawLastAccessed = value['lastAccessedAt']
  const lastAccessedAt =
    typeof rawLastAccessed === 'number' && Number.isFinite(rawLastAccessed) && rawLastAccessed >= 0
      ? rawLastAccessed
      : Date.now()

  return { files: filesResult.files, lastAccessedAt }
}

/**
 * Deserialize JSON string to review state. Invalid entries are stripped.
 * Legacy v1/v2 states (flat `files`) are migrated into a single branch
 * scope keyed by `migrationBranch`.
 */
export function deserializeState(
  json: string,
  migrationBranch: string = DEFAULT_BRANCH_KEY,
): ReviewState {
  try {
    const parsed: unknown = JSON.parse(json)

    if (!isRecord(parsed)) {
      logWarn('Deserialization: invalid root structure')
      return createDefaultState()
    }

    const version = parsed['version']
    if (version !== 1 && version !== 2 && version !== 3) {
      logWarn(`Deserialization: unsupported version ${String(version)}`)
      return createDefaultState()
    }

    if (version === 3) {
      const branchesValue = parsed['branches']
      if (!isRecord(branchesValue)) {
        logWarn('Deserialization: invalid branches structure')
        return createDefaultState()
      }

      const branches: Record<string, BranchReviewScope> = {}
      let skippedBranches = 0
      for (const [branchKey, branchValue] of Object.entries(branchesValue)) {
        const scope = validateBranchScope(branchValue)
        if (scope) {
          branches[branchKey] = scope
        } else {
          skippedBranches++
        }
      }

      if (skippedBranches > 0) {
        logWarn(`Deserialization: stripped ${skippedBranches} invalid branch entry/entries`)
      }

      const branchCount = Object.keys(branches).length
      const fileCount = Object.values(branches).reduce(
        (acc, scope) => acc + Object.keys(scope.files).length,
        0,
      )
      logDebug(
        `Deserialized state: v3, ${branchCount} branch(es), ${fileCount} file(s)`,
      )

      return { version: 3, branches }
    }

    const filesValue = parsed['files']
    const legacyResult = validateFilesMap(filesValue, version)
    if (!legacyResult) {
      logWarn('Deserialization: invalid files structure')
      return createDefaultState()
    }

    if (legacyResult.skipped > 0) {
      logWarn(`Deserialization: stripped ${legacyResult.skipped} invalid file entry/entries`)
    }

    const fileCount = Object.keys(legacyResult.files).length
    logDebug(
      `Deserialized state: migrated v${String(version)} → v3, ${fileCount} file(s) into branch "${migrationBranch}"`,
    )

    return {
      version: 3,
      branches: {
        [migrationBranch]: {
          files: legacyResult.files,
          lastAccessedAt: Date.now(),
        },
      },
    }
  } catch (err) {
    logError(`Deserialization failed: ${err instanceof Error ? err.message : String(err)}`)
    return createDefaultState()
  }
}
