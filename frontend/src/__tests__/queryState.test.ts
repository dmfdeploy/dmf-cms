/**
 * settleQuery — the shared "isError wins unconditionally" primitive
 * (fix-round 6, PR #81, umbrella #385). Direct unit coverage of the one
 * rule the whole isError-gating bug arc kept re-discovering by hand.
 */
import { describe, expect, it } from 'vitest'
import { settleQuery } from '../lib/queryState'

describe('settleQuery', () => {
  it('loading: first fetch, no data yet, not errored', () => {
    const s = settleQuery({ isLoading: true, isError: false, data: undefined })
    expect(s).toEqual({ loading: true, failed: false, data: undefined })
  })

  it('success: settled, no error, real data', () => {
    const s = settleQuery({ isLoading: false, isError: false, data: { n: 1 } })
    expect(s).toEqual({ loading: false, failed: false, data: { n: 1 } })
  })

  it('failed with no data ever retained: not loading, failed, data undefined', () => {
    const s = settleQuery({ isLoading: false, isError: true, data: undefined })
    expect(s).toEqual({ loading: false, failed: true, data: undefined })
  })

  // The exact shape this whole arc kept missing: a settled failed refetch
  // with data RETAINED from a prior success. `failed` must be true
  // regardless — the caller decides whether to still show `.data`.
  it('failed with data retained from a prior success: failed wins, data still exposed', () => {
    const s = settleQuery({ isLoading: false, isError: true, data: { n: 1 } })
    expect(s.failed).toBe(true)
    expect(s.data).toEqual({ n: 1 })
    expect(s.loading).toBe(false)
  })

  it('isLoading true but data retained (a background refetch in flight) is not "loading" — real data already exists', () => {
    const s = settleQuery({ isLoading: true, isError: false, data: { n: 1 } })
    expect(s.loading).toBe(false)
    expect(s.failed).toBe(false)
    expect(s.data).toEqual({ n: 1 })
  })
})
