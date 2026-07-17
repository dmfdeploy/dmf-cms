/**
 * Workload-tag slug validation (dmfdeploy/dmfdeploy#239 trio). Mirrors
 * dmf_cms.main.WORKLOAD_SLUG_RE exactly — client-side pre-check before the
 * same rule is enforced server-side.
 */
import { describe, expect, it } from 'vitest'
import { isValidWorkloadSlug } from '../lib/workloadSlug'

describe('isValidWorkloadSlug', () => {
  it('accepts a single lowercase alnum char', () => {
    expect(isValidWorkloadSlug('a')).toBe(true)
    expect(isValidWorkloadSlug('9')).toBe(true)
  })

  it('accepts hyphenated slugs not starting/ending with a hyphen', () => {
    expect(isValidWorkloadSlug('studio-a')).toBe(true)
    expect(isValidWorkloadSlug('studio-a-1')).toBe(true)
  })

  it('accepts exactly 40 chars and rejects 41', () => {
    expect(isValidWorkloadSlug('a'.repeat(40))).toBe(true)
    expect(isValidWorkloadSlug('a'.repeat(41))).toBe(false)
  })

  it('rejects uppercase, leading/trailing hyphen, spaces, and other punctuation', () => {
    expect(isValidWorkloadSlug('Studio-A')).toBe(false)
    expect(isValidWorkloadSlug('-leading')).toBe(false)
    expect(isValidWorkloadSlug('trailing-')).toBe(false)
    expect(isValidWorkloadSlug('has space')).toBe(false)
    expect(isValidWorkloadSlug('under_score')).toBe(false)
    expect(isValidWorkloadSlug('$$$')).toBe(false)
  })

  it('rejects the empty string', () => {
    expect(isValidWorkloadSlug('')).toBe(false)
  })
})
