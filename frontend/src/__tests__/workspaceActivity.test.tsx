/**
 * Workspace's Activity panel (dmfdeploy/dmfdeploy#419/#554, 2026-09-04):
 * Workspace's pinned "what just changed" widget moved from RecentChanges
 * (/api/changes/jobs, raw AWX job records) to ActivityPanel (/api/audit/
 * events, the same durable server-side audit record Activity → History
 * renders). This is a NEW RENDER SITE, not a component move — Activity →
 * History keeps its own instance (see auditEventsLaneHonesty.test.tsx for
 * that one's exhaustive coverage of the shared component's logic). These
 * tests pin the two things specific to THIS render site: the degraded
 * states actually reach the screen here too, and the heading reads plain
 * "Activity" (not "Facility activity" — Workspace already has its own
 * "Facilities" rail item, so that phrase would misname itself here).
 *
 * Also pins the umbrella#554 operator decision landing correctly: the
 * "In progress" badge is gone for watched (in_flight) actions, on both
 * render sites, since a false, never-aging "In progress" pill is worse on
 * Workspace than anywhere else — this is the page every role sees first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Workspace from '../pages/Workspace'
import ActivityPanel from '../components/ActivityPanel'
import type { AuditEventsResponse, UserIdentity, WorkspaceHealth } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const HEALTH: WorkspaceHealth = { configured: true, reachable: true, reason: '', watchdog_firing: true, alerts: [] }

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops',
    email: 'ops@dmf.example.com',
    role: 'operator',
    real_role: 'operator',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
    ...overrides,
  }
}

const EMPTY_WINDOW = { known: true, seconds: 604800, reason: '' }

function auditResponse(overrides: Partial<AuditEventsResponse> = {}): AuditEventsResponse {
  return { reason: '', window: EMPTY_WINDOW, capped: false, excluded: [], events: [], ...overrides }
}

function renderActivityPanel(auditEvents: AuditEventsResponse | { status: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/audit/events')) {
        if ('status' in auditEvents) return json({ error: 'boom' }, auditEvents.status)
        return json(auditEvents)
      }
      return json({})
    }),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActivityPanel title="Activity" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderWorkspace(auditEvents: AuditEventsResponse, role: UserIdentity['role'] = 'operator') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return json(identity({ role, real_role: role }))
      if (url.endsWith('/api/workspace/health')) return json(HEALTH)
      if (url.endsWith('/api/changes/jobs')) return json({ jobs: [] })
      if (url.endsWith('/api/audit/events')) return json(auditEvents)
      return json({})
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

describe('Workspace renders "Activity", not "Facility activity"', () => {
  it('titles the panel plain "Activity" on Workspace', async () => {
    renderWorkspace(auditResponse())
    expect(await screen.findByText('Activity')).toBeTruthy()
    expect(screen.queryByText('Facility activity')).toBeNull()
  })
})

describe('Workspace Activity panel: every designed state reaches the screen (new render site)', () => {
  it('loading', () => {
    // No fetch resolution yet — react-query's isLoading is true on mount.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ActivityPanel title="Activity" />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByText('Loading facility activity...')).toBeTruthy()
  })

  it('ok, with a real row', async () => {
    renderActivityPanel(
      auditResponse({
        events: [
          {
            request_id: 'rid-1', class: 'deploy', action: 'deploy', target: 'wl-a', workload: 'wl-a',
            actor: 'alice', role: 'operator', reason: 'demo', at: '2026-09-04T00:00:00Z', at_ns: '1',
            outcome: { state: 'in_flight', detail: 'dispatched' },
          },
        ],
      }),
    )
    expect(await screen.findByText('Deploy dispatched for wl-a')).toBeTruthy()
  })

  it('ok, genuinely empty', async () => {
    renderActivityPanel(auditResponse())
    expect(await screen.findByText(/No actions in your permitted view were found/)).toBeTruthy()
  })

  it('unreachable', async () => {
    renderActivityPanel(auditResponse({ reason: 'loki-unreachable' }))
    expect(await screen.findByText(/Facility history is unreachable right now/)).toBeTruthy()
  })

  it('unconfigured', async () => {
    renderActivityPanel(auditResponse({ reason: 'loki-unconfigured' }))
    expect(await screen.findByText(/Facility history is not configured in this environment/)).toBeTruthy()
  })

  it('error — the console\'s own API call failed', async () => {
    renderActivityPanel({ status: 500 })
    expect(await screen.findByText(/Facility history could not be loaded/)).toBeTruthy()
  })

  it('capped', async () => {
    renderActivityPanel(
      auditResponse({
        capped: true,
        events: [
          {
            request_id: 'rid-2', class: 'teardown', action: 'teardown', target: 'wl-b', workload: 'wl-b',
            actor: 'bob', role: 'operator', reason: 'demo', at: '2026-09-04T00:00:00Z', at_ns: '2',
            outcome: { state: 'in_flight', detail: 'dispatched' },
          },
        ],
      }),
    )
    expect(await screen.findByText(/may not be complete/)).toBeTruthy()
  })
})

describe('umbrella#554: the in_flight badge is gone, on Workspace as everywhere else', () => {
  it('a watched, in-flight row shows no "In progress" pill — the title already says dispatched', async () => {
    renderActivityPanel(
      auditResponse({
        events: [
          {
            request_id: 'rid-3', class: 'deploy', action: 'deploy', target: 'wl-c', workload: 'wl-c',
            actor: 'carol', role: 'operator', reason: 'demo', at: '2026-09-04T00:00:00Z', at_ns: '3',
            outcome: { state: 'in_flight', detail: 'dispatched' },
          },
        ],
      }),
    )
    expect(await screen.findByText('Deploy dispatched for wl-c')).toBeTruthy()
    // The detail word stays (it's not the badge) — only the colored pill
    // repeating "In progress" on top of an already-honest title is gone.
    expect(screen.getByText('dispatched')).toBeTruthy()
    expect(screen.queryByText('In progress')).toBeNull()
  })

  it('switch-source keeps its real verdict badge — this decision is scoped to watched actions only', async () => {
    renderActivityPanel(
      auditResponse({
        events: [
          {
            request_id: 'rid-4', class: 'switch-source', action: 'switch-source', target: 'wl-d', workload: null,
            actor: 'dave', role: 'engineer', reason: 'demo', at: '2026-09-04T00:00:00Z', at_ns: '4',
            outcome: { state: 'succeeded', detail: 'active' },
          },
        ],
      }),
    )
    expect(await screen.findByText('Switched source on wl-d')).toBeTruthy()
    expect(screen.getByText('Succeeded')).toBeTruthy()
  })
})

describe('umbrella#419/#554: a viewer\'s honest empty state on Workspace, not a claim the facility was idle', () => {
  it('a viewer with no permitted record class sees the same honest "permitted view" copy — not "no activity"', async () => {
    // /api/audit/events is gated per record class server-side; the fixture
    // here is what a viewer with nothing in their permitted view actually
    // gets back — a genuine ok/empty read, same shape any role gets when
    // their own permitted slice is empty. This deliberately does NOT
    // change the copy, per operator instruction (accepted as-is) — it
    // pins that the existing honest copy is what a viewer sees, not a
    // regression to something implying the facility was idle.
    renderWorkspace(auditResponse(), 'viewer')
    expect(await screen.findByText(/No actions in your permitted view were found in this window/)).toBeTruthy()
    expect(screen.queryByText(/No activity/)).toBeNull()
    expect(screen.queryByText(/facility (is|was) idle/i)).toBeNull()
  })
})
