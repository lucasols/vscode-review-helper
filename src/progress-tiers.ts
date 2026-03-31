export type ProgressTier = 'low' | 'medium' | 'high' | 'complete'

export function getProgressTier(progress: number): ProgressTier {
  if (progress >= 1) return 'complete'
  if (progress >= 0.5) return 'high'
  if (progress >= 0.25) return 'medium'
  return 'low'
}
