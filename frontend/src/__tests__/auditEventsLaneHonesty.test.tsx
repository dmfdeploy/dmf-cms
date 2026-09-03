/**
 * dmfdeploy/dmfdeploy#496, codex R496-A fix round (F4/F6/F7/F8): four
 * findings that all shipped as reasonable-looking code but were wrong in a
 * way only a real render/interaction proves. Each test here pins the
 * specific claim codex made about the previous version, so a regression
 * fails here rather than being re-discovered by a future gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import HistoryLane from '../pages/Activity/HistoryLane'
import { useActivityStore } from '../store/activity'
import type { AuditEventsResponse } from '../api/types'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
    expect(await screen.findByText(/No actions in your permitted view were recorded/)).toBeTruthy()
    expect(screen.queryByText(/No facility actions/)).toBeNull()
  })
})

describe('operator ruling 2026-09-03: the lane states its stopgap status plainly', () => {
  it('names the two limits that actually bite, without apologising or claiming unreliability', async () => {
    mkFetch(FAILED_DEPLOY_RESPONSE)
    renderHistory()
    await screen.findByText('The automation engine reported an error')
    expect(screen.getByText(/First implementation of this lane/)).toBeTruthy()
    expect(screen.getByText(/deploy and teardown show as\s*dispatched/)).toBeTruthy()
    expect(screen.getByText(/Coverage is bounded\s*by the window stated above/)).toBeTruthy()
    // STATE, don't apologise or overstate the weakness — Art. 8 register.
    expect(screen.queryByText(/[Ss]orry/)).toBeNull()
    expect(screen.queryByText(/incomplete/i)).toBeNull()
    expect(screen.queryByText(/unreliable/i)).toBeNull()
    expect(screen.queryByText(/forgeable/i)).toBeNull()
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
