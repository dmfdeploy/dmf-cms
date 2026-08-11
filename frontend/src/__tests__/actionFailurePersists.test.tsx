/**
 * Closes umbrella dmfdeploy/dmfdeploy#386 — a failed deploy was invisible.
 *
 * ProvisionEntry's onConfirm used to be `onDeploy(...); setArming(false)`:
 * onDeploy is async and not awaited, and setArming(false) unmounted the
 * {arming && ...} block — the ONLY element rendering `error={deployError}` —
 * synchronously, before the mutation had even settled. The failure path
 * dead-ended at a console.error with no operator-visible trace: success
 * closed the panel, and so did failure, indistinguishably.
 *
 * The fix (WP-3 spec B2) closes the panel ONLY on success; on rejection it
 * stays mounted, so ReasonConfirm's own error paragraph — already correct,
 * untouched — renders the failure for as long as the operator is looking at
 * it, independent of anything time-based.
 *
 * SWEEP: the same onConfirm-then-close shape existed at every other
 * ReasonConfirm call site that fires its own write and reports its own
 * error (catalog deploy/teardown, the Finalise & Review teardown relocated
 * from it, and Activity's workflow launch) — this file proves each one,
 * not just the named Provision case. clear-for-deployment and switch-source
 * are NOT here: they already render their failure at the STAGE level,
 * outside their own armed subtree (see ProvisionStage.tsx's clearMutation
 * .isError paragraph and ConfigureStage.tsx's close-only-on-success submit)
 * — the reference shape this fix now matches everywhere else.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadDetail from '../pages/MediaWorkloads/WorkloadDetail'
import Catalog from '../pages/Catalog'
import JobsLane from '../pages/Activity/JobsLane'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import { useTopbarMessageStore } from '../store/topbarMessage'
import type { CatalogEntry, MediaWorkload, MediaWorkloadsGroupedResponse, UserIdentity } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function refused(token = 'reason-required') {
  return json({ error: token }, 400)
}

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops',
    email: 'ops@dmf.example.com',
    role: 'engineer',
    real_role: 'engineer',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
    ...overrides,
  }
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'crosspoint',
    display_name: 'MXL Crosspoint',
    summary: '',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'bootstrapped',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'deploy-crosspoint',
    finalise_awx_job_template: 'teardown-crosspoint',
    dependencies: [],
    ingress_url: null,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  useTopbarMessageStore.setState({ message: null })
})

// ---------------------------------------------------------------------------
// Provision — the named #386 case
// ---------------------------------------------------------------------------

describe('Provision: a refused deploy stays legible at the point of action', () => {
  function workload(): MediaWorkload {
    return {
      slug: 'studio-a',
      name: 'studio-a',
      lifecycle: 'provision',
      health: 'ok',
      instances: [],
      functions: [{ function_key: 'crosspoint', count: 0, running: 0, reconcile_pending: 0 }],
    }
  }

  function renderDetail() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads/studio-a']}>
          <Routes>
            <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
          </Routes>
          <HeaderSlotProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  function stubFetch() {
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true,
      degraded: false,
      scope: [],
      workloads: [workload()],
      invalid_instances: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        if (url.endsWith('/api/facility/summary')) return json({ site_count: 0, device_count: 0, sites: [] })
        if (url.match(/\/api\/catalog\/crosspoint\/deploy$/)) return refused()
        return json({})
      }),
    )
  }

  it('keeps the confirm panel mounted with the error visible, and it outlives the topbar\'s transient echo', async () => {
    stubFetch()
    renderDetail()

    const provision = await screen.findByRole('heading', { name: 'Provision', level: 2 }).then(
      (h) => h.closest('[data-step-state]') as HTMLElement,
    )

    fireEvent.click(await within(provision).findByRole('button', { name: /Deploy/ }))
    // Two textboxes render in the armed panel — reason textarea + the
    // optional workload text input — same shape workloadDetailStageWedge
    // .test.tsx already keys off (reason is declared first).
    fireEvent.change(within(provision).getAllByRole('textbox')[0], { target: { value: 'scheduled' } })
    fireEvent.click(within(provision).getByRole('button', { name: 'Confirm deploy' }))

    // The failure renders — GATE-B P1 Art. 8 copy, not a stringified
    // exception, and not silence.
    expect(await within(provision).findByText(/nothing was changed/)).toBeTruthy()

    // The panel is still THERE, not a re-summoned copy: the reason textarea
    // and Confirm button are both still reachable, proving `arming` never
    // flipped false on the rejection.
    expect(within(provision).getByRole('button', { name: 'Confirm deploy' })).toBeTruthy()
    expect(within(provision).getAllByRole('textbox')[0]).toBeTruthy()

    // The topbar's own transient echo (GATE-D1 P2.4) is a SEPARATE surface
    // that self-expires after MESSAGE_TTL_MS (store/topbarMessage.ts) —
    // simulated directly here rather than a real 6s sleep, since the
    // property under test is that the stage's failure display does not
    // share that surface's lifetime at all, not that a timer eventually
    // fires. `startJob` already emitted onto it when Confirm was clicked;
    // clearing it the way its own expiry does must not touch the stage.
    act(() => {
      useTopbarMessageStore.setState({ message: null })
    })
    expect(within(provision).getByText(/nothing was changed/)).toBeTruthy()

    // And the same holds across real elapsed time, past the topbar's own
    // 6s TTL, with no dependency on this test ever calling anything that
    // would refresh a timer for the stage's own display.
    vi.useFakeTimers()
    act(() => {
      vi.advanceTimersByTime(6_001)
    })
    expect(within(provision).getByText(/nothing was changed/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Finalise & Review — the teardown control relocated from Catalog
// ---------------------------------------------------------------------------

describe('Finalise & Review: a refused teardown stays legible at the point of action', () => {
  function workload(): MediaWorkload {
    return {
      slug: 'studio-a',
      name: 'studio-a',
      lifecycle: 'operate',
      health: 'ok',
      instances: [],
      functions: [{ function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 }],
    }
  }

  function renderDetail() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/media-workloads/studio-a']}>
          <Routes>
            <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
          </Routes>
          <HeaderSlotProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('keeps the confirm panel mounted with the error visible after Confirm teardown is refused', async () => {
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true,
      degraded: false,
      scope: [],
      workloads: [workload()],
      invalid_instances: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry({ lifecycle: 'active' })] })
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        if (url.match(/\/api\/catalog\/crosspoint\/teardown$/)) return refused('conflicting-operation')
        return json({})
      }),
    )
    renderDetail()

    const finalise = await screen.findByRole('heading', { name: 'Finalise & Review', level: 2 }).then(
      (h) => h.closest('[data-step-state]') as HTMLElement,
    )

    fireEvent.click(await within(finalise).findByRole('button', { name: /Teardown/ }))
    fireEvent.change(within(finalise).getByRole('textbox'), { target: { value: 'scheduled' } })
    fireEvent.click(within(finalise).getByRole('button', { name: 'Confirm teardown' }))

    expect(await within(finalise).findByText(/nothing was changed/)).toBeTruthy()
    expect(within(finalise).getByRole('button', { name: 'Confirm teardown' })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Catalog — the standalone page the deploy/teardown pattern relocated from
// ---------------------------------------------------------------------------

describe('Catalog: a refused teardown stays legible at the point of action', () => {
  function renderCatalog() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(identity())
        if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry({ lifecycle: 'active' })] })
        if (url.endsWith('/teardown')) return refused('conflicting-operation')
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Catalog />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('keeps the confirm panel mounted with the error visible after Confirm teardown is refused', async () => {
    renderCatalog()
    fireEvent.click(await screen.findByRole('button', { name: /Teardown/ }))
    fireEvent.change(await screen.findByPlaceholderText(/Reason \(required/), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm teardown' }))

    expect(await screen.findByText(/nothing was changed/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm teardown' })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Activity — Jobs lane workflow launch
// ---------------------------------------------------------------------------

describe('Activity Jobs lane: a refused launch stays legible at the point of action', () => {
  function renderJobsLane() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) return json(identity())
        if (url.endsWith('/api/workflows')) {
          return json({ templates: [{ id: 1, name: 'day0-bootstrap', description: 'Bootstrap a facility', type: 'job' }] })
        }
        if (url.endsWith('/launch')) return refused('reason-required')
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <JobsLane />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('keeps the confirm panel mounted with the error visible after Confirm launch is refused', async () => {
    renderJobsLane()
    fireEvent.click(await screen.findByRole('button', { name: /Launch/ }))
    fireEvent.change(await screen.findByPlaceholderText(/Reason \(required/), { target: { value: 'scheduled' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm launch' }))

    await waitFor(() => expect(screen.getByText(/nothing was changed/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Confirm launch' })).toBeTruthy()
  })
})
