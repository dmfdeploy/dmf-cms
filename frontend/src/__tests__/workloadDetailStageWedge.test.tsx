/**
 * GATE-D1 P2.5: the #344 departed-key wedge fix, proved discriminating for
 * Provision and Finalise specifically — not just Configure (the only stage
 * workloadDetailWizard.test.tsx's Acceptance-1 test exercises). Reconstructing
 * ProvisionStage/FinaliseStage's busy computation as
 * `Object.values(track).some(...)` (the pre-fix shape) must leave the FULL
 * suite green everywhere except the two tests in this file — that is the
 * gap the gate found by re-running the suite after a valid reconstruction.
 *
 * Both tests mount a stage with TWO catalog entries, launch a job on one,
 * hold its BACKEND JOB (not just the deploy/teardown POST) open by never
 * returning is_done:true from the status poll, then depart that entry from
 * workload.functions via a genuine query invalidation. The departed entry's
 * `track[key]` stays non-null forever (nothing ever clears it — its own
 * JobStatusLine unmounted with the row), so `Object.values(track).some(...)`
 * would count it forever; `functionKeys.some(key => activeTrack(track[key]))`
 * does not, because the departed key is no longer in `functionKeys`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadDetail from '../pages/MediaWorkloads/WorkloadDetail'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import type { CatalogEntry, MediaWorkload, MediaWorkloadsGroupedResponse } from '../api/types'

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
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
  return queryClient
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Media workload lifecycle' })
}

function stageSection(label: string): HTMLElement {
  return screen.getByRole('heading', { name: label, level: 2 }).closest('[data-step-state]') as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Provision
// ---------------------------------------------------------------------------

describe('Provision: a departed catalog entry does not wedge busy forever', () => {
  it('unwedges once the entry with the still-running job departs workload.functions', async () => {
    let wl: MediaWorkload = {
      slug: 'studio-a',
      name: 'studio-a',
      lifecycle: 'provision',
      health: 'ok',
      instances: [],
      functions: [
        { function_key: 'crosspoint', count: 0, running: 0, reconcile_pending: 0 },
        { function_key: 'viewer', count: 0, running: 0, reconcile_pending: 0 },
      ],
    }
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true,
      degraded: false,
      scope: [],
      get workloads() { return [wl] },
      invalid_instances: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) {
          return json({ entries: [catalogEntry(), catalogEntry({ key: 'viewer', display_name: 'MXL Viewer' })] })
        }
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        if (url.endsWith('/api/facility/summary')) return json({ site_count: 0, device_count: 0, sites: [] })
        if (url.match(/\/api\/catalog\/crosspoint\/deploy$/)) {
          return json({ job_id: 501, status: 'launched', request_id: 'req-1' })
        }
        // The backend job itself never finishes — is_done stays false, so
        // nothing but a membership change can ever clear track['crosspoint'].
        if (url.match(/\/api\/catalog\/crosspoint\/status\/501$/)) {
          return json({ job_id: 501, status: 'running', is_done: false, is_running: true })
        }
        return json({})
      }),
    )

    const queryClient = renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    const provision = stageSection('Provision')
    const deployButtons = await within(provision).findAllByRole('button', { name: /Deploy/ })
    fireEvent.click(deployButtons[0]) // crosspoint is first (declared first in catalog)
    fireEvent.change(within(provision).getAllByRole('textbox')[0], { target: { value: 'go' } })
    fireEvent.click(within(provision).getByRole('button', { name: /Confirm deploy/ }))

    // The job is now tracked and permanently "running" — busy is true.
    await within(provision).findByText(/job #501/)
    await waitFor(() => expect(within(rail()).queryByRole('button', { name: 'Design' })).toBeNull())

    // Genuine query invalidation: crosspoint departs workload.functions.
    // Its own ProvisionEntry (and JobStatusLine) unmounts as a result — the
    // still-running job's track entry has no path left to ever clear itself.
    wl = {
      ...wl,
      functions: [{ function_key: 'viewer', count: 0, running: 0, reconcile_pending: 0 }],
    }
    await queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })

    // Owner panel stays mounted (Provision is still the position).
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Provision', level: 2 })).toBeTruthy())

    // Unwedged: busy derives through the CURRENT function keys, so the
    // departed key's permanently-active track entry is no longer counted.
    await waitFor(() => {
      expect(within(rail()).getByRole('button', { name: 'Design' })).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// Finalise & Review
// ---------------------------------------------------------------------------

describe('Finalise & Review: a departed catalog entry does not wedge busy forever', () => {
  it('unwedges once the entry with the still-running teardown job departs workload.functions', async () => {
    let wl: MediaWorkload = {
      slug: 'studio-a',
      name: 'studio-a',
      lifecycle: 'operate',
      health: 'ok',
      instances: [],
      functions: [
        { function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 },
        { function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 },
      ],
    }
    const grouped: MediaWorkloadsGroupedResponse = {
      configured: true,
      degraded: false,
      scope: [],
      get workloads() { return [wl] },
      invalid_instances: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) {
          return json({
            entries: [
              catalogEntry({ lifecycle: 'active' }),
              catalogEntry({ key: 'viewer', display_name: 'MXL Viewer', lifecycle: 'active' }),
            ],
          })
        }
        if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
        if (url.match(/\/api\/catalog\/crosspoint\/teardown$/)) {
          return json({ job_id: 601, status: 'launched', request_id: 'req-2' })
        }
        if (url.match(/\/api\/catalog\/crosspoint\/status\/601$/)) {
          return json({ job_id: 601, status: 'running', is_done: false, is_running: true })
        }
        return json({})
      }),
    )

    const queryClient = renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // lifecycle=operate is off-flow — Finalise & Review is the default
    // wizard selection already.
    const finalise = stageSection('Finalise & Review')
    const teardownButtons = await within(finalise).findAllByRole('button', { name: /Teardown/ })
    fireEvent.click(teardownButtons[0]) // crosspoint first
    fireEvent.change(within(finalise).getAllByRole('textbox')[0], { target: { value: 'go' } })
    fireEvent.click(within(finalise).getByRole('button', { name: /Confirm teardown/ }))

    await within(finalise).findByText(/job #601/)
    await waitFor(() => expect(within(rail()).queryByRole('button', { name: 'Design' })).toBeNull())

    wl = {
      ...wl,
      functions: [{ function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 }],
    }
    await queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Finalise & Review', level: 2 })).toBeTruthy(),
    )
    await waitFor(() => {
      expect(within(rail()).getByRole('button', { name: 'Design' })).toBeTruthy()
    })
  })
})
