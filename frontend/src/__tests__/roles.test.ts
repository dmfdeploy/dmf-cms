/**
 * Console role ladder (umbrella dmfdeploy/dmfdeploy#378) — the comparison
 * lib/workloadLifecycle.ts's delete-permanently gate is built on. Pinned in
 * isolation so a ladder mistake (wrong order, an inclusive/exclusive slip)
 * shows up here rather than only as a wrongly-offered or wrongly-withheld
 * destructive control three layers up.
 */
import { describe, expect, it } from 'vitest'
import { roleAtLeast } from '../lib/roles'

describe('roleAtLeast', () => {
  it('passes a role that meets the floor exactly', () => {
    expect(roleAtLeast('operator', 'operator')).toBe(true)
  })

  it('passes every role above the floor', () => {
    expect(roleAtLeast('engineer', 'operator')).toBe(true)
    expect(roleAtLeast('admin', 'operator')).toBe(true)
  })

  it('fails a role below the floor', () => {
    expect(roleAtLeast('viewer', 'operator')).toBe(false)
  })

  it('fails closed on an absent or unrecognised role, never defaulting to pass', () => {
    expect(roleAtLeast(undefined, 'operator')).toBe(false)
    expect(roleAtLeast(null, 'operator')).toBe(false)
  })
})
