/**
 * dmfdeploy/dmfdeploy#494: the backend now flags a stood-down service that
 * still answers probes (`reconcile_direction: 'stop'`). The console must say
 * why that member is not offered "clear for deployment", and the tile badge
 * must name which way intent and observation disagree.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import ProvisionStage from '../pages/MediaWorkloads/stages/ProvisionStage'
import WorkloadTile from '../pages/MediaWorkloads/WorkloadTile'
import type { MediaWorkload, MediaWorkloadInstance } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type Member = MediaWorkloadInstance & { workload_assignment: string }

function member(overrides: Partial<Member>): Member {
  return {
    instance: 'mxl-a',
    netbox_id: 1,
    function_key: 'crosspoint',
    live_view: false,
    requested_state: 'bootstrapped',
    observed_state: 'unknown',
    reconcile_pending: false,
    placement: { node: null, ports: [], protocol: null },
    workload_assignment: 'studio-a',
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderStage(instances: Member[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/catalog')) return json({ entries: [] })
      if (url.endsWith('/api/me')) return json({ subject: 'ops', role: 'operator' })
      return json({})
    }),
  )
  const workload: MediaWorkload = {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    progress: { designed: instances.length, provisioned: 0, total: instances.length },
    instances,
    functions: [],
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProvisionStage
          workload={workload}
          state="active"
          actions={['deploy', 'clear-for-deployment']}
          onBusyChange={vi.fn()}
          onJobStart={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const members = screen.getByRole('heading', {
    level: 3,
    name: /^Media Function Instances — \d+ of \d+ provisioned$/,
  }).nextElementSibling as HTMLElement
  const clearList = screen.getByText('Desired state (expert)').closest('details') as HTMLElement
  return { members, clearList }
}

const STOP_MARKER = /stood down but still answers probes/i

describe('ProvisionStage members block says why a stood-down member is still running', () => {
  it('shows the marker for a stop-direction member and withholds its clear control', () => {
    const { members, clearList } = renderStage([
      member({ instance: 'mxl-a', reconcile_pending: true, reconcile_direction: 'stop', observed_state: 'running' }),
      member({ instance: 'mxl-b' }),
    ])
    expect(within(members).getAllByText(STOP_MARKER)).toHaveLength(1)
    expect(within(members).getByText(/clearing is withheld/i)).toBeTruthy()
    expect(within(clearList).queryByText('mxl-a')).toBeNull()
    expect(within(clearList).getByText('mxl-b')).toBeTruthy()
  })

  it('shows no marker for a start-direction member or one without the field', () => {
    const { members } = renderStage([
      member({ instance: 'mxl-a', requested_state: 'active', reconcile_pending: true, reconcile_direction: 'start' }),
      member({ instance: 'mxl-b' }),
    ])
    expect(within(members).queryByText(STOP_MARKER)).toBeNull()
  })
})

describe('WorkloadTile reconciling badge title names the direction', () => {
  function badgeTitle(overrides: Partial<MediaWorkloadInstance>) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <WorkloadTile
          instance={member({ reconcile_pending: true, ...overrides })}
          displayName="Test"
          active
          motionAllowed
          onOpen={() => {}}
        />
      </QueryClientProvider>,
    )
    return screen.getByText('reconciling').getAttribute('title')
  }

  it('start', () => {
    expect(badgeTitle({ reconcile_direction: 'start' })).toMatch(/requested active, not yet running/i)
  })
  it('stop', () => {
    expect(badgeTitle({ reconcile_direction: 'stop' })).toMatch(/stood down, still running/i)
  })
  it('absent field keeps the neutral title', () => {
    expect(badgeTitle({})).toBe('Requested and observed state disagree — waiting to converge')
  })
})
