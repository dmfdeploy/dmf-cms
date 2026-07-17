/**
 * Workspace "are we OK?" core (#174 WP2) — the plan §6 fixture-driven
 * states: verified green (0 alerts + Watchdog), warning-only, critical,
 * Prometheus unreachable, and not-configured. Each renders the specified
 * verdict as content, never a raw error (hard gates 1+4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Workspace from '../pages/Workspace'
import type { UserIdentity, WorkspaceHealth } from '../api/types'

const user: UserIdentity = {
  subject: 'u1',
  display_name: 'Test User',
  email: 'test@dmf.example.com',
  role: 'viewer',
  real_role: 'viewer',
  view_as_active: false,
  groups: [],
  awx_configured: false,
  authentik_configured: false,
}

function health(overrides: Partial<WorkspaceHealth> = {}): WorkspaceHealth {
  return {
    configured: true,
    reachable: true,
    reason: '',
    watchdog_firing: true,
    alerts: [],
    ...overrides,
  }
}

function alert(name: string, severity: string, summary = '', id = '', context = '', activeAt = '2026-07-05T12:00:00Z') {
  return {
    id: id || `fp-${name}`,
    name,
    state: 'firing',
    severity,
    instance: 'node-1',
    context,
    summary,
    description: '',
    runbook_url: severity === 'critical' ? 'https://runbooks.test#x' : '',
    active_at: activeAt,
  }
}

function renderWorkspace(healthBody: WorkspaceHealth) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      let body: unknown = {}
      if (url.endsWith('/api/me')) body = user
      if (url.endsWith('/api/workspace/health')) body = healthBody
      if (url.endsWith('/api/changes/jobs')) body = { jobs: [] }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Workspace />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Workspace health core states (plan §6)', () => {
  it('zero alerts + Watchdog renders an explicit verified green, not an empty list', async () => {
    renderWorkspace(health())
    expect(await screen.findByText(/No problems — facility monitoring reports all quiet/)).toBeTruthy()
    expect(screen.getByText(/Verified: the alert pipeline/)).toBeTruthy()
  })

  it('zero alerts without Watchdog renders unknown, never a false green', async () => {
    renderWorkspace(health({ watchdog_firing: false }))
    expect(await screen.findByText(/cannot be verified as healthy/)).toBeTruthy()
    expect(screen.getByText(/Treat this as unknown, not green/)).toBeTruthy()
  })

  it('warning-only state fills the warning tile and lists the problem in operator language', async () => {
    renderWorkspace(health({ alerts: [alert('HostMemoryPressure', 'warning', 'memory tight')] }))
    // Operator-language title at default (Art. 3); raw rule name is demoted
    // behind Details, not shown at default.
    expect(await screen.findByText('Host memory pressure')).toBeTruthy()
    expect(screen.queryByText('HostMemoryPressure')).toBeNull()
    expect(screen.getByText('memory tight')).toBeTruthy()
    expect(screen.getByText('warning')).toBeTruthy()
    // Non-mutating actions only: Investigate link, no Ack anywhere.
    expect(screen.getByRole('link', { name: 'Investigate' })).toBeTruthy()
    expect(screen.queryByText(/ack/i)).toBeNull()
    // No Info tile — the tile row classifies problems only (Critical/Warning).
    expect(screen.queryByText('Info')).toBeNull()
    expect(screen.getByText('Critical')).toBeTruthy()
    expect(screen.getByText('Warning')).toBeTruthy()
  })

  it('raw rule name + key=value context are available behind an expert Details toggle', async () => {
    renderWorkspace(
      health({ alerts: [alert('HostMemoryPressure', 'warning', 'memory tight', '', 'namespace=mxl')] }),
    )
    const btn = await screen.findByRole('button', { name: 'Details' })
    expect(screen.queryByText(/HostMemoryPressure/)).toBeNull()
    btn.click()
    expect(await screen.findByText(/HostMemoryPressure/)).toBeTruthy()
  })

  it('critical state lists the problem with severity and runbook link', async () => {
    renderWorkspace(health({ alerts: [alert('NodeDown', 'critical', 'node gone')] }))
    expect(await screen.findByText('Node down')).toBeTruthy()
    expect(screen.getByText('critical')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Runbook/ })).toBeTruthy()
  })

  it('renders two rows for the same alert name with distinct readable scopes', async () => {
    renderWorkspace(
      health({
        alerts: [
          alert('PodCrashLooping', 'warning', '', 'fp-1', 'namespace=mxl pod=a'),
          alert('PodCrashLooping', 'warning', '', 'fp-2', 'namespace=nmos pod=b'),
        ],
      }),
    )
    expect(await screen.findAllByText('Pods restarting repeatedly')).toHaveLength(2)
    // key=value jargon humanised at default; raw blob is expert-only (Details).
    expect(screen.getByText('mxl · pod a')).toBeTruthy()
    expect(screen.getByText('nmos · pod b')).toBeTruthy()
    expect(screen.queryByText('namespace=mxl pod=a')).toBeNull()
  })

  it('unreachable monitoring with no prior data renders unknown as content, no raw error', async () => {
    renderWorkspace(health({ reachable: false, reason: 'prometheus-unreachable' }))
    expect(await screen.findByText(/Facility health — unknown/)).toBeTruthy()
    expect(screen.getByText(/Monitoring is unreachable and no earlier state/)).toBeTruthy()
    expect(screen.queryByText(/prometheus-unreachable/)).toBeNull()
  })

  it('not-configured renders the explicit dark state', async () => {
    renderWorkspace(health({ configured: false, reachable: false, watchdog_firing: false }))
    expect(await screen.findByText(/Monitoring is not configured in this environment/)).toBeTruthy()
  })
})

describe('Problem row duration (Zabbix Problems model, #243 follow-up)', () => {
  it('shows how long the problem has been active', async () => {
    // Fix Date.now() only (not fake timers — those would also pause the
    // async fetch/query machinery this test's findByText waits on).
    // active_at (fixture default) + exactly 2h14m.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-05T14:14:00Z'))
    renderWorkspace(health({ alerts: [alert('HostMemoryPressure', 'warning', 'memory tight')] }))
    expect(await screen.findByText('for 2h 14m')).toBeTruthy()
  })

  it('omits the duration cleanly when active_at is empty', async () => {
    renderWorkspace(
      health({ alerts: [alert('HostMemoryPressure', 'warning', 'memory tight', '', '', '')] }),
    )
    expect(await screen.findByText('Host memory pressure')).toBeTruthy()
    expect(screen.queryByText(/^for /)).toBeNull()
  })
})
