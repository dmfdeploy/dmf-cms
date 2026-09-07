/**
 * dmfdeploy/dmfdeploy#556: at the demo level, Provision's default surface
 * lists every member instance with its REQUESTED state (intent, ADR-0037 —
 * observed state deliberately absent so intent is never read as running),
 * and the clear-for-deployment control — a NetBox-intent write that 503s on
 * every deployed env today (#487) — sits behind a collapsed "Desired state
 * (expert)" <details>.
 *
 * What these two tests pin: (a) the default-render structure — one row per
 * member with its requested-state label, and every matching Clear button's
 * nearest <details> exists and is closed; (b) opening the "Desired state
 * (expert)" summary exposes the existing, unmodified Clear control and it
 * still arms correctly. (Mutation ownership living in the stage, not a
 * child, is a separate property pinned by workloadSetup.test.tsx's own
 * mount/pending/remount coverage — not by anything here.)
 *
 * Honest limit: jsdom applies no user-agent stylesheet to a closed
 * <details>, so role queries still find the button inside it — which is why
 * (a) pins the STRUCTURE (every matching button's nearest <details> exists
 * and is closed) rather than a vacuous "queryByRole is null". The real-
 * browser render is what verifies the closed state hides the control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
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
          actions={['deploy', 'clear-for-deployment']}
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

describe('dmfdeploy/dmfdeploy#556: Provision default surface shows requested-state rows, not the clear control', () => {
  it('(a) lists one row per member — "planned" / "cleared to run" — and keeps every Clear control inside a CLOSED <details>', () => {
    renderProvision()

    const list = screen.getByRole('heading', { level: 3, name: 'Members' }).nextElementSibling as HTMLElement
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual(['mxl-aplanned', 'mxl-bcleared to run'])
    // The requested-state badge carries the shared intent-not-proof title.
    expect(within(rows[0]).getByText('planned').getAttribute('title')).toMatch(/^Requested state — intent/)
    // Intent is never rendered as running: observed state is not on this list.
    expect(within(list).queryByText('running')).toBeNull()
    expect(within(list).queryByText('unknown')).toBeNull()

    // The structural claim: the clear control exists (one bootstrapped
    // member) but ONLY behind a closed disclosure — never on the default
    // surface. `hidden: true` so this can't pass vacuously if jsdom ever
    // starts honouring closed <details> in the accessibility tree.
    const clears = screen.getAllByRole('button', { name: /clear for deployment/i, hidden: true })
    expect(clears).toHaveLength(1)
    for (const button of clears) {
      const details = button.closest('details') as HTMLDetailsElement | null
      expect(details).not.toBeNull()
      expect(details!.open).toBe(false)
      expect(within(details!).getByText('Desired state (expert)').tagName).toBe('SUMMARY')
    }
  })

  it('(b) opening "Desired state (expert)" exposes the existing Clear control', () => {
    renderProvision()
    const summary = screen.getByText('Desired state (expert)')
    fireEvent.click(summary)

    const details = summary.closest('details') as HTMLDetailsElement
    expect(details.open).toBe(true)
    expect(within(details).getByRole('button', { name: 'Clear for deployment' })).toBeTruthy()
    // Arming it still works from inside the disclosure — the unchanged
    // control, not a copy.
    fireEvent.click(within(details).getByRole('button', { name: 'Clear for deployment' }))
    expect(within(details).getByText('Clear mxl-a for deployment?')).toBeTruthy()
  })
})
