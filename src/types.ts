export interface ReviewedRange {
  startLine: number // 1-based
  endLine: number // 1-based, inclusive
  lineHashes: Record<number, string> // line number -> hash of content at review time
}

export interface FileReviewSnapshot {
  fingerprint: string
  totalLines: number
  reviewedRanges: ReviewedRange[]
  documentLineHashes: string[]
  deletionAdjacentLines?: number[] // 1-based line numbers adjacent to deleted reviewed lines
}

export interface FileReviewState {
  relativePath: string // workspace-relative, forward slashes
  reviewedRanges: ReviewedRange[]
  totalLines: number
  documentLineHashes?: string[] // full document snapshot from the last known file state
  documentFingerprint?: string // fingerprint of documentLineHashes
  deletionAdjacentLines?: number[] // 1-based line numbers adjacent to deleted reviewed lines, shown with red gutter dot
  snapshots?: FileReviewSnapshot[] // newest-first retained snapshots keyed by fingerprint
}

export interface ReviewState {
  version: 2
  files: Record<string, FileReviewState> // keyed by relativePath
}
