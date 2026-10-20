/**
 * Automated accessibility checks (axe) for the shell chrome and the shared
 * primitives, rendered in realistic states.
 *
 * The `color-contrast` rule is off: jsdom does not compute colours or
 * layout, so axe cannot evaluate it here. Contrast is covered by the
 * stylesheet-based tests (for example formFieldPrimitive.test.tsx) and by
 * the browser suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { axe } from 'vitest-axe'
import { Bell } from 'lucide-react'
import Sidebar from '../components/Sidebar'
import Topbar from '../components/Topbar'
import Shell from '../components/Shell'
import ReasonConfirm from '../components/ReasonConfirm'
import NotificationBell from '../components/NotificationBell'
import Badge from '../components/Badge'
import Tile from '../components/Tile'
import { Input, Select, Textarea } from '../components/FormField'
import { useAuthStore } from '../store/auth'
import type { UserIdentity, WorkspaceHealth } from '../api/types'

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } }

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'operator-one',
    display_name: 'Operator One',
    email: 'operator-one@dmf.example.com',
    role: 'engineer',
    real_role: 'engineer',
    view_as_active: false,
    groups: ['media-engineers'],
    awx_configured: true,
    authentik_configured: true,
    ...overrides,
  }
}

const HEALTH: WorkspaceHealth = {
  configured: true,
  reachable: true,
  reason: '',
  watchdog_firing: true,
  alerts: [
    {
      id: 'fp-host-memory',
      name: 'HostMemoryPressure',
      state: 'firing',
      severity: 'warning',
      instance: 'node-1',
      context: 'namespace=media',
      summary: '',
      description: '',
      runbook_url: '',
      active_at: '2026-07-05T12:00:00Z',
    },
  ],
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      const body = url.endsWith('/api/workspace/health') ? HEALTH : url.endsWith('/api/me') ? identity() : {}
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
}

function withProviders(ui: React.ReactNode, initialEntries: string[] = ['/']) {
  stubFetch()
  useAuthStore.getState().setUser(identity())
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('axe: shell chrome', () => {
  it('Sidebar has no violations', async () => {
    const { container } = withProviders(<Sidebar />)
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })

  it('Topbar has no violations', async () => {
    const { container } = withProviders(<Topbar />)
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })

  it('Topbar has no violations with the personal menu open', async () => {
    const { container } = withProviders(<Topbar />)
    fireEvent.click(screen.getByRole('button', { name: 'OO' }))
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })

  it('Shell has no violations with a routed page', async () => {
    const { container } = withProviders(
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<h1>Studio A</h1>} />
        </Route>
      </Routes>,
    )
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })
})

describe('axe: confirm and notifications', () => {
  it('ReasonConfirm (open) has no violations', async () => {
    const { container } = render(
      <ReasonConfirm
        title="Restart Studio A"
        description="Restarts the workload. The action is recorded."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })

  // Known defect, dmfdeploy/dmfdeploy#614: the extra field's <label> is not
  // associated with its input (axe rule "label"). Change it.fails back to it
  // when the label is fixed: this case must then pass.
  it.fails('ReasonConfirm with an extra field and an error has no violations', async () => {
    const { container } = render(
      <ReasonConfirm
        title="Delete Studio A"
        description="Removes the workload."
        error={new Error('Request failed')}
        onConfirm={() => {}}
        onCancel={() => {}}
        extraField={{
          label: 'Workload name',
          value: 'studio-a',
          onChange: () => {},
          invalid: false,
          invalidHint: 'Use the exact name',
        }}
      />,
    )
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })

  it('NotificationBell (closed) has no violations', async () => {
    const { container } = withProviders(<NotificationBell />)
    expect(await screen.findByText('1')).toBeTruthy()
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })

  it('NotificationBell (open) has no violations', async () => {
    const { container } = withProviders(<NotificationBell />)
    expect(await screen.findByText('1')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(await screen.findByText('Host memory pressure')).toBeTruthy()
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })
})

describe('axe: shared primitives', () => {
  it('FormField controls with labels have no violations', async () => {
    const { container } = render(
      <form>
        <label htmlFor="name">Name</label>
        <Input id="name" defaultValue="studio-a" />
        <label htmlFor="slug">Slug</label>
        <Input id="slug" prefix="workload:" defaultValue="studio-a" />
        <label htmlFor="notes">Notes</label>
        <Textarea id="notes" defaultValue="Example notes" />
        <label htmlFor="kind">Kind</label>
        <Select id="kind" defaultValue="a">
          <option value="a">Option A</option>
          <option value="b">Option B</option>
        </Select>
        <label htmlFor="dense">Dense field</label>
        <Input id="dense" density="xs" />
      </form>,
    )
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })

  it('button styles (primary, secondary, danger, small) have no violations', async () => {
    const { container } = render(
      <div>
        <button type="button" className="btn-primary">Deploy</button>
        <button type="button" className="btn-secondary">Cancel</button>
        <button type="button" className="btn-danger">Delete permanently</button>
        <button type="button" className="btn-secondary btn-sm">Details</button>
        <button type="button" className="btn-primary" disabled>Locked</button>
      </div>,
    )
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })

  it('Badge has no violations', async () => {
    const { container } = render(
      <div>
        <Badge tone="neutral" icon={Bell} label="Idle" />
        <Badge tone="danger" icon={Bell} label="Failed" />
      </div>,
    )
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })

  it('Tile has no violations', async () => {
    const { container } = withProviders(
      <Tile to="/workloads/studio-a" ariaLabel="Studio A">
        <span>Studio A</span>
      </Tile>,
    )
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations()
  })
})
