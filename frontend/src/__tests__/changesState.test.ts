/**
 * classifyForgejo / forgejoEmptyCopy and classifyChanges / changesEmptyCopy
 * — pure classifier unit tests (fix-round on umbrella #385 PR #81).
 *
 * Component-level coverage of the same defect class lives in
 * mediaWorkloadsGrid.test.tsx and facility.test.tsx (hold-then-reject
 * through real TanStack Query retention); these are the precise,
 * fast-to-reason-about pins on the classifier itself — the exact input
 * shape react-query hands it once a background refetch has settled into
 * error with prior data still retained.
 *
 * classifyChanges/changesEmptyCopy moved here from recentChanges.test.tsx
 * (dmfdeploy/dmfdeploy#419/#554): that file's own component-level coverage
 * mounted the Workspace RecentChanges widget directly, which is now deleted
 * (replaced by ActivityPanel, over /api/audit/events — a different
 * classifier entirely, see auditEventsLaneHonesty.test.tsx). The classifier
 * these two functions back is still live — HistoryLane.tsx's own Recent
 * Jobs panel — component-level regression coverage for it (retained-error
 * notice, title/badge outcome agreement) already lives independently in
 * activityLaneHonesty.test.tsx, so nothing here duplicates it; only the
 * pure-function pins move.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyChanges,
  changesEmptyCopy,
  classifyForgejo,
  forgejoEmptyCopy,
  type ForgejoQueryLike,
} from '../lib/changesState'

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

describe('classifyChanges', () => {
  const base = { isLoading: false, isError: false }

  it('maps each backend token to its own phase', () => {
    expect(classifyChanges({ ...base, data: { jobs: [], reason: '' } }).phase).toBe('ok')
    expect(classifyChanges({ ...base, data: { jobs: [], reason: 'awx-not-running' } }).phase).toBe('not-running')
    expect(classifyChanges({ ...base, data: { jobs: [], reason: 'awx-unreachable' } }).phase).toBe('unreachable')
    expect(classifyChanges({ ...base, data: { jobs: [], reason: 'awx-unconfigured' } }).phase).toBe('unconfigured')
  })

  it('treats a payload with no reason field as ok (older payloads/fixtures)', () => {
    expect(classifyChanges({ ...base, data: { jobs: [] } }).phase).toBe('ok')
  })

  it('reports a genuine console API failure as error', () => {
    expect(classifyChanges({ isLoading: false, isError: true }).phase).toBe('error')
  })

  it('reports loading only before any data arrives', () => {
    expect(classifyChanges({ isLoading: true, isError: false }).phase).toBe('loading')
    expect(classifyChanges({ isLoading: true, isError: false, data: { jobs: [], reason: '' } }).phase).toBe('ok')
  })
})

describe('changesEmptyCopy', () => {
  it('never claims AWX is asleep — we cannot know that', () => {
    // The only authoritative discriminator is spec.replicas, which the
    // console does not read. Guard the wording, not just the token.
    for (const phase of ['not-running', 'unreachable', 'unconfigured', 'error', 'ok'] as const) {
      expect(changesEmptyCopy(phase).toLowerCase()).not.toContain('asleep')
      expect(changesEmptyCopy(phase).toLowerCase()).not.toContain('sleep')
    }
  })

  it('gives every phase distinct copy', () => {
    const all = (['not-running', 'unreachable', 'unconfigured', 'error', 'ok'] as const).map(changesEmptyCopy)
    expect(new Set(all).size).toBe(all.length)
  })
})
