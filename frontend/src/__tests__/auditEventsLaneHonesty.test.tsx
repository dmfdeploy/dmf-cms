/**
 * dmfdeploy/dmfdeploy#496, codex R496-A fix round (F4/F6/F7/F8): four
 * findings that all shipped as reasonable-looking code but were wrong in a
 * way only a real render/interaction proves. Each test here pins the
 * specific claim codex made about the previous version, so a regression
 * fails here rather than being re-discovered by a future gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import HistoryLane from '../pages/Activity/HistoryLane'
import { useActivityStore } from '../store/activity'
import type { AuditEventsResponse } from '../api/types'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function mkFetch(auditEvents: AuditEventsResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/audit/events')) return json(auditEvents)
      if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: '' })
      if (url.endsWith('/api/changes/commits')) return json({ repos: [], reason: '' })
      if (url.endsWith('/api/changes/pulls')) return json({ pulls: [], reason: '' })
      return json({})
    }),
  )
}

function renderHistory() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HistoryLane />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const FAILED_DEPLOY_RESPONSE: AuditEventsResponse = {
  reason: '',
  window: { known: true, seconds: 604800, reason: '' },
  capped: false,
  excluded: [],
  events: [
    {
      request_id: 'rid-1',
      class: 'deploy',
      action: 'deploy',
      target: 'wl-a',
      workload: 'wl-a',
      actor: 'alice',
      role: 'operator',
      reason: 'demo',
      at: '2026-09-03T00:00:00Z',
      at_ns: '1798000000000000000',
      outcome: {
        state: 'failed',
        headline: 'The automation engine reported an error',
        meaning: 'The action did not complete because the automation engine itself returned an error.',
        next_step: 'Contact a system engineer with the request id below.',
        detail: 'awx-error:503',
      },
    },
  ],
}

describe('F4: the default/expert split is a real DOM boundary, not just CSS muting', () => {
  it('the raw outcome token sits inside a <details> that starts closed', async () => {
    mkFetch(FAILED_DEPLOY_RESPONSE)
    renderHistory()
    await screen.findByText('The automation engine reported an error')

    // codex R496-A F4: "CSS muting is not an access boundary" — the raw
    // token must be behind a real disclosure, not merely styled small and
    // always rendered. <details>.open is the actual enforcement mechanism;
    // assert its structural state, not just text presence (jsdom does not
    // implement <details>'s native visual collapse, so a text-presence
    // check alone would pass whether or not the gate is real).
    const details = document.querySelector('details')
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false)
    expect(details?.textContent).toContain('awx-error:503')
  })

  it('expanding the disclosure reveals the raw token; meaning renders at default without expanding', async () => {
    mkFetch(FAILED_DEPLOY_RESPONSE)
    renderHistory()
    await screen.findByText('The automation engine reported an error')

    // codex R496-A F4's second half: `meaning` was silently never
    // rendered (only headline + next_step) — must be visible at default,
    // no interaction required.
    expect(screen.getByText(/automation engine itself returned an error/)).toBeTruthy()

    const summary = screen.getByText('Technical detail (for support)')
    fireEvent.click(summary)
    const details = document.querySelector('details')
    expect(details?.open).toBe(true)
  })

  it('an in-flight/succeeded detail is NOT gated — it is an ordinary word, not a raw error', async () => {
    const response: AuditEventsResponse = {
      ...FAILED_DEPLOY_RESPONSE,
      events: [
        {
          ...FAILED_DEPLOY_RESPONSE.events[0],
          request_id: 'rid-2',
          outcome: { state: 'in_flight', detail: 'dispatched' },
        },
      ],
    }
    mkFetch(response)
    renderHistory()
    await screen.findByText('dispatched')
    expect(document.querySelector('details')).toBeNull()
  })
})

describe('R496-C P1-2: a lost outcome renders as an honest unknown, never a forged verdict', () => {
  const UNKNOWN_RESPONSE: AuditEventsResponse = {
    ...FAILED_DEPLOY_RESPONSE,
    events: [
      {
        ...FAILED_DEPLOY_RESPONSE.events[0],
        request_id: 'rid-unknown',
        outcome: {
          state: 'unknown',
          headline: 'Outcome unknown',
          meaning: "This action's outcome could not be read from the record — it may have succeeded, failed, or still be in progress.",
          next_step: 'If this persists, contact a system engineer with the request id below.',
          detail: '',
        },
      },
    ],
  }

  it('renders "Outcome unknown", not "Failed", and never claims completion in the title', async () => {
    mkFetch(UNKNOWN_RESPONSE)
    renderHistory()
    // Badge AND headline both legitimately say "Outcome unknown" — assert
    // there are exactly two matches (not zero, not one drifted away),
    // rather than picking a single element out of an intentional pair.
    const matches = await screen.findAllByText('Outcome unknown')
    expect(matches).toHaveLength(2)
    expect(screen.queryByText('Failed')).toBeNull()
    expect(screen.getByText('Deploy — outcome unknown for wl-a')).toBeTruthy()
    expect(screen.queryByText(/^Deploy failed/)).toBeNull()
    expect(screen.queryByText(/^Deploy dispatched/)).toBeNull()
  })

  it('shows the plain-language explanation but no expert-detail disclosure (nothing to disclose)', async () => {
    mkFetch(UNKNOWN_RESPONSE)
    renderHistory()
    await screen.findAllByText('Outcome unknown')
    expect(screen.getByText(/could not be read from the record/)).toBeTruthy()
    // 'failed' is fine here — the meaning honestly lists it as ONE of
    // several possibilities, not an assertion. The <details> disclosure
    // itself is what must not exist, since there's no raw token to gate.
    expect(document.querySelector('details')).toBeNull()
  })
})

describe('F6: a bound that binds is disclosed', () => {
  it('capped:true renders a distinct notice, separate from the empty/error copy', async () => {
    mkFetch({ ...FAILED_DEPLOY_RESPONSE, capped: true })
    renderHistory()
    await screen.findByText('The automation engine reported an error')
    expect(screen.getByText(/may not be complete/)).toBeTruthy()
  })

  it('capped:false renders no such notice', async () => {
    mkFetch(FAILED_DEPLOY_RESPONSE)
    renderHistory()
    await screen.findByText('The automation engine reported an error')
    expect(screen.queryByText(/may not be complete/)).toBeNull()
  })
})

describe('F7: the facility panel never claims completeness across roles', () => {
  it('the panel subtext does not say "every operator"', async () => {
    mkFetch({ ...FAILED_DEPLOY_RESPONSE, events: [] })
    renderHistory()
    await screen.findByText(/No actions in your permitted view/)
    expect(screen.queryByText(/visible to every operator/)).toBeNull()
  })

  it('an empty, permitted-view read never says "no facility actions"', async () => {
    mkFetch({ ...FAILED_DEPLOY_RESPONSE, events: [] })
    renderHistory()
    expect(await screen.findByText(/No actions in your permitted view were found/)).toBeTruthy()
    expect(screen.queryByText(/No facility actions/)).toBeNull()
  })

  it('dmfdeploy/dmfdeploy#553: does not claim the empty result was "recorded" (a claim about Loki this read can\'t back)', async () => {
    // The bug this test pins: "were recorded" asserted knowledge about
    // the underlying Loki log that this read doesn't have -- a handful
    // of lines that fail to parse (legacy pre-fmt=2 shape, or a
    // genuinely corrupted line) are silently dropped in audit_events.py
    // and never counted toward `capped` unless enough accumulate to hit
    // the result-line ceiling, so events:[] capped:false can mean
    // something real existed and was excluded, not that nothing was
    // recorded. "Were found" only claims what this read actually knows.
    mkFetch({ ...FAILED_DEPLOY_RESPONSE, events: [] })
    renderHistory()
    expect(await screen.findByText(/No actions in your permitted view were found in this window/)).toBeTruthy()
    expect(screen.queryByText(/were recorded in this window/)).toBeNull()
  })
})

describe('operator ruling 2026-09-03: the lane states its stopgap status plainly', () => {
  it('names the two limits that actually bite, without apologising or claiming unreliability', async () => {
    mkFetch(FAILED_DEPLOY_RESPONSE)
    renderHistory()
    await screen.findByText('The automation engine reported an error')
    expect(screen.getByText(/First implementation of this lane/)).toBeTruthy()
    expect(screen.getByText(/an accepted\s*one is never updated with whether the job later finished/)).toBeTruthy()
    expect(screen.getByText(/Switch source normally carries a real succeeded or failed/)).toBeTruthy()
    expect(screen.getByText(/subject\s*to the same outcome-unknown case as any other record/)).toBeTruthy()
    expect(screen.getByText(/Coverage is bounded\s*by the window stated above/)).toBeTruthy()
    // STATE, don't apologise or overstate the weakness — Art. 8 register.
    expect(screen.queryByText(/[Ss]orry/)).toBeNull()
    expect(screen.queryByText(/incomplete/i)).toBeNull()
    expect(screen.queryByText(/unreliable/i)).toBeNull()
    expect(screen.queryByText(/forgeable/i)).toBeNull()
  })

  it('dmfdeploy/dmfdeploy#552: does not claim every refusal is recorded', async () => {
    // The bug this test pins: the copy said deploy/teardown record "any
    // immediate refusal" -- false, since a role or missing-reason
    // rejection returns before request_id is minted and writes no audit
    // line at all (live-confirmed, W1c step 4: a missing-reason attempt
    // left the event list byte-identical to its before-image). The
    // corrected clause narrows to what's actually true: a refusal after
    // the role and reason checks.
    mkFetch(FAILED_DEPLOY_RESPONSE)
    renderHistory()
    await screen.findByText('The automation engine reported an error')
    expect(screen.getByText(/any refusal after the role and reason checks/)).toBeTruthy()
    expect(screen.queryByText(/any immediate refusal/)).toBeNull()
  })

  it('dmfdeploy/dmfdeploy#553: does not claim truncation causes outcome-unknown', async () => {
    // The bug this test pins: the copy said the outcome-unknown case
    // applies "if the underlying log line is truncated" -- false, a
    // truncated/malformed line fails parse_awx_write_line and is dropped
    // before it ever reaches an outcome value at all. Unknown is reached
    // only by a complete, parseable line whose outcome field is blank.
    // The corrected clause names that cause instead.
    mkFetch(FAILED_DEPLOY_RESPONSE)
    renderHistory()
    await screen.findByText('The automation engine reported an error')
    expect(screen.getByText(/when its outcome field is blank/)).toBeTruthy()
    expect(screen.queryByText(/if the underlying log line is truncated/)).toBeNull()
  })

  it('codex F1: the statement does not claim deploy/teardown never render failed', async () => {
    // The bug this test pins: an earlier version said deploy/teardown
    // "show as dispatched, never as succeeded or failed" -- flatly false,
    // since a refused deploy renders failed right here in this same test
    // fixture (the acceptance-allowlist inversion is what makes it do
    // so, correctly). The corrected statement only claims what's true: an
    // ACCEPTED request is never updated with a later verdict.
    mkFetch(FAILED_DEPLOY_RESPONSE)
    renderHistory()
    const failedBadge = await screen.findByText('Failed')
    expect(failedBadge).toBeTruthy() // this row IS a rendered deploy failure
    expect(screen.queryByText(/never as succeeded or failed/)).toBeNull()
    expect(screen.queryByText(/show as\s*dispatched/)).toBeNull()
  })

  it('codex residual: a switch-source record with a blank outcome renders outcome unknown, not the exempted verdict', async () => {
    // The bug this test pins: the exemption clause was verified only
    // against 'active'/'degraded' — the two cases the clause itself named
    // — and never against blank, even though R496-C P1-2 established two
    // rounds ago that blank-outcome resolution runs BEFORE the
    // switch-source branch and yields 'unknown' for every class alike.
    // Render a blank-outcome switch-source row for real rather than
    // trusting the caveat's own enumeration of what it claims happens.
    // (dmfdeploy/dmfdeploy#553: not "truncated" — a truncated/malformed
    // line fails to parse and is dropped before reaching an outcome at
    // all; this is a complete line whose outcome field is blank.)
    const response: AuditEventsResponse = {
      ...FAILED_DEPLOY_RESPONSE,
      events: [
        {
          request_id: 'rid-switch-unknown',
          class: 'switch-source',
          action: 'switch-source',
          target: 'wl-b',
          workload: null,
          actor: 'erin',
          role: 'engineer',
          reason: 'demo',
          at: '2026-09-03T00:00:00Z',
          at_ns: '1798000000000000001',
          outcome: {
            state: 'unknown',
            headline: 'Outcome unknown',
            meaning:
              "This action's outcome could not be read from the record — it may have succeeded, failed, or still be in progress.",
            next_step: 'If this persists, contact a system engineer with the request id below.',
            detail: '',
          },
        },
      ],
    }
    mkFetch(response)
    renderHistory()
    expect(await screen.findByText('Switch source on wl-b — outcome unknown')).toBeTruthy()
    // The corrected clause must not claim switch-source is unconditionally
    // exempt from the unknown case — it differs from deploy/teardown in
    // KIND (a real verdict is possible), not in being immune to this case.
    expect(screen.queryByText(/Switch source is the exception:\s*it carries a real/)).toBeNull()
  })
})

describe('F8: the local panel never claims completion for a dispatch-time record', () => {
  it('finalise-purge and launch render as requested, not as a confirmed past-tense outcome', async () => {
    mkFetch({ ...FAILED_DEPLOY_RESPONSE, events: [] })
    window.localStorage.setItem(
      'dmf-console-activity',
      JSON.stringify({
        state: {
          records: [
            {
              request_id: 'local-purge-1',
              action: 'finalise-purge',
              target: 'wl-z',
              reason: 'demo',
              actor: 'carol',
              role: 'operator',
              at: '2026-09-03T00:00:00Z',
              outcome: 'dispatched',
            },
            {
              request_id: 'local-launch-1',
              action: 'launch',
              target: 'some-jt',
              reason: 'demo',
              actor: 'dave',
              role: 'engineer',
              at: '2026-09-03T00:00:00Z',
              outcome: 'dispatched',
            },
          ],
        },
        version: 0,
      }),
    )
    // The store is a module-level singleton created (and hydrated once)
    // when store/activity.ts first loads — which already happened via
    // this file's top-level `import HistoryLane`, before the localStorage
    // write above. Force the SAME read `persist.rehydrate()` performs on
    // every real page load, same technique as
    // activityReconcileExpectationHonesty.test.tsx's fix-round 1 lesson —
    // setting localStorage alone does not retroactively repopulate memory.
    await useActivityStore.persist.rehydrate()

    renderHistory()
    const localPanel = (await screen.findByText("This browser's own actions")).closest('.panel') as HTMLElement
    expect(within(localPanel).getByText('Requested permanent deletion of wl-z')).toBeTruthy()
    expect(within(localPanel).getByText('Requested workflow launch: some-jt')).toBeTruthy()
    expect(within(localPanel).queryByText(/^Deleted wl-z permanently$/)).toBeNull()
    expect(within(localPanel).queryByText(/^Launched some-jt$/)).toBeNull()
  })
})

describe('lkirc: request_id is not a per-row React key (a single request can produce multiple rows)', () => {
  // main.py:488/:580 (an L3 preflight's own capacity-skipped/capacity-
  // override line) and main.py:4868 (that same request's later dispatched
  // line) share ONE request_id. Two sibling rows with the same key make
  // React reconciliation unstable across a refetch -- the property under
  // test is NOT "keys are unique" (that's the mechanism), it's that a
  // multi-row request survives a refetch without rows swapping content.
  const rowA = {
    request_id: 'rid-shared', class: 'deploy' as const, action: 'deploy', target: 'wl-a',
    workload: 'wl-a', actor: 'alice', role: 'operator', reason: 'demo',
    at: '2026-09-03T00:00:00.000Z', at_ns: '1798000000000000001',
    outcome: { state: 'in_flight' as const, detail: 'capacity-skipped' },
  }
  const rowB = {
    request_id: 'rid-shared', class: 'deploy' as const, action: 'deploy', target: 'wl-a',
    workload: 'wl-a', actor: 'alice', role: 'operator', reason: 'demo',
    at: '2026-09-03T00:00:05.000Z', at_ns: '1798000000005000002',
    outcome: { state: 'in_flight' as const, detail: 'dispatched' },
  }
  const BASE: AuditEventsResponse = {
    reason: '', window: { known: true, seconds: 604800, reason: '' }, capped: false, excluded: [],
    events: [rowB, rowA], // newest-first, matching the real endpoint's own sort
  }

  function mkSequentialFetch(responses: AuditEventsResponse[]) {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/audit/events')) {
          const body = responses[Math.min(call, responses.length - 1)]
          call += 1
          return json(body)
        }
        if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: '' })
        if (url.endsWith('/api/changes/commits')) return json({ repos: [], reason: '' })
        if (url.endsWith('/api/changes/pulls')) return json({ pulls: [], reason: '' })
        return json({})
      }),
    )
  }

  it('both rows render distinctly on first load', async () => {
    mkSequentialFetch([BASE])
    renderHistory()
    expect(await screen.findByText('capacity-skipped')).toBeTruthy()
    expect(screen.getByText('dispatched')).toBeTruthy()
  })

  it('a multi-row request survives a refetch without rows swapping content', async () => {
    vi.useFakeTimers()
    // The realistic refetch shape: the audit trail is append-only, so a
    // request's SECOND row (the later dispatch) genuinely does not exist
    // yet on an earlier poll -- the list GROWS from one row to two
    // sharing the same request_id, not just re-reads the same two. This
    // is also empirically the shape that actually exercises React's own
    // reconciliation of the duplicate key (a stable two-row re-fetch does
    // not, since props at each position are unchanged either way and
    // React always renders from the new element's own props regardless
    // of which fiber it reuses -- verified directly before trusting this
    // shape, not assumed).
    const firstPoll: AuditEventsResponse = { ...BASE, events: [rowA] }
    const secondPoll: AuditEventsResponse = { ...BASE, events: [rowB, rowA] }
    mkSequentialFetch([firstPoll, secondPoll])

    const seenErrors: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...args: unknown[]) => {
      seenErrors.push(args)
    }

    try {
      renderHistory()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60)
      })
      expect(screen.getByText('capacity-skipped')).toBeTruthy()
      expect(screen.queryByText('dispatched')).toBeNull() // not dispatched yet on this poll

      // Past useAuditEvents' 30s refetchInterval -- the list grows.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_100)
      })
    } finally {
      console.error = originalConsoleError
    }

    // Both distinguishing details present, each exactly once -- not
    // merged, not dropped, not duplicated onto one row.
    expect(screen.getAllByText('capacity-skipped')).toHaveLength(1)
    expect(screen.getAllByText('dispatched')).toHaveLength(1)
    const titles = screen.getAllByText(/^Deploy dispatched for wl-a$/)
    expect(titles).toHaveLength(2)

    // The actual mechanism, checked directly rather than inferred from
    // rendered text alone (which stays correct either way for these
    // stateless rows -- confirmed by reverting the fix and observing the
    // same text assertions above still pass): React itself must not have
    // logged a duplicate-key warning across the growth from one row to
    // two sharing a request_id.
    const duplicateKeyWarning = seenErrors.find((args) =>
      typeof args[0] === 'string' && args[0].includes('two children with the same key'),
    )
    expect(duplicateKeyWarning).toBeUndefined()
  })
})

describe('lkirc P2 (dmfdeploy/dmf-cms#140, 2026-09-04): an untrustworthy reason token fails closed, never open', () => {
  // classifyAuditEvents defaulted an unrecognised OR absent reason to 'ok'
  // -- absence presented as an assertion, in the very classifier that
  // decides what the operator is told, the exact thing this lane exists
  // to prevent. apiCall's generic return type is a compile-time cast, not
  // runtime response validation, so a malformed response or a future
  // reason token this frontend doesn't yet recognise must fail CLOSED
  // (the "could not be loaded" state), never open into the authoritative
  // "no actions were recorded" claim. Same shape as classifyForgejo
  // (changesState.ts): only an EXACT '' authorises 'ok'. Asserted against
  // what HistoryLane actually RENDERS, not the phase constant -- the
  // phase is the mechanism, the rendered claim is the property.

  it('an unrecognised reason token renders "could not be loaded", never the empty-result claim', async () => {
    // Cast deliberately: `reason` is a closed string-literal union at
    // compile time, but nothing at RUNTIME guarantees the backend (or a
    // future version skew) only ever sends one of those three values --
    // that gap is lkirc's exact point.
    mkFetch({
      ...FAILED_DEPLOY_RESPONSE,
      reason: 'some-future-token-this-frontend-does-not-know-yet',
      events: [],
    } as unknown as AuditEventsResponse)
    renderHistory()
    expect(await screen.findByText(/Facility history could not be loaded/)).toBeTruthy()
    expect(screen.queryByText(/No actions in your permitted view/)).toBeNull()
  })

  it('a response missing the reason field entirely renders the same, never the empty-result claim', async () => {
    // Deliberately NOT built via a spread of a well-formed response --
    // `reason` is omitted outright, simulating the real gap: nothing at
    // runtime guarantees the backend (or a proxy, or a future version
    // skew) always sends it.
    const malformed = {
      window: FAILED_DEPLOY_RESPONSE.window,
      capped: false,
      excluded: [],
      events: [],
    } as unknown as AuditEventsResponse
    mkFetch(malformed)
    renderHistory()
    expect(await screen.findByText(/Facility history could not be loaded/)).toBeTruthy()
    expect(screen.queryByText(/No actions in your permitted view/)).toBeNull()
  })

  it('control: reason === "" still renders the genuine empty-result claim', async () => {
    mkFetch({ ...FAILED_DEPLOY_RESPONSE, reason: '', events: [] })
    renderHistory()
    expect(await screen.findByText(/No actions in your permitted view were found/)).toBeTruthy()
    expect(screen.queryByText(/Facility history could not be loaded/)).toBeNull()
  })
})
