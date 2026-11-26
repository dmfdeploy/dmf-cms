/**
 * dmfdeploy/dmfdeploy#556: at the demo level, Provision's default surface
 * lists every member instance with its REQUESTED state (intent, ADR-0037 —
 * observed state deliberately absent so intent is never read as running).
 * Provision offers no desired-state control: no clear button and no
 * "Desired state (expert)" disclosure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import ProvisionStage from '../pages/MediaWorkloads/stages/ProvisionStage'
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

// Deliberately listed out of name order: the list must sort by `instance`.
const WORKLOAD: MediaWorkload = {
  slug: 'studio-a',
  name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    // These values deliberately disagree with the two local rows.  The
    // heading must render the NetBox-backed API progress, never reconstruct
    // it from requested_state in the browser.
    progress: { designed: 9, provisioned: 5, total: 9 },
    instances: [
    member({ instance: 'mxl-b', requested_state: 'active', observed_state: 'running' }),
    member({ instance: 'mxl-a', requested_state: 'bootstrapped', observed_state: 'unknown' }),
  ],
  functions: [{ function_key: 'crosspoint', count: 2, running: 1, reconcile_pending: 0 }],
}

function renderProvision() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/catalog')) return json({ entries: [] })
      if (url.endsWith('/api/me')) return json({ subject: 'ops', role: 'operator' })
      return json({})
    }),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProvisionStage
          workload={WORKLOAD}
          state="active"
          actions={['deploy']}
          onBusyChange={vi.fn()}
          onJobStart={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dmfdeploy/dmfdeploy#556: Provision default surface shows requested-state rows', () => {
  it('lists one row per member — "planned" / "cleared to run" — and offers no desired-state control', () => {
    renderProvision()

    const list = screen.getByRole('heading', {
      level: 3,
      name: 'Media Function Instances — 5 of 9 provisioned',
    }).nextElementSibling as HTMLElement
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual(['mxl-aplanned', 'mxl-bcleared to run'])
    // The requested-state badge carries the shared intent-not-proof title.
    expect(within(rows[0]).getByText('planned').getAttribute('title')).toMatch(/^Requested state — intent/)
    // Intent is never rendered as running: observed state is not on this list.
    expect(within(list).queryByText('running')).toBeNull()
    expect(within(list).queryByText('unknown')).toBeNull()

    // `hidden: true` so this can't pass vacuously on a closed <details>.
    expect(screen.queryByRole('button', { name: /clear for deployment/i, hidden: true })).toBeNull()
    expect(screen.queryByText('Desired state (expert)')).toBeNull()
  })
})
