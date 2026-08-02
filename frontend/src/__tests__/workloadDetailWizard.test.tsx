/**
 * The wizard's navigation contract (umbrella #347 WO-D1 Acceptance
 * Criterion 1, binding): a job in flight must pin the operator on its own
 * owning panel — Previous, Next, and every rail selector refuse with a
 * stated reason, never a disabled control — for exactly as long as that job
 * is genuinely in flight, and departing inventory must not wedge that state
 * open forever.
 *
 * ANTI-CHURN RULE B (ownership-move lifecycle test). This WO relocates
 * mutation/state ownership across a component-mount boundary in two ways at
 * once: (1) ConfigureStage's own child InstanceSwitchControl UNMOUNTS when
 * its instance leaves `workload.instances` — the wizard's parent selection
 * does not follow it; (2) WorkloadDetail now marks job ownership
 * SYNCHRONOUSLY from the stage's own click handler (`startJob`), not solely
 * from the child's busy-effect a render later. This single scenario proves
 * both: mount Configure -> begin a switch on one of two instances (pending)
 * -> attempt every navigation seam (all refused) -> the owning instance
 * departs via a genuine query invalidation, unmounting its own
 * InstanceSwitchControl mid-flight -> the wizard's job-owner state survives
 * that unmount (Configure stays the mounted panel throughout) -> busy
 * recomputes through the CURRENT member list, not the stale pending Set, so
 * navigation unlocks instead of wedging forever (the #344 fix, proved at the
 * integration level this time, not just the unit level).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadDetail from '../pages/MediaWorkloads/WorkloadDetail'
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

function twoInstanceWorkload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'operate',
    health: 'ok',
    instances: [
      instance({ instance: 'viewer-1' }),
      instance({ instance: 'viewer-2', netbox_id: 2 }),
    ],
    functions: [{ function_key: 'viewer', count: 2, running: 2, reconcile_pending: 0 }],
  }
}

function oneInstanceWorkload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'operate',
    health: 'ok',
    instances: [instance({ instance: 'viewer-2', netbox_id: 2 })],
    functions: [{ function_key: 'viewer', count: 1, running: 1, reconcile_pending: 0 }],
  }
}

function freshTopology() {
  return {
    receiver_instance: 'x',
    sources: [
      { id: 'source-a', flow_id: 'f1', pattern: 'smpte' },
      { id: 'source-b', flow_id: 'f2', pattern: 'ball' },
    ],
    active_source: 'source-a',
    provenance: 'observed-flow',
    observed_at: new Date(Date.now() - 1_000).toISOString(),
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function mkFetch() {
  let wl: MediaWorkload = twoInstanceWorkload()
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    get workloads() { return [wl] },
    invalid_instances: [],
  }
  let releaseSwitch: (() => void) | undefined
  const switchGate = new Promise<void>((resolve) => { releaseSwitch = resolve })
  const switchCalls: string[] = []

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    if (url.endsWith('/api/me')) {
      return json({
        subject: 'ops', display_name: 'Ops', email: 'ops@dmf.example.com',
        role: 'engineer', real_role: 'engineer', view_as_active: false, groups: [],
        awx_configured: true, authentik_configured: true,
      })
    }
    if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
    if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
    if (url.endsWith('/api/facility/summary')) {
      return json({ site_count: 1, device_count: 0, sites: [{ name: 'dmf-lab', slug: 'dmf-lab', device_count: 3 }] })
    }
    const topoMatch = url.match(/\/api\/media-workloads\/([^/]+)\/topology$/)
    if (topoMatch) return json(freshTopology())
    if (url.match(/\/api\/media-workloads\/[^/]+\/switch-source$/)) {
      const receiver = decodeURIComponent(url.match(/\/media-workloads\/([^/]+)\/switch-source$/)![1])
      switchCalls.push(receiver)
      await switchGate
      return json({
        command_id: 'cmd-1', receiver_instance: receiver, source_instance: 'source-b', reason: 'go',
        status: 'active', previous_source: 'source-a', error: null, outcome: 'switch_success',
        outcome_message: null, request_id: 'req-switch-1', initiator: 'ops',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', actor: 'ops', role: 'engineer',
      })
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    switchCalls,
    releaseSwitch: () => releaseSwitch?.(),
    departViewer1: () => { wl = oneInstanceWorkload() },
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

const REASON_PLACEHOLDER = 'Reason (required, recorded in the audit trail)'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mount -> pending -> membership change -> unwedge (Acceptance Criterion 1)', () => {
  it('refuses every navigation seam while a job is in flight, then unwedges when the owning row departs', async () => {
    const h = mkFetch()
    const queryClient = renderDetail()
    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })

    // 1. MOUNT the stage: navigate to Configure (lifecycle=operate defaults
    // to Finalise & Review — offFlow — so this is a real navigation, not a
    // no-op).
    fireEvent.click(within(rail()).getByRole('button', { name: 'Configure' }))
    const configureSection = stageSection('Configure')

    // 2. BEGIN ITS JOB: arm and confirm a switch on viewer-1 (the first of
    // two rows, sorted). The fetch is held open — this job stays pending
    // until releaseSwitch() fires below.
    const switchButtons = await within(configureSection).findAllByRole('button', { name: 'Switch source' })
    fireEvent.click(switchButtons[0])
    fireEvent.change(within(configureSection).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: 'go' },
    })
    fireEvent.change(within(configureSection).getByRole('combobox'), { target: { value: 'source-b' } })
    fireEvent.click(within(configureSection).getByRole('button', { name: 'Confirm switch' }))

    await waitFor(() => expect(h.switchCalls).toEqual(['viewer-1']))

    // 3. ATTEMPT EVERY NAVIGATION SEAM — all refused with the stated reason,
    // never a disabled control.
    await waitFor(() => {
      expect(within(rail()).queryByRole('button', { name: 'Design' })).toBeNull()
      expect(within(rail()).queryByRole('button', { name: 'Finalise & Review' })).toBeNull()
    })
    expect(within(rail()).getAllByText(/A Configure job is in progress — wait for its outcome\./).length).toBeGreaterThan(0)
    expect(within(configureSection).queryByRole('button', { name: '← Previous' })).toBeNull()
    expect(within(configureSection).queryByRole('button', { name: 'Next →' })).toBeNull()
    expect(within(configureSection).getAllByText(/A Configure job is in progress/).length).toBeGreaterThan(0)
    // The Control:Operate route link is also inert while the job runs.
    expect(within(rail()).queryByRole('link', { name: 'Operate' })).toBeNull()

    // 4. CHANGE MEMBERSHIP through a GENUINE query invalidation — the same
    // path the 15s poll takes, not a hand-forced rerender. viewer-1 (the
    // instance whose switch is still pending) leaves the inventory; its own
    // InstanceSwitchControl UNMOUNTS as a result.
    h.departViewer1()
    await queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] })

    // 5a. THE JOB KEEPS THE OWNER PANEL MOUNTED: still on Configure, not
    // silently bounced to some other step by the membership change.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Configure', level: 2 })).toBeTruthy())

    // 5b. DEPARTED-ROW STATE DOES NOT WEDGE: busy derives through the
    // CURRENT member list (workload.instances), not the pending Set's own
    // size — so once viewer-1 (the only pending row) is gone, busy
    // recomputes false even though its own switch fetch technically never
    // resolved. Before the #344 fix this stayed wedged true forever.
    await waitFor(() => {
      expect(within(rail()).getByRole('button', { name: 'Design' })).toBeTruthy()
    })

    // 5c. TERMINAL OUTCOME UNLOCKS NAVIGATION: Previous/Next are live
    // buttons again on the (still-mounted) Configure panel, and the rail
    // selector + Operate link are both real controls again.
    const configureAfter = stageSection('Configure')
    expect(within(configureAfter).queryByRole('button', { name: '← Previous' })).not.toBeNull()
    expect(within(rail()).getByRole('link', { name: 'Operate' })).toBeTruthy()

    h.releaseSwitch()
  })
})
