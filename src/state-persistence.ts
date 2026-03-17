import type {
  FileReviewSnapshot,
  FileReviewState,
  ReviewedRange,
  ReviewState,
} from './types'
import { fingerprintDocumentLineHashes } from './review-state'
import { logWarn, logError, logDebug } from './logger'

type PersistedVersion = 1 | 2

/** Create a default empty review state */
export function createDefaultState(): ReviewState {
  return { version: 2, files: {} }
}

/** Serialize review state to JSON string */
export function serializeState(state: ReviewState): string {
  return JSON.stringify({ ...state, version: 2 }, null, 2)
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

/** Deserialize JSON string to review state. Invalid entries are stripped. */
export function deserializeState(json: string): ReviewState {
  try {
    const parsed: unknown = JSON.parse(json)

    if (!isRecord(parsed)) {
      logWarn('Deserialization: invalid root structure')
      return createDefaultState()
    }

    const version = parsed['version']
    if (version !== 1 && version !== 2) {
      logWarn(`Deserialization: unsupported version ${String(version)}`)
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
      const validated = validateFileState(key, value, version)
      if (validated) {
        files[key] = validated
      } else {
        skipped++
      }
    }

    if (skipped > 0) {
      logWarn(`Deserialization: stripped ${skipped} invalid file entry/entries`)
    }
    logDebug(
      `Deserialized state: ${Object.keys(files).length} valid file(s) from v${String(version)}`,
    )

    return { version: 2, files }
  } catch (err) {
    logError(`Deserialization failed: ${err instanceof Error ? err.message : String(err)}`)
    return createDefaultState()
  }
}
