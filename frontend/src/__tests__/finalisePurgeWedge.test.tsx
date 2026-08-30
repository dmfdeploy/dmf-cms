/**
 * Delete permanently (umbrella #347 WO-A2b-2, operator ruling 2026-08-02) —
 * a wedge-style FinaliseStage test in the same idiom as
 * workloadSetupStageWedge.test.tsx: full WorkloadSetup render, real fetch
 * mocking, driving the write to a REAL completion signal rather than
 * stopping at "the POST fired".
 *
 * Proves, end-to-end:
 *  - the action is offered only under the member-state conditions
 *    workloadLifecycle.test.ts pins in isolation (negative cases here too,
 *    against the REAL wiring from WorkloadSetup down);
 *  - arm -> typed-slug + reason -> POST carries {confirm, reason};
 *  - completion (operation reaches run_complete) invalidates
 *    ['media-workloads-grouped'] and ['catalog'], renders the confirmed-
 *    absent provenance (purge_verified_at), and the UI's absence claim
 *    itself comes from the REFRESHED grouped read no longer listing the
 *    workload — never asserted independently of that read.
 *
 * GUARD LABEL (dmfdeploy#414 gate, round 1): every test in this file is a
 * GUARD pinning the pre-#414 umbrella #347 WO-A2b-2 delete-permanently
 * contract described above, unchanged by this arc — only the mount route
 * moved, from the bare slug to /setup. Baseline: the pre-#414 commit on
 * `main`, where these same assertions passed identically against
 * WorkloadDetail.tsx at the bare slug.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import { useActivityStore } from '../store/activity'
import type { MediaWorkload, MediaWorkloadsGroupedResponse, UserIdentity } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// umbrella dmfdeploy/dmfdeploy#378b: every scenario here is about the
// MEMBER-STATE gates (this file's whole point, per the docstring above), so
// the acting user is a role the purge endpoint's own floor
// (_require_min_role(request, "operator")) accepts — the authorization gate
// itself is pinned separately in workloadSetup.test.tsx and
// workloadLifecycle.test.ts.
const OPERATOR: UserIdentity = {
  subject: 'ops',
  display_name: 'Ops',
  email: 'ops@dmf.example.com',
  role: 'operator',
  real_role: 'operator',
  view_as_active: false,
  groups: [],
  awx_configured: true,
  authentik_configured: true,
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/media-workloads/studio-a/setup']}>
        <Routes>
          <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return queryClient
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Media workload lifecycle' })
}

function stageSection(label: string): HTMLElement {
  return screen.getByRole('heading', { name: label, level: 2 }).closest('[data-step-state]') as HTMLElement
}

function eligibleWorkload(overrides: Partial<MediaWorkload> = {}): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [
      {
        instance: 'studio-a-1',
        netbox_id: 1,
        function_key: 'crosspoint',
        requested_state: 'bootstrapped',
        observed_state: 'unknown',
        reconcile_pending: false,
        placement: { node: 'node-1', ports: [], protocol: null },
        workload_assignment: 'ok',
      },
    ],
    functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Finalise & Review: delete permanently drives to a real completion', () => {
  it('arms, types the slug, confirms, and on run_complete invalidates + renders confirmed-absent provenance', async () => {
    let wl: MediaWorkload | null = eligibleWorkload()
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true,
      degraded: false,
      scope: [],
      get workloads() { return wl ? [wl] : [] },
      invalid_instances: [],
    }
    let purgeCalls = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(OPERATOR)
        if (url.endsWith('/api/catalog')) return json({ entries: [] })
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        if (url.match(/\/api\/media-workloads\/studio-a\/purge$/)) {
          purgeCalls += 1
          expect(init?.method).toBe('POST')
          expect(JSON.parse(init?.body as string)).toEqual({ confirm: 'studio-a', reason: 'confirmed clean' })
          // The real world has already changed by the time the operation
          // reaches run_complete (below) — the grouped read reflects that.
          wl = null
          return json({
            operation_id: 'op-1', action: 'finalise-purge', target: 'studio-a', state: 'launching',
            job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-purge-1',
          })
        }
        if (url.endsWith('/api/operations/op-1')) {
          return json({
            operation_id: 'op-1', action: 'finalise-purge', target: 'studio-a', state: 'run_complete',
            job_id: 4242, error: null, l3_outcome: 'success', purge_verified_at: '2026-08-03T12:00:00Z',
            created_at: 't0', updated_at: 't1',
          })
        }
        return json({})
      }),
    )

    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    fireEvent.click(await waitFor(() => within(rail()).getByRole('button', { name: 'Finalise & Review' })))
    const finalise = stageSection('Finalise & Review')

    fireEvent.click(await within(finalise).findByRole('button', { name: 'Delete permanently' }))
    fireEvent.change(within(finalise).getByPlaceholderText(/Reason \(required/), {
      target: { value: 'confirmed clean' },
    })
    fireEvent.change(within(finalise).getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
    fireEvent.click(within(finalise).getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(purgeCalls).toBe(1))

    // umbrella #378 fix round 2: actor/role for the audit record now come
    // from a prop threaded down from WorkloadWizard's own userQuery, not
    // FinaliseStage's own (now-removed) useCurrentUser() subscription —
    // this is the one thing that move could silently get wrong (an
    // 'unknown'/'unknown' record instead of the real actor), and the whole
    // point of these fields is accountability, so it gets its own assertion
    // rather than riding along implicitly.
    const purgeRecord = useActivityStore.getState().records.find((r) => r.request_id === 'req-purge-1')
    expect(purgeRecord?.actor).toBe('ops')
    expect(purgeRecord?.role).toBe('operator')

    // Confirmed-absent provenance renders, sourced from the terminal
    // Operation's own purge_verified_at — never fabricated locally.
    await within(finalise).findByText(/Deleted permanently — confirmed absent/)
    expect(within(finalise).getByText(/2026-08-03T12:00:00Z/)).toBeTruthy()

    // The absence claim itself: the refreshed grouped read no longer lists
    // the workload — the completion effect's own invalidateQueries call is
    // what makes this refetch happen, not a locally-asserted "it's gone".
    await waitFor(() => expect(screen.getByText(/Workload not found/)).toBeTruthy())
  })

  it('renders the failure honestly (never a fake success) when the operation does not complete cleanly', async () => {
    const wl = eligibleWorkload()
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true, degraded: false, scope: [],
      workloads: [wl], invalid_instances: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(OPERATOR)
        if (url.endsWith('/api/catalog')) return json({ entries: [] })
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        if (url.match(/\/api\/media-workloads\/studio-a\/purge$/) && (init?.method ?? 'GET') === 'POST') {
          return json({
            operation_id: 'op-2', action: 'finalise-purge', target: 'studio-a', state: 'launching',
            job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-purge-2',
          })
        }
        if (url.endsWith('/api/operations/op-2')) {
          return json({
            operation_id: 'op-2', action: 'finalise-purge', target: 'studio-a', state: 'run_failed',
            job_id: 4242, error: 'purge-incomplete:residue-present', l3_outcome: 'success',
            purge_verified_at: null, created_at: 't0', updated_at: 't1', request_id: 'req-purge-2',
          })
        }
        return json({})
      }),
    )

    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    fireEvent.click(await waitFor(() => within(rail()).getByRole('button', { name: 'Finalise & Review' })))
    const finalise = stageSection('Finalise & Review')

    fireEvent.click(await within(finalise).findByRole('button', { name: 'Delete permanently' }))
    fireEvent.change(within(finalise).getByPlaceholderText(/Reason \(required/), { target: { value: 'go' } })
    fireEvent.change(within(finalise).getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
    fireEvent.click(within(finalise).getByRole('button', { name: 'Delete permanently' }))

    await within(finalise).findByText(/did not complete — purge-incomplete:residue-present/)
    // Never a fake success, never "retrying".
    expect(within(finalise).queryByText(/Deleted permanently/)).toBeNull()
    expect(within(finalise).queryByText(/[Rr]etrying/)).toBeNull()
  })

  // umbrella #407: failed_rollback_required and rollback_incomplete are in
  // useOperationStatus's own _WATCHED_TERMINAL_STATES (so polling stops
  // there) but were MISSING from FinaliseStage's separate, hand-maintained
  // PURGE_TERMINAL_STATES — so the completion effect (FinaliseStage.tsx)
  // never fired for either one: purgeOpId stayed set forever (busy stuck
  // permanently, no self-recovery), and purgeReview was never populated, so
  // the operator was never shown what actually happened. These guard the
  // fix: PURGE_TERMINAL_STATES now derives from the same
  // _WATCHED_TERMINAL_STATES useOperationStatus itself polls to, so the two
  // sets cannot drift apart again the same way. 'error' is included too —
  // mutation-tested while fixing #407 (breaking just the union's 'error'
  // member, leaving everything else correct) and found genuinely
  // UNCOVERED by every pre-existing test in this suite: the whole 677-test
  // frontend suite stayed green with 'error' silently dropped. It is the
  // one member of the union that is NOT itself a member of the exported
  // _WATCHED_TERMINAL_STATES (see that derivation's own comment in
  // FinaliseStage.tsx), so it is also the one case none of the other two
  // could have caught by construction.
  it.each([
    {
      state: 'failed_rollback_required' as const,
      error: null,
      l3_outcome: 'rollback-required-manual',
      expectedText: /did not complete — rollback-required-manual/,
    },
    {
      state: 'rollback_incomplete' as const,
      error: null,
      l3_outcome: null,
      // Neither error nor l3_outcome is set — the review falls all the way
      // back to the bare state name, the third leg of `error ?? l3_outcome
      // ?? state` (Art. 8: whatever the backend actually recorded, never a
      // fake success, never silently swallowed).
      expectedText: /did not complete — rollback_incomplete/,
    },
    {
      state: 'error' as const,
      error: 'launch-failed:awx-unreachable',
      l3_outcome: null,
      expectedText: /did not complete — launch-failed:awx-unreachable/,
    },
  ])(
    'closes out a delete-permanently operation that settles at $state — clears the busy state and renders the outcome honestly',
    async ({ state, error, l3_outcome, expectedText }) => {
      const wl = eligibleWorkload()
      const grouped: MediaWorkloadsGroupedResponse = {
        configured: true, degraded: false, scope: [], workloads: [wl], invalid_instances: [],
      }
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = (typeof input === 'string' ? input : (input as Request).url).toString()
          if (url.endsWith('/api/me')) return json(OPERATOR)
          if (url.endsWith('/api/catalog')) return json({ entries: [] })
          if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
          if (url.match(/\/api\/media-workloads\/studio-a\/purge$/) && (init?.method ?? 'GET') === 'POST') {
            return json({
              operation_id: 'op-wedge', action: 'finalise-purge', target: 'studio-a', state: 'launching',
              job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-purge-wedge',
            })
          }
          if (url.endsWith('/api/operations/op-wedge')) {
            return json({
              operation_id: 'op-wedge', action: 'finalise-purge', target: 'studio-a', state,
              job_id: 4242, error, l3_outcome, purge_verified_at: null,
              created_at: 't0', updated_at: 't1', request_id: 'req-purge-wedge',
            })
          }
          return json({})
        }),
      )

      renderDetail()
      await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
      fireEvent.click(await waitFor(() => within(rail()).getByRole('button', { name: 'Finalise & Review' })))
      const finalise = stageSection('Finalise & Review')

      fireEvent.click(await within(finalise).findByRole('button', { name: 'Delete permanently' }))
      fireEvent.change(within(finalise).getByPlaceholderText(/Reason \(required/), { target: { value: 'go' } })
      fireEvent.change(within(finalise).getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
      fireEvent.click(within(finalise).getByRole('button', { name: 'Delete permanently' }))

      // Busy panel shows while the operation is in flight.
      await within(finalise).findByText(/Deleting.*permanently/)

      // The completion effect fires: the review renders the honest outcome...
      await within(finalise).findByText(expectedText)
      // ...and NEVER a fake success.
      expect(within(finalise).queryByText(/Deleted permanently/)).toBeNull()

      // purgeOpId is cleared — the busy panel is gone (pre-fix, this never
      // happened for either state: the busy panel stayed forever).
      expect(within(finalise).queryByText(/Deleting.*permanently/)).toBeNull()
    },
  )

  it('is NOT offered while a member is observed running', async () => {
    const runningMember = eligibleWorkload({
      instances: [
        {
          instance: 'studio-a-1', netbox_id: 1, function_key: 'crosspoint',
          requested_state: 'active', observed_state: 'running', reconcile_pending: false,
          placement: { node: 'node-1', ports: [], protocol: null }, workload_assignment: 'ok',
        },
      ],
    })
    const groupedRunning: MediaWorkloadsGroupedResponse = {
      configured: true, degraded: false, scope: [], workloads: [runningMember], invalid_instances: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(OPERATOR)
        if (url.endsWith('/api/catalog')) return json({ entries: [] })
        if (url.endsWith('/api/media-workloads/grouped')) return json(groupedRunning)
        return json({})
      }),
    )
    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    // lifecycle=provision with an active+running member is CONFIGURE
    // position, not off-flow — but regardless of position, delete-
    // permanently must not appear anywhere while a member is running.
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull()
  })

  it('is withdrawn during a genuinely pending background refetch (isFetching), even though the retained payload is still eligible', async () => {
    // umbrella #347 fix round FIX-A2b.4 (GATE-A2b.3, P2-3): the prior
    // version of this test only ever supplied a COMPLETED response and
    // never actually constructed a pending fetch — react-query's own
    // isFetching never went true, so it never exercised
    // WorkloadSetup.tsx's `!isError && !isFetching` gate at all. This one
    // does: the grouped query resolves once (eligible), then a SECOND
    // fetch (triggered by invalidateQueries, mirroring the exact "next
    // background poll" pattern workloadSetupStageWedge.test.tsx already
    // uses) is held open indefinitely — react-query keeps the PREVIOUS
    // (still-eligible) payload in `data` while `isFetching` is true, and
    // the button must disappear anyway.
    const wl = eligibleWorkload()
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true, degraded: false, scope: [], workloads: [wl], invalid_instances: [],
    }
    let fetchCount = 0
    const refetchControl: { resolve: (() => void) | null } = { resolve: null }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(OPERATOR)
        if (url.endsWith('/api/catalog')) return json({ entries: [] })
        if (url.endsWith('/api/media-workloads/grouped')) {
          fetchCount += 1
          if (fetchCount === 1) return json(grouped)
          // The refetch: genuinely held open — this IS what makes
          // isFetching true for the duration of this test, not a stand-in.
          return new Promise<Response>((resolve) => {
            refetchControl.resolve = () => resolve(json(grouped))
          })
        }
        return json({})
      }),
    )

    const queryClient = renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    fireEvent.click(await waitFor(() => within(rail()).getByRole('button', { name: 'Finalise & Review' })))
    const finalise = stageSection('Finalise & Review')
    await within(finalise).findByRole('button', { name: 'Delete permanently' })

    // Trigger the background refetch WITHOUT awaiting it (it never settles
    // within this test) — same trigger workloadSetupStageWedge.test.tsx
    // uses to simulate "the next poll tick lands".
    void queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })

    await waitFor(() =>
      expect(within(finalise).queryByRole('button', { name: 'Delete permanently' })).toBeNull(),
    )

    // Let the held-open fetch resolve so nothing dangles past the test.
    refetchControl.resolve?.()
  })

  // fix-round 6 (PR #81, umbrella #385 codex sweep): FinaliseStage's own
  // direct useOperationStatus(purgeOpId) poll — the third of the file's
  // trackers, alongside JobProgress.tsx's shared OperationStatusLine/
  // JobStatusLine — used to render only `— {purgeOp.state}` off `data`
  // alone, so a settled failed refetch that retained the last-observed
  // state showed no notice that the current read had failed.
  it('a settled failed operation-status poll keeps the last-known state visible but adds a notice', async () => {
    const wl = eligibleWorkload()
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true, degraded: false, scope: [], workloads: [wl], invalid_instances: [],
    }
    let opCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(OPERATOR)
        if (url.endsWith('/api/catalog')) return json({ entries: [] })
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        if (url.match(/\/api\/media-workloads\/studio-a\/purge$/) && (init?.method ?? 'GET') === 'POST') {
          return json({
            operation_id: 'op-3', action: 'finalise-purge', target: 'studio-a', state: 'launching',
            job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-purge-3',
          })
        }
        if (url.endsWith('/api/operations/op-3')) {
          opCalls += 1
          if (opCalls === 1) {
            return json({
              operation_id: 'op-3', action: 'finalise-purge', target: 'studio-a', state: 'launching',
              job_id: null, error: null, created_at: 't0', updated_at: 't0',
            })
          }
          return new Response('boom', { status: 500 })
        }
        return json({})
      }),
    )

    const queryClient = renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    fireEvent.click(await waitFor(() => within(rail()).getByRole('button', { name: 'Finalise & Review' })))
    const finalise = stageSection('Finalise & Review')

    fireEvent.click(await within(finalise).findByRole('button', { name: 'Delete permanently' }))
    fireEvent.change(within(finalise).getByPlaceholderText(/Reason \(required/), { target: { value: 'go' } })
    fireEvent.change(within(finalise).getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
    fireEvent.click(within(finalise).getByRole('button', { name: 'Delete permanently' }))

    // First (successful) poll settles — genuinely current, no notice.
    // umbrella #499: the default-level line reads the operator-language
    // OPERATION_LABEL translation now, not the raw `Operation['state']`
    // word — the raw word moved into "System details" (expert tier).
    await within(finalise).findByText('Launching job')
    expect(within(finalise).queryByText(/Could not confirm the latest status/)).toBeNull()

    // Trigger the SAME background refetch a poll tick would cause, without
    // depending on real wall-clock time passing against an interval timer
    // TanStack Query already scheduled with real timers active (switching
    // to fake timers this late would not retroactively convert it) — same
    // "trigger via refetchQueries" pattern used for hooks with no natural
    // cheap timer hook elsewhere in this arc.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['operation', 'op-3'] })
    })

    await waitFor(() => {
      expect(within(finalise).getByText('Launching job')).toBeTruthy()
      expect(
        within(finalise).getByText(
          'Could not confirm the latest status — showing the last read, retrying automatically.',
        ),
      ).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// umbrella #432 §D2 FIX ROUND (operator report, live in Chrome on 0.27.0):
// 🗑 is an emoji-presentation glyph — it renders in the emoji font's own
// colours and ignores `text-white`, so it read muddy on the red-600 fill
// (unlike ⏏/▶ elsewhere, which are text-presentation and DO inherit
// currentColor). Swapped for lucide-react's Trash2, an inline SVG that
// inherits currentColor.
// ---------------------------------------------------------------------------

describe("umbrella #432 §D2 FIX ROUND: Delete permanently's icon is legible on the red fill", () => {
  it('renders no emoji-presentation glyph, and a real (currentColor-inheriting) SVG icon instead', async () => {
    const wl = eligibleWorkload()
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true,
      degraded: false,
      scope: [],
      workloads: [wl],
      invalid_instances: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(OPERATOR)
        if (url.endsWith('/api/catalog')) return json({ entries: [] })
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        return json({})
      }),
    )

    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    fireEvent.click(await waitFor(() => within(rail()).getByRole('button', { name: 'Finalise & Review' })))
    const finalise = stageSection('Finalise & Review')

    const button = within(finalise).getByRole('button', { name: 'Delete permanently' })
    // THE discriminator: no emoji-presentation glyph anywhere in the
    // button's rendered text — 🗑 is U+1F5D1.
    expect(button.textContent ?? '').not.toMatch(/\u{1F5D1}/u)
    // A real icon renders instead — an inline SVG, which inherits
    // `currentColor` (text-white here) rather than carrying its own
    // baked-in emoji-font colour.
    expect(button.querySelector('svg')).toBeTruthy()
  })
})
