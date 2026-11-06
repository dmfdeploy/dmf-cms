/**
 * The selector contract (dmfdeploy/dmfdeploy#741). Two checks:
 *   (a) every entry in lib/selectorContract.ts resolves in a render of the
 *       component that owns it, so a rename fails here and not in e2e;
 *   (b) the contract is locked to a version, so a changed entry fails until
 *       SELECTOR_CONTRACT_VERSION is bumped and the lock is updated.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import App from '../App'
import Shell from '../components/Shell'
import ReasonConfirm from '../components/ReasonConfirm'
import HistoryLane from '../pages/Activity/HistoryLane'
import MediaWorkloads from '../pages/MediaWorkloads'
import InstanceLiveModal from '../pages/MediaWorkloads/InstanceLiveModal'
import WorkloadTile from '../pages/MediaWorkloads/WorkloadTile'
import { useAuthStore } from '../store/auth'
import {
  SELECTOR_CONTRACT,
  SELECTOR_CONTRACT_VERSION,
  canonicalContract,
  contractDigest,
  lockProblem,
  type RoleSelector,
  type SelectorEntry,
} from '../lib/selectorContract'
import lock from '../lib/selectorContract.lock.json'
import type { MediaWorkloadInstance, UserIdentity } from '../api/types'

const IDENTITY: UserIdentity = {
  subject: 'ops',
  display_name: 'Ops',
  email: 'ops@dmf.example.com',
  role: 'engineer',
  real_role: 'engineer',
  view_as_active: false,
  groups: [],
  awx_configured: true,
  authentik_configured: true,
}

const INSTANCE = {
  instance: 'mxl-a',
  netbox_id: 1,
  function_key: 'mxl-videotest-view',
  live_view: false,
  requested_state: 'active',
  observed_state: 'running',
  reconcile_pending: false,
  placement: { node: 'node-1', ports: [], protocol: null },
  workload_assignment: 'ok',
} as unknown as MediaWorkloadInstance

const WORKLOAD = {
  slug: 'test',
  name: 'test',
  lifecycle: 'operate',
  health: 'ok',
  instances: [INSTANCE],
  functions: [],
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let workspaceHealth: unknown = {}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return json(IDENTITY)
      if (url.endsWith('/api/media-workloads/grouped') || url.endsWith('/api/media-workloads')) {
        return json({
          configured: true,
          degraded: false,
          scope: [],
          workloads: [{ ...WORKLOAD, slug: 'studio-a', name: 'studio-a' }, WORKLOAD],
          invalid_instances: [],
        })
      }
      if (url.endsWith('/api/workspace/health')) return json(workspaceHealth)
      if (url.endsWith('/api/catalog')) return json({ entries: [] })
      if (url.endsWith('/api/audit/events')) {
        return json({
          reason: '',
          window: { known: true, seconds: 604800, reason: '' },
          capped: false,
          excluded: [],
          events: [],
        })
      }
      return json({})
    }),
  )
}

function withProviders(ui: React.ReactElement, path = '/') {
  stubFetch()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderShell() {
  useAuthStore.getState().setUser(IDENTITY)
  withProviders(
    <Routes>
      <Route element={<Shell />}>
        <Route path="/media-workloads/:slug" element={<h1>Workload</h1>} />
      </Route>
    </Routes>,
    '/media-workloads/studio-a',
  )
}

function renderApp() {
  useAuthStore.getState().setUser(IDENTITY)
  withProviders(<App />, '/media-workloads/studio-a')
}

// One render per owning component. Every entry name must appear here, and
// every key here must be an entry name: the first test below checks both.
const RENDERS: Record<string, () => void> = {
  'shell-skip-link': renderShell,
  'shell-console-navigation': renderShell,
  'shell-nav-item': renderShell,
  'shell-breadcrumb': renderShell,
  'shell-account-menu': renderShell,
  'shell-monitoring-alerts': renderShell,
  'shell-header-slot-reserve': renderShell,
  'shell-header-slot-row': renderApp,
  'activity-panel': () => withProviders(<HistoryLane />),
  'activity-history-lane': () => withProviders(<HistoryLane />),
  'workload-grid': () => withProviders(<MediaWorkloads />),
  'workload-tile': () => withProviders(<MediaWorkloads />),
  'viewer-tile': () =>
    withProviders(
      <WorkloadTile
        instance={INSTANCE}
        displayName="Viewer"
        active={false}
        motionAllowed={false}
        onOpen={() => {}}
      />,
    ),
  'instance-live-modal': () =>
    withProviders(<InstanceLiveModal instance={INSTANCE} displayName="Viewer" onClose={() => {}} unavailable />),
  'reason-confirm-confirm': () =>
    withProviders(
      <ReasonConfirm title="T" description="D" onConfirm={() => {}} onCancel={() => {}} testIdPrefix="sample" />,
    ),
  'reason-confirm-reason': () =>
    withProviders(
      <ReasonConfirm title="T" description="D" onConfirm={() => {}} onCancel={() => {}} testIdPrefix="sample" />,
    ),
  'reason-confirm-reason-default': () =>
    withProviders(<ReasonConfirm title="T" description="D" onConfirm={() => {}} onCancel={() => {}} />),
}

// A concrete value for each entry's `<key>` placeholder.
const SAMPLE_KEYS: Record<string, string> = {
  'shell-nav-item': 'Facilities',
  'shell-account-menu': 'OP',
  'workload-tile': 'test',
  'viewer-tile': 'mxl-a',
  'reason-confirm-confirm': 'sample',
  'reason-confirm-reason': 'sample',
}

function fill(template: string, entry: SelectorEntry): string {
  return template.replace('<key>', SAMPLE_KEYS[entry.name] ?? '')
}

function nameMatcher(entry: RoleSelector): RegExp {
  if (entry.match === 'regex') return new RegExp(entry.accessibleName)
  return new RegExp(`^${escapeRegExp(fill(entry.accessibleName, entry))}$`)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

afterEach(() => {
  workspaceHealth = {}
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAuthStore.getState().setUser(null)
})

describe('selector contract: every entry resolves in its owning component', () => {
  it('has a render for every entry and an entry for every render', () => {
    expect(Object.keys(RENDERS).sort()).toEqual(SELECTOR_CONTRACT.map((e) => e.name).sort())
  })

  it('has unique entry names', () => {
    const names = SELECTOR_CONTRACT.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
  })

  for (const entry of SELECTOR_CONTRACT) {
    it(`${entry.name}`, async () => {
      RENDERS[entry.name]()
      if (entry.kind === 'testid') {
        const found = await screen.findAllByTestId(fill(entry.id, entry))
        if (entry.role) expect(found.some((el) => el.getAttribute('role') === entry.role)).toBe(true)
        return
      }
      expect(await screen.findAllByRole(entry.role, { name: nameMatcher(entry) })).not.toHaveLength(0)
    })
  }
})

describe('selector contract: disclosure panels are found through the trigger', () => {
  const triggers = SELECTOR_CONTRACT.filter((e): e is RoleSelector => e.kind === 'role' && e.controls !== undefined)

  it('has an entry for the account menu and the alerts bell', () => {
    expect(triggers.map((e) => e.name).sort()).toEqual(['shell-account-menu', 'shell-monitoring-alerts'])
  })

  for (const entry of triggers) {
    it(`${entry.name}: aria-controls resolves to the rendered open panel`, async () => {
      renderShell()
      const trigger = await screen.findByRole(entry.role, { name: nameMatcher(entry) })
      expect(trigger.getAttribute('aria-controls')).toBe(entry.controls)
      expect(document.getElementById(entry.controls as string)).toBeNull()
      fireEvent.click(trigger)
      const panel = document.getElementById(entry.controls as string)
      expect(panel).not.toBeNull()
      expect(panel?.getAttribute('role')).toBeNull()
    })
  }
})

describe('selector contract: monitoring alerts name', () => {
  const entry = SELECTOR_CONTRACT.find((e) => e.name === 'shell-monitoring-alerts') as RoleSelector

  it('is exactly "Monitoring alerts" when nothing fires', async () => {
    workspaceHealth = { configured: true, reachable: true, reason: '', watchdog_firing: true, alerts: [] }
    renderShell()
    const button = await screen.findByRole('button', { name: nameMatcher(entry) })
    expect(button.getAttribute('aria-label')).toBe('Monitoring alerts')
  })

  it('ends in ", N" when alerts fire', async () => {
    const alert = (id: string) => ({
      id,
      name: id,
      state: 'firing',
      severity: 'warning',
      instance: 'node-1',
      context: '',
      summary: '',
      description: '',
      runbook_url: '',
      active_at: '2026-07-05T12:00:00Z',
    })
    workspaceHealth = {
      configured: true,
      reachable: true,
      reason: '',
      watchdog_firing: true,
      alerts: [alert('a'), alert('b')],
    }
    renderShell()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: nameMatcher(entry) }).getAttribute('aria-label')).toBe(
        'Monitoring alerts, 2',
      ),
    )
  })

  it('rejects any other suffix', () => {
    const pattern = nameMatcher(entry)
    expect(pattern.test('Monitoring alerts disabled')).toBe(false)
    expect(pattern.test('Monitoring alerts, many')).toBe(false)
    expect(pattern.test('Monitoring alerts, 3')).toBe(true)
  })
})

describe('selector contract: version lock', () => {
  it('matches the committed lock', async () => {
    const problem = lockProblem(lock, SELECTOR_CONTRACT_VERSION, await contractDigest())
    expect(problem, problem ?? '').toBeNull()
  })

  it('fails when an entry changes and the version does not', async () => {
    const digest = await contractDigest()
    const changed = SELECTOR_CONTRACT.map((e) => (e.name === 'workload-grid' ? { ...e, id: 'workload-grid-x' } : e))
    expect(canonicalContract(changed)).not.toBe(canonicalContract())
    const changedDigest = await contractDigest(changed as SelectorEntry[])
    expect(changedDigest).not.toBe(digest)
    expect(lockProblem({ version: SELECTOR_CONTRACT_VERSION, digest }, SELECTOR_CONTRACT_VERSION, changedDigest)).toMatch(
      /bump SELECTOR_CONTRACT_VERSION/,
    )
  })

  it('fails when the version is bumped and the lock is not', async () => {
    const digest = await contractDigest()
    expect(lockProblem({ version: 1, digest }, 2, digest)).toMatch(/lock holds version 1/)
  })

  it('does not depend on entry order or key order', async () => {
    const reordered = [...SELECTOR_CONTRACT].reverse().map((e) => Object.fromEntries(Object.entries(e).reverse()))
    expect(await contractDigest(reordered as unknown as SelectorEntry[])).toBe(await contractDigest())
  })
})
