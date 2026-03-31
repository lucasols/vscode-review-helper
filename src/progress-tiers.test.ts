import { describe, expect, test } from 'vitest'
import { getProgressTier } from './progress-tiers'

describe('getProgressTier', () => {
  test('returns "low" for 0 progress', () => {
    expect(getProgressTier(0)).toBe('low')
  })

  test('returns "low" for progress below 0.25', () => {
    expect(getProgressTier(0.01)).toBe('low')
    expect(getProgressTier(0.24)).toBe('low')
  })

  test('returns "medium" for progress at 0.25 up to 0.5', () => {
    expect(getProgressTier(0.25)).toBe('medium')
    expect(getProgressTier(0.49)).toBe('medium')
  })

  test('returns "high" for progress at 0.5 up to 1', () => {
    expect(getProgressTier(0.5)).toBe('high')
    expect(getProgressTier(0.75)).toBe('high')
    expect(getProgressTier(0.99)).toBe('high')
  })

  test('returns "complete" for progress at 1 or above', () => {
    expect(getProgressTier(1)).toBe('complete')
    expect(getProgressTier(1.5)).toBe('complete')
  })
})
