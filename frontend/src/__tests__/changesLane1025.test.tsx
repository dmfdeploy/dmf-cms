/**
 * Case list: docs/changes-forgejo-cases.md. Row ids in test names refer to it.
 *
 * Component layer (C) for the constructed-payload rows of the case list for
 * dmfdeploy/dmfdeploy#1025: the console API, the classifier, retained rows after
 * a failed refetch, and replies from an older server (rows X, O and E7).
 *
 * The backend cannot produce every reason beside rows, so these tests build the
 * payloads by hand and feed them to the real History lane. Each test name starts
 * with the row id. The commits panel runs the same rows with `kind` set to
 * commits, except where a row is about pull requests only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, waitFor } from '@testing-library/react'
import { classifyForgejo, type ForgejoQueryLike } from '../lib/changesState'
import {
  expectedLane,
  laneOf,
  panelOf,
  renderLane,
  settled,
  type Kind,
  type Served,
} from './changesLaneKit'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

interface Spec {
  reason?: string | null // null leaves the field out
  rows?: number
  d?: number
  s?: number
  i?: boolean
  omit?: ('d' | 's' | 'i')[]
}

const PULL = { repo: 'dmf/a', number: 1, title: 't', state: 'open', author: 'a', created: '', url: '' }

function payload(kind: Kind, spec: Spec): Record<string, unknown> {
  const rows = spec.rows ?? 0
  const body: Record<string, unknown> =
    kind === 'pulls'
      ? { pulls: Array.from({ length: rows }, () => PULL) }
      : { repos: Array.from({ length: rows }, () => ({ name: 'dmf/a', commits: [] })) }
  if (spec.reason !== null) body.reason = spec.reason ?? ''
  const omit = spec.omit ?? []
  if (kind === 'pulls' && !omit.includes('d')) body.disabled_repos = spec.d ?? 0
  if (!omit.includes('s')) body.skipped_repos = spec.s ?? 0
  if (!omit.includes('i')) body.repos_maybe_incomplete = spec.i ?? false
  return body
}

function served(kind: Kind, body: unknown): Served {
  const idle = { commits: { repos: [], reason: '' }, pulls: { pulls: [], reason: '' } }
  return { ...idle, [kind]: body }
}

interface Row {
  id: string
  spec: Spec
  lane: string[]
  pullsOnly?: boolean
}

const STATIC_ROWS: Row[] = [
  { id: 'X3', spec: { reason: 'forgejo-unconfigured' }, lane: ['UNCONF'] },
  { id: 'X3b', spec: { reason: 'forgejo-unconfigured', rows: 1 }, lane: ['UNCONF', 'ROWS'] },
  { id: 'X4a', spec: { reason: 'forgejo-from-the-future' }, lane: ['LOADERR'] },
  { id: 'X4b', spec: { reason: 'forgejo-from-the-future', rows: 1 }, lane: ['LOADERR', 'ROWS'] },
  { id: 'X4c.no-rows', spec: { reason: null }, lane: ['LOADERR'] },
  { id: 'X4c.rows', spec: { reason: null, rows: 1 }, lane: ['LOADERR', 'ROWS'] },
  { id: 'X5a', spec: { reason: 'forgejo-read-failed' }, lane: ['READFAIL'] },
  { id: 'X5b', spec: { reason: 'forgejo-read-failed', rows: 1 }, lane: ['READFAIL', 'ROWS'] },
  { id: 'X5c', spec: { reason: 'forgejo-unreachable', rows: 1 }, lane: ['UNREACH', 'ROWS'] },
  { id: 'X5d', spec: { reason: 'forgejo-pulls-disabled', rows: 1, d: 1 }, lane: ['ALLOFF', 'ROWS'], pullsOnly: true },
  { id: 'X5e', spec: { reason: 'forgejo-partial', rows: 1 }, lane: ['PARTIAL', 'ROWS'] },
  {
    id: 'X6',
    spec: { reason: 'forgejo-read-failed', d: 2, s: 1, i: true },
    lane: ['READFAIL', 'SOMEOFF', 'SKIPPED:1', 'INCOMPLETE'],
  },
  {
    id: 'X7',
    spec: { reason: 'forgejo-pulls-disabled', d: 3, i: true },
    lane: ['ALLOFF', 'INCOMPLETE'],
    pullsOnly: true,
  },
  // Replies from an older server: the new fields are absent and read as 0 and false.
  { id: 'O1', spec: { omit: ['s', 'i'] }, lane: ['EMPTY'], pullsOnly: true },
  { id: 'O2', spec: { rows: 1, omit: ['d'] }, lane: ['ROWS'], pullsOnly: true },
  { id: 'O3', spec: { reason: 'forgejo-partial', omit: ['d', 's', 'i'] }, lane: ['PARTIAL'], pullsOnly: true },
  { id: 'O6', spec: { reason: 'forgejo-unreachable', omit: ['d', 's', 'i'] }, lane: ['UNREACH'] },
  // E7: every notice at once, in the the case list's order, above the rows.
  {
    id: 'E7.partial',
    spec: { reason: 'forgejo-partial', rows: 1, d: 2, s: 3, i: true },
    lane: ['PARTIAL', 'SOMEOFF', 'SKIPPED:3', 'INCOMPLETE', 'ROWS'],
  },
  {
    id: 'E7.read-failed',
    spec: { reason: 'forgejo-read-failed', rows: 1, d: 2, s: 3, i: true },
    lane: ['READFAIL', 'SOMEOFF', 'SKIPPED:3', 'INCOMPLETE', 'ROWS'],
  },
]

// The commits panel has no disabled-repository notice: its route never sends the field.
const COMMITS_ONLY: Row[] = [
  { id: 'O4', spec: { omit: ['s', 'i'] }, lane: ['EMPTY'] },
  { id: 'O5', spec: { rows: 1, omit: ['s', 'i'] }, lane: ['ROWS'] },
]

describe.each(['pulls', 'commits'] as Kind[])('%s panel: constructed payloads', (kind) => {
  const rows = [...STATIC_ROWS, ...(kind === 'commits' ? COMMITS_ONLY : [])]
    .filter((r) => kind === 'pulls' || !r.pullsOnly)
  it.each(rows.map((r) => [r.id, r] as const))('%s', async (_id, row) => {
    const body = payload(kind, row.spec)
    // The commits route never reports disabled repositories.
    const lane = row.lane.filter((t) => kind === 'pulls' || t !== 'SOMEOFF')
    renderLane(served(kind, body))
    const panel = await settled(kind)
    const rowCount = row.spec.rows ?? 0
    expect(laneOf(panel)).toEqual(expectedLane(lane, kind, rowCount))
  })

  it('X1: the console API call fails on first load, so the lane says it could not load and never says empty', async () => {
    renderLane({ commits: {}, pulls: {}, failing: true })
    const panel = await settled(kind)
    expect(laneOf(panel)).toEqual(expectedLane(['LOADERR'], kind, 0))
  })

  async function failedRefetch(first: Spec): Promise<string[]> {
    const s = served(kind, payload(kind, first)) as Served
    const { queryClient } = renderLane(s)
    await settled(kind)
    s.failing = true
    await queryClient.refetchQueries({ queryKey: ['changes', kind] })
    await waitFor(() => expect(laneOf(panelOf(kind))[0]).toContain('could not be loaded'))
    return laneOf(panelOf(kind))
  }

  it('X2: a refetch fails after a good read with rows, so the retained rows stay under a load error', async () => {
    expect(await failedRefetch({ rows: 1 })).toEqual(expectedLane(['LOADERR', 'ROWS'], kind, 1))
  })

  it('X2b: the retained counts stay after a failed refetch because they describe the retained rows', async () => {
    const tokens = ['LOADERR', 'SOMEOFF', 'SKIPPED:1', 'INCOMPLETE', 'ROWS'].filter(
      (t) => kind === 'pulls' || t !== 'SOMEOFF',
    )
    expect(await failedRefetch({ rows: 1, d: 2, s: 1, i: true })).toEqual(expectedLane(tokens, kind, 1))
  })

  it('X2c: a refetch fails after a failed read with no rows, so only the load error shows', async () => {
    expect(await failedRefetch({ reason: 'forgejo-read-failed' })).toEqual(
      expectedLane(['LOADERR'], kind, 0),
    )
  })
})

describe('a reason the console does not know fails closed', () => {
  it('X8: the classifier answers error, never ok, for a token it has not seen', () => {
    const q: ForgejoQueryLike = {
      isLoading: false,
      isError: false,
      data: { reason: 'forgejo-from-the-future' } as never,
    }
    expect(classifyForgejo(q)).toBe('error')
  })
})
