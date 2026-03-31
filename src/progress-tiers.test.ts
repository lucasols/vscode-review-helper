import { describe, expect, test } from 'vitest'
import { getProgressTier } from './progress-tiers'

describe('getProgressTier', () => {
  test('returns "zero" for 0 progress', () => {
    expect(getProgressTier(0)).toBe('zero')
  })

  test('returns "low" for progress just above 0', () => {
    expect(getProgressTier(0.01)).toBe('low')
    expect(getProgressTier(0.24)).toBe('low')
  })

  test('returns "quarter" for progress at 0.25', () => {
    expect(getProgressTier(0.25)).toBe('quarter')
    expect(getProgressTier(0.49)).toBe('quarter')
  })

  test('returns "half" for progress at 0.5', () => {
    expect(getProgressTier(0.5)).toBe('half')
    expect(getProgressTier(0.75)).toBe('half')
    expect(getProgressTier(0.99)).toBe('half')
  })

  test('returns "complete" for progress at 1', () => {
    expect(getProgressTier(1)).toBe('complete')
    expect(getProgressTier(1.5)).toBe('complete')
  })
})
