export type ProgressTier = 'zero' | 'low' | 'quarter' | 'half' | 'complete'

export function getProgressTier(progress: number): ProgressTier {
  if (progress >= 1) return 'complete'
  if (progress >= 0.5) return 'half'
  if (progress >= 0.25) return 'quarter'
  if (progress > 0) return 'low'
  return 'zero'
}
