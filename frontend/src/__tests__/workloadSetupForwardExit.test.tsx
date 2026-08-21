/**
 * dmfdeploy#412: the forward exit out of Configure. Proves the WIRING —
 * that WorkloadSetup.tsx actually calls lib/workloadFlow.ts's
 * classifyForwardExit and renders what it says, and that the old defect
 * (Next after Configure landing on Finalise & Review's Teardown/Delete
 * surface) is gone — on top of classifyForwardExit's own exhaustive
 * per-row unit tests in workloadFlow.test.ts, which this file does not
 * repeat.
 *
 * dmfdeploy#414 migration note: the exit's destination moved from the
 * retired `/operate` route to the workload's home (the bare slug) — see
 * lib/routes.ts's workloadHomePath. The `ForwardExit` classification
 * itself ('none'/'view-status'/'live') and its copy are UNCHANGED by that
 * arc; only the href the same two labels point at moved.
 *
 * Harness copied from workloadSetup.test.tsx (MSW-free, a fresh
 * react-query QueryClient per render, fetch stubbed via vi.stubGlobal) —
 * same convention workloadSetupStageWedge.test.tsx and
 * workloadSetupWizard.test.tsx already follow: each file defines its own
 * local fixtures rather than importing another test file's.
 *
 * GUARD LABEL (dmfdeploy#414 gate, round 1): every test in this file is a
 * GUARD pinning dmfdeploy#412's classifyForwardExit contract, unchanged by
 * #414 except for the one migration noted above (the destination href).
 * Baseline: the pre-#414 commit on `main` — where these same assertions
 * passed identically against WorkloadDetail.tsx with an `/operate` href,
 * as workloadDetailForwardExit.test.tsx, this file's pre-#414 name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import type { CatalogEntry, MediaWorkload, MediaWorkloadInstance, MediaWorkloadsGroupedResponse } from '../api/types'

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'viewer',
    display_name: 'MXL Viewer',
    summary: 'Renders a media flow.',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'active',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'deploy-viewer',
    finalise_awx_job_template: 'teardown-viewer',
    dependencies: [],
    ingress_url: null,
    ...overrides,
  }
}

function instance(
  overrides: Partial<MediaWorkloadInstance> = {},
): MediaWorkloadInstance & { workload_assignment: string } {
  return {
    instance: 'viewer-1',
    netbox_id: 1,
    function_key: 'viewer',
    live_view: false,
    requested_state: 'active',
    observed_state: 'running',
    reconcile_pending: false,
    placement: { node: 'node-1', ports: [], protocol: null },
    workload_assignment: 'ok',
    ...overrides,
  }
}

function workload(overrides: Partial<MediaWorkload> = {}): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'configure',
    health: 'ok',
    instances: [instance()],
    functions: [{ function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 }],
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function mkFetch(wl: MediaWorkload, grouped: Partial<Pick<MediaWorkloadsGroupedResponse, 'degraded'>> = {}) {
  const groupedResponse: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    ...grouped,
    scope: [],
    get workloads() {
      return [wl]
    },
    invalid_instances: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) {
        return json({
          subject: 'ops', display_name: 'Ops', email: 'ops@dmf.example.com',
          role: 'engineer', real_role: 'engineer', view_as_active: false, groups: [],
          awx_configured: true, authentik_configured: true,
        })
      }
      if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
      if (url.endsWith('/api/media-workloads/grouped')) return json(groupedResponse)
      if (url.endsWith('/api/facility/summary')) {
        return json({ site_count: 1, device_count: 0, sites: [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }] })
      }
      if (url.match(/\/api\/media-workloads\/[^/]+\/topology$/)) return json({})
      return json({})
    }),
  )
}

function renderDetail() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/media-workloads/studio-a/setup']}>
        <Routes>
          <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Media workload lifecycle' })
}

function stageSection(label: string): HTMLElement {
  return screen.getByRole('heading', { name: label, level: 2 }).closest('[data-step-state]') as HTMLElement
}

async function selectStep(label: string): Promise<HTMLElement> {
  const button = await waitFor(() => within(rail()).getByRole('button', { name: label }))
  fireEvent.click(button)
  return stageSection(label)
}

// FIX ROUND (dmfdeploy#412 gate, round 2 — P3): this comment previously
// described expectNoSuccessAffordance below as asserting "by name ... via
// getByRole('link', {name: ...})" — that is what the POSITIVE tests below do
// (screen.findByRole('link', {name: /pattern/})), never what this negative
// helper does. expectNoSuccessAffordance checks queryByText(pattern)
// instead, deliberately broader than a role query: it also catches either
// affordance resurfacing as plain text with no link role at all (a markup
// regression a role-scoped query would miss), not just a missing href.
const NO_SUCCESS_AFFORDANCE = [/View workload status/, /Open live view/]

/** Defaults to the whole page (`screen`) — pass `within(scope)` to narrow. */
function expectNoSuccessAffordance(scope: { queryByText: typeof screen.queryByText } = screen) {
  for (const pattern of NO_SUCCESS_AFFORDANCE) {
    expect(scope.queryByText(pattern)).toBeNull()
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('dmfdeploy#412: Configure no longer forwards to Finalise & Review', () => {
  it('offers no Next control on Configure, and Finalise & Review carries no forward path to it', async () => {
    mkFetch(workload({ lifecycle: 'operate', instances: [instance({ live_view: true })] }))
    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    const configureSection = await selectStep('Configure')
    // The old defect: array-position Next used to land here. Now there is
    // no Next control on Configure at all — not renamed, not hidden behind
    // a different gate, simply not the affordance any more.
    expect(within(configureSection).queryByRole('button', { name: 'Next →' })).toBeNull()
    // Finalise & Review's own Teardown/Delete surface never mounts as a
    // side effect of anything rendered on Configure.
    expect(screen.queryByRole('heading', { name: 'Finalise & Review', level: 2 })).toBeNull()
    expect(screen.queryByRole('button', { name: '⏏ Teardown' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull()
  })

  it('still lets Previous walk Finalise & Review back to Configure (regression guard — unchanged by this fix)', async () => {
    mkFetch(workload({ lifecycle: 'operate' }))
    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // lifecycle=operate is off-flow, so Finalise & Review is the wizard's
    // default selection already (no rail click needed).
    const finaliseSection = await waitFor(() => stageSection('Finalise & Review'))
    fireEvent.click(within(finaliseSection).getByRole('button', { name: '← Previous' }))
    expect(await screen.findByRole('heading', { name: 'Configure', level: 2 })).toBeTruthy()
  })
})

describe('dmfdeploy#412: what Configure offers instead, state by state', () => {
  it('"View workload status" — position is configure, running not yet observed (never claims a deploy succeeded)', async () => {
    mkFetch(
      workload({
        lifecycle: 'configure',
        instances: [instance({ observed_state: 'unknown' })],
      }),
    )
    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    await selectStep('Configure')

    // The exit renders as a sibling panel below FlowStep, not inside its
    // own `[data-step-state]` container — this asserts against the page,
    // gated on Configure being the mounted step (asserted above).
    const link = await screen.findByRole('link', { name: /View workload status/ })
    expect(link.getAttribute('href')).toBe('/media-workloads/studio-a')
    expect(screen.queryByText(/Open live view/)).toBeNull()
    // FIX ROUND (dmfdeploy#412 gate, round 2): the classifier has no
    // job-outcome input, so nothing here may claim a deploy "succeeded" —
    // this position is reached by active intent alone (backend ADR-0046),
    // which can equally mean a deploy that hasn't converged, one that
    // failed, or dmfdeploy#411's clear-with-no-converger.
    expect(screen.queryByText(/deploy/i)).toBeNull()
    expect(screen.queryByText(/succeeded/i)).toBeNull()
  })

  it('no success affordance — running, but not yet fully configured (continue Configure)', async () => {
    mkFetch(
      workload({
        lifecycle: 'configure',
        instances: [instance({ observed_state: 'running' })],
      }),
    )
    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    await selectStep('Configure')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Configure', level: 2 })).toBeTruthy())

    // NOT just absent from Configure's own section — genuinely not rendered
    // anywhere on the page (there is only one Configure section mounted).
    expectNoSuccessAffordance()
  })

  // FIX ROUND (dmfdeploy#412 adversarial gate): instance.live_view is
  // sidecar-URL RESOLVABILITY (media_workloads.py's sidecar_base_url — an
  // SSRF-allowlist check on stamped NetBox coordinates, never a probe),
  // never a preview fact — see classifyForwardExit's own docstring. An
  // earlier version of this fix keyed two different labels off it and
  // wrote "a preview is not [available]" on the false branch, which the
  // read never established. The two tests below assert the collapse
  // directly: the SAME "Open live view" outcome regardless of live_view,
  // and — the discriminator that matters here — no string anywhere on the
  // page claims a preview exists or does not.
  it('"Open live view" — a trusted read reports operating (an instance reports live_view true)', async () => {
    mkFetch(workload({ lifecycle: 'operate', instances: [instance({ live_view: true })] }))
    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    await selectStep('Configure')

    const link = await screen.findByRole('link', { name: /Open live view/ })
    expect(link.getAttribute('href')).toBe('/media-workloads/studio-a')
    expect(screen.queryByText(/View workload status/)).toBeNull()
    expect(screen.queryByText(/preview/i)).toBeNull()
  })

  it('"Open live view" — the SAME outcome when no instance reports live_view (never a preview claim either way)', async () => {
    mkFetch(workload({ lifecycle: 'operate', instances: [instance({ live_view: false })] }))
    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    await selectStep('Configure')

    const link = await screen.findByRole('link', { name: /Open live view/ })
    expect(link.getAttribute('href')).toBe('/media-workloads/studio-a')
    expect(screen.queryByText(/View workload status/)).toBeNull()
    expect(screen.queryByText(/preview/i)).toBeNull()
  })

  it('no success affordance — a stale/degraded read withholds it even while otherwise operating', async () => {
    mkFetch(
      workload({ lifecycle: 'operate' }),
      { degraded: true },
    )
    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    await selectStep('Configure')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Configure', level: 2 })).toBeTruthy())

    expectNoSuccessAffordance()
  })
})

// FIX ROUND 3 (review on PR #99, commit 1e3ed9d): FORWARD_STEPS omits
// Finalise, so nextStep is null on BOTH Configure and Finalise & Review —
// the shared FlowStep footer fallback used to say "This is the last step."
// on both, which is only true on the latter. Worst exactly when
// ConfigureForwardExit renders nothing ('none'), because then the operator
// sees no exit AND is told the journey ends here. These two tests pin the
// footer's rendered text directly (not canNext/nextStep, which the review
// named explicitly as insufficient) on the two states that actually reach
// the null branch.
describe('dmfdeploy#412 FIX ROUND 3: the footer no longer claims Configure is the last step', () => {
  it('Configure does not say "This is the last step." — Finalise & Review is still ahead, reachable from the steps above', async () => {
    mkFetch(workload({ lifecycle: 'operate', instances: [instance({ live_view: true })] }))
    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    const configureSection = await selectStep('Configure')
    expect(within(configureSection).queryByText('This is the last step.')).toBeNull()
    expect(
      within(configureSection).getByText(
        'There is no next step to configure. Finalise & Review stays reachable at any time from the steps above.',
      ),
    ).toBeTruthy()
  })

  it('Finalise & Review still says "This is the last step." (regression guard — passes pre-change; pins the fix does not over-reach)', async () => {
    mkFetch(workload({ lifecycle: 'operate' }))
    renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // lifecycle=operate is off-flow, so Finalise & Review is the wizard's
    // default selection already — same fixture the Previous regression
    // guard above already relies on for the same reason.
    const finaliseSection = await waitFor(() => stageSection('Finalise & Review'))
    expect(within(finaliseSection).getByText('This is the last step.')).toBeTruthy()
  })
})
