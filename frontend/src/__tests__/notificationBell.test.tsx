/**
 * The shell notification bell (Constitution Art. 4 + §4 anti-pattern). It
 * must read the SAME floored, operator-language workspace-health signal as
 * "Current problems" (no info/advisory, no Watchdog), badge only firing
 * warning+ conditions, present as "Monitoring alerts" (not classified
 * conditions), link to the expert Monitoring page, and carry NO ack.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import NotificationBell from '../components/NotificationBell'
import type { WorkspaceHealth } from '../api/types'

// status lets a test drive the query into an error (unreachable) branch.
function renderBell(health: WorkspaceHealth, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/workspace/health')) {
        return new Response(JSON.stringify(health), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function health(alerts: WorkspaceHealth['alerts']): WorkspaceHealth {
  return { configured: true, reachable: true, reason: '', watchdog_firing: true, alerts }
}

function alert(name: string, severity: string) {
  return {
    id: `fp-${name}`,
    name,
    state: 'firing',
    severity,
    instance: 'node-1',
    context: 'namespace=mxl',
    summary: '',
    description: '',
    runbook_url: '',
    active_at: '2026-07-05T12:00:00Z',
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('NotificationBell', () => {
  it('badges the firing count from workspace-health and opens a "Monitoring alerts" panel', async () => {
    renderBell(health([alert('HostMemoryPressure', 'warning')]))
    // Badge shows the count.
    expect(await screen.findByText('1')).toBeTruthy()
    // Open the dropdown.
    screen.getByRole('button', { name: 'Monitoring alerts' }).click()
    // Honest label — a monitoring affordance, not "Notifications"/classified.
    expect(await screen.findByText('Monitoring alerts')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open Monitoring' })).toBeTruthy()
    // Operator-language condition title; raw rule name not shown.
    expect(screen.getByText('Host memory pressure')).toBeTruthy()
    expect(screen.queryByText('HostMemoryPressure')).toBeNull()
    // No ack/lifecycle machinery.
    expect(screen.queryByText(/ack/i)).toBeNull()
  })

  it('shows no badge and "All systems nominal" only when verified & reachable & quiet', async () => {
    renderBell(health([]))
    const btn = await screen.findByRole('button', { name: 'Monitoring alerts' })
    expect(screen.queryByText('1')).toBeNull()
    btn.click()
    expect(await screen.findByText('All systems nominal')).toBeTruthy()
  })

  it('never renders a false green when monitoring is unreachable (Art. 1)', async () => {
    // 500 → react-query error → classifier "unknown".
    renderBell(health([]), 500)
    const btn = await screen.findByRole('button', { name: 'Monitoring alerts' })
    btn.click()
    expect(await screen.findByText(/Monitoring unreachable/)).toBeTruthy()
    expect(screen.queryByText('All systems nominal')).toBeNull()
    expect(screen.queryByText('No active alerts')).toBeNull()
  })

  it('never renders a false green when the Watchdog signal is absent', async () => {
    renderBell({ configured: true, reachable: true, reason: 'watchdog-missing', watchdog_firing: false, alerts: [] })
    const btn = await screen.findByRole('button', { name: 'Monitoring alerts' })
    btn.click()
    expect(await screen.findByText(/Cannot be verified as healthy/)).toBeTruthy()
    expect(screen.queryByText('All systems nominal')).toBeNull()
  })

  it('shows the not-configured state honestly, not nominal', async () => {
    renderBell({ configured: false, reachable: false, reason: 'prometheus-not-configured', watchdog_firing: false, alerts: [] })
    const btn = await screen.findByRole('button', { name: 'Monitoring alerts' })
    btn.click()
    expect(await screen.findByText(/Monitoring not configured/)).toBeTruthy()
    expect(screen.queryByText('All systems nominal')).toBeNull()
  })
})
