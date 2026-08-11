/**
 * Arc 4 WP-3 spec B: Provision's Deploy control promotes into the header
 * row ONLY when exactly one catalog entry is eligible at runtime — never
 * from counting `.btn-primary` in source, which two eligible entries would
 * already disprove (both would render one). An App/Shell integration test
 * on purpose (same reasoning as railRouteContract.test.tsx): the promotion
 * mechanism is a portal from a stage component into a DOM node Topbar
 * publishes (store/headerActionSlot.ts) — a WorkloadDetail-only render
 * (workloadDetailStageWedge.test.tsx and friends) never mounts Topbar, so
 * the portal target never exists there and every one of THOSE tests
 * exercises PromotedAction's inline fallback instead, unchanged. This file
 * is what actually proves the promoted path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import { useTopbarMessageStore } from '../store/topbarMessage'
import type { CatalogEntry, MediaWorkload, MediaWorkloadsGroupedResponse, UserIdentity } from '../api/types'

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops',
    email: 'ops@dmf.example.com',
    role: 'engineer',
    real_role: 'engineer',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'crosspoint',
    display_name: 'MXL Crosspoint',
    summary: 'Routes media flows between sources and viewers.',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'bootstrapped',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'deploy-crosspoint',
    finalise_awx_job_template: 'teardown-crosspoint',
    dependencies: [],
    ingress_url: null,
    ...overrides,
  }
}

function workload(functionKeys: string[] = ['crosspoint']): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [],
    functions: functionKeys.map((function_key) => ({
      function_key,
      count: 0,
      running: 0,
      reconcile_pending: 0,
    })),
  }
}

function stubFetch(entries: CatalogEntry[], deployHandler?: () => Response) {
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    // Every entry passed in must be one of the workload's OWN functions —
    // ProvisionStage joins catalog entries through functionKeys, exactly as
    // production does, so a two-entry eligibility test needs a two-function
    // workload or the second entry is silently filtered out before it ever
    // reaches the eligibility count.
    workloads: [workload(entries.map((e) => e.key))],
    invalid_instances: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return json(identity())
      if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
      if (url.endsWith('/api/catalog')) return json({ entries })
      if (url.endsWith('/api/facility/summary')) return json({ site_count: 0, device_count: 0, sites: [] })
      if (url.match(/\/api\/catalog\/crosspoint\/deploy$/) && deployHandler) return deployHandler()
      return json({})
    }),
  )
}

function renderAppAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function headerRow(): HTMLElement {
  return screen.getByTestId('header-slot-row')
}

function provisionSection(): HTMLElement {
  return screen.getByRole('heading', { name: 'Provision', level: 2 }).closest('[data-step-state]') as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useTopbarMessageStore.setState({ message: null })
})

describe('exactly one eligible deploy entry promotes into the header', () => {
  it('mounts the Deploy button in the header row, and the body says where it went', async () => {
    stubFetch([catalogEntry()])
    renderAppAt('/media-workloads/studio-a')

    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const provision = provisionSection()

    // The button is NOT inline in the body...
    await waitFor(() => {
      expect(within(provision).queryByRole('button', { name: /Deploy/ })).toBeNull()
    })
    expect(within(provision).getByText(/Deploy is available from the header above/)).toBeTruthy()

    // ...it's in the header row instead, styled with the same primary
    // (cyan) accent class every other primary control in this console uses.
    const headerDeploy = within(headerRow()).getByRole('button', { name: /Deploy/ })
    expect(headerDeploy.className).toContain('btn-primary')
  })
})

describe('two eligible deploy entries: neither promotes', () => {
  it('renders both Deploy buttons inline, and the header carries no Deploy button', async () => {
    stubFetch([catalogEntry(), catalogEntry({ key: 'viewer', display_name: 'MXL Viewer' })])
    renderAppAt('/media-workloads/studio-a')

    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const provision = provisionSection()

    const inlineButtons = await within(provision).findAllByRole('button', { name: /Deploy/ })
    expect(inlineButtons).toHaveLength(2)
    expect(within(provision).queryByText(/available from the header above/)).toBeNull()
    expect(within(headerRow()).queryByRole('button', { name: /Deploy/ })).toBeNull()
  })
})

describe('the promoted control carries the WHOLE loop, including persistent failure', () => {
  it('arms, confirms, and keeps a refused deploy legible in the header popover past the transient echo', async () => {
    stubFetch([catalogEntry()], () => json({ error: 'reason-required' }, 400))
    renderAppAt('/media-workloads/studio-a')

    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const header = headerRow()

    fireEvent.click(await within(header).findByRole('button', { name: /Deploy/ }))
    const reasonBox = await within(header).findByPlaceholderText(/Reason \(required/)
    fireEvent.change(reasonBox, { target: { value: 'scheduled' } })
    fireEvent.click(within(header).getByRole('button', { name: 'Confirm deploy' }))

    // The failure renders IN THE HEADER — the point of the action — not
    // just in the body, and not only in the topbar's transient echo.
    expect(await within(header).findByText(/nothing was changed/)).toBeTruthy()
    expect(within(header).getByRole('button', { name: 'Confirm deploy' })).toBeTruthy()

    // The topbar's own transient echo is a separate, self-expiring surface
    // (store/topbarMessage.ts) — simulating its expiry must not touch the
    // header popover's own persistent error.
    act(() => {
      useTopbarMessageStore.setState({ message: null })
    })
    expect(within(header).getByText(/nothing was changed/)).toBeTruthy()
  })
})
