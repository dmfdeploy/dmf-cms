/**
 * classifyForgejo / forgejoEmptyCopy — pure classifier unit tests
 * (fix-round on umbrella #385 PR #81).
 *
 * Component-level coverage of the same defect class lives in
 * mediaWorkloadsGrid.test.tsx and facility.test.tsx (hold-then-reject
 * through real TanStack Query retention); these are the precise,
 * fast-to-reason-about pins on the classifier itself — the exact input
 * shape react-query hands it once a background refetch has settled into
 * error with prior data still retained.
 */
import { describe, expect, it } from 'vitest'
import { classifyForgejo, forgejoEmptyCopy, type ForgejoQueryLike } from '../lib/changesState'

describe('classifyForgejo', () => {
  it('loading with no data yet', () => {
    const q: ForgejoQueryLike = { isLoading: true, isError: false }
    expect(classifyForgejo(q)).toBe('loading')
  })

  it('error when the console API itself errors with no prior data', () => {
    const q: ForgejoQueryLike = { isLoading: false, isError: true }
    expect(classifyForgejo(q)).toBe('error')
  })

  // fix-round P2-3: the shape TanStack Query actually produces after a
  // successful load followed by a failed background refetch — isLoading
  // and isFetching have both settled false, data is RETAINED from the
  // prior success, and isError is true. A stale `reason: ""` must not
  // re-authorize 'ok'.
  it('a settled error wins over RETAINED prior-success data — never re-authorizes ok', () => {
    const q: ForgejoQueryLike = { isLoading: false, isError: true, data: { reason: '' } }
    expect(classifyForgejo(q)).toBe('error')
  })

  it('a settled error wins over retained degraded data too', () => {
    const q: ForgejoQueryLike = { isLoading: false, isError: true, data: { reason: 'forgejo-unreachable' } }
    expect(classifyForgejo(q)).toBe('error')
  })

  it('reason "" is the only token that authorizes ok', () => {
    const q: ForgejoQueryLike = { isLoading: false, isError: false, data: { reason: '' } }
    expect(classifyForgejo(q)).toBe('ok')
  })

  it('forgejo-unreachable', () => {
    const q: ForgejoQueryLike = { isLoading: false, isError: false, data: { reason: 'forgejo-unreachable' } }
    expect(classifyForgejo(q)).toBe('unreachable')
  })

  it('forgejo-partial', () => {
    const q: ForgejoQueryLike = { isLoading: false, isError: false, data: { reason: 'forgejo-partial' } }
    expect(classifyForgejo(q)).toBe('partial')
  })

  it('forgejo-unconfigured', () => {
    const q: ForgejoQueryLike = { isLoading: false, isError: false, data: { reason: 'forgejo-unconfigured' } }
    expect(classifyForgejo(q)).toBe('unconfigured')
  })

  // fix-round P3-5: apiCall's generic return type is a compile-time cast,
  // not runtime validation. An absent or unrecognised token must fail
  // CLOSED (non-authoritative), never open into 'ok' — the switch default
  // used to return 'ok', which turns a malformed payload plus an empty
  // array into a claimed genuine empty.
  it('an absent reason token fails closed, not open', () => {
    // `reason` is REQUIRED on the response types (fix-round P3), but
    // apiCall's generic return is a compile-time cast, not runtime
    // validation — a malformed real payload can still omit it. Bypassing
    // the type here is the point of the test: prove the classifier defends
    // itself even when the type-level contract is violated at runtime.
    const q = { isLoading: false, isError: false, data: {} } as unknown as ForgejoQueryLike
    expect(classifyForgejo(q)).not.toBe('ok')
    expect(classifyForgejo(q)).toBe('error')
  })

  it('an unrecognised/malformed reason token fails closed, not open', () => {
    const q: ForgejoQueryLike = {
      isLoading: false,
      isError: false,
      data: { reason: 'some-newly-added-token-this-classifier-does-not-know' as never },
    }
    expect(classifyForgejo(q)).not.toBe('ok')
    expect(classifyForgejo(q)).toBe('error')
  })
})

describe('forgejoEmptyCopy', () => {
  it('never leaks a raw reason token as prose', () => {
    expect(forgejoEmptyCopy('unreachable', 'commits')).not.toContain('forgejo-unreachable')
    expect(forgejoEmptyCopy('partial', 'commits')).not.toContain('forgejo-partial')
  })

  it('the unconfigured copy states a next action, not just the fact (Art. 8)', () => {
    const copy = forgejoEmptyCopy('unconfigured', 'commits')
    expect(copy).toMatch(/administrator/)
  })

  it('partial and unreachable read as distinguishable, non-identical copy', () => {
    expect(forgejoEmptyCopy('partial', 'commits')).not.toBe(forgejoEmptyCopy('unreachable', 'commits'))
  })
})
