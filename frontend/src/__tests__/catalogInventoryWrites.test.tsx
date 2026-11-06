/**
 * dmfdeploy#319: the Catalog page sends deploy and teardown writes, so it
 * withdraws them while the inventory read is stale or has failed, like the
 * workload screens do. Each test drives fresh -> blocked -> fresh through the
 * real grouped query.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Catalog from '../pages/Catalog'
import type { CatalogEntry } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const ENTRY: CatalogEntry = {
  key: 'crosspoint',
  display_name: 'MXL Crosspoint',
  summary: '',
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
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

function setup(lifecycle: CatalogEntry['lifecycle'] = 'bootstrapped') {
  const state = { grouped: {} as Record<string, unknown>, groupedStatus: 200, posts: [] as string[] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) {
        return json({ subject: 'ops', display_name: 'Ops', email: 'o@x', role: 'engineer', real_role: 'engineer', groups: [], awx_configured: true })
      }
      if (url.endsWith('/api/catalog')) return json({ entries: [{ ...ENTRY, lifecycle }] })
      if (url.endsWith('/api/media-workloads/grouped')) {
        if (state.groupedStatus !== 200) return json({ error: 'boom' }, state.groupedStatus)
        return json({ configured: true, degraded: false, workloads: [], invalid_instances: [], ...state.grouped })
      }
      if (/\/api\/catalog\/[^/]+\/(deploy|teardown)$/.test(url) && init?.method === 'POST') {
        state.posts.push(url)
        return json({ job_id: 7, status: 'launched', request_id: 'r1' })
      }
      return json({})
    }),
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Catalog />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const refetch = () =>
    act(async () => {
      await qc.refetchQueries({ queryKey: ['media-workloads-grouped'] })
    })
  return { state, refetch }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const STALE = () => ({ stale: true, last_success: minutesAgo(1), failure_since: minutesAgo(1) })

async function arm(buttonName: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }))
  fireEvent.change(screen.getByPlaceholderText(/Reason/), { target: { value: 'planned' } })
}

describe('Catalog: writes are withdrawn while the inventory read is stale or failed', () => {
  it('disables an armed deploy Confirm when the read turns stale, then releases it', async () => {
    const { state, refetch } = setup()
    await arm(/Deploy/)
    const confirm = () => screen.getByRole('button', { name: 'Confirm deploy' }) as HTMLButtonElement
    expect(confirm().disabled).toBe(false)

    state.grouped = STALE()
    await refetch()
    await screen.findByText(/This view may be out of date/)
    expect(confirm().disabled).toBe(true)
    fireEvent.click(confirm())
    expect(state.posts).toHaveLength(0)

    state.grouped = {}
    await refetch()
    await waitFor(() => expect(confirm().disabled).toBe(false))
    fireEvent.click(confirm())
    await waitFor(() => expect(state.posts).toHaveLength(1))
    expect(state.posts[0]).toMatch(/\/api\/catalog\/crosspoint\/deploy$/)
  })

  it('disables an armed teardown Confirm while stale', async () => {
    const { state, refetch } = setup('active')
    await arm(/Teardown/)
    state.grouped = STALE()
    await refetch()
    await screen.findByText(/This view may be out of date/)
    const confirm = screen.getByRole('button', { name: /Confirm teardown/i }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(state.posts).toHaveLength(0)
  })

  it('withdraws writes when the read has degraded past the grace window', async () => {
    const { state, refetch } = setup()
    await arm(/Deploy/)
    state.grouped = { degraded: true, reason: 'netbox-unreachable', last_success: minutesAgo(5), failure_since: minutesAgo(3) }
    await refetch()
    await screen.findByText(/offers no changes until a read succeeds/)
    expect((screen.getByRole('button', { name: 'Confirm deploy' }) as HTMLButtonElement).disabled).toBe(true)
    expect(state.posts).toHaveLength(0)
  })

  it('withdraws writes when the console cannot read its own inventory endpoint', async () => {
    const { state, refetch } = setup()
    await arm(/Deploy/)
    state.groupedStatus = 500
    await refetch()
    await screen.findByText(/could not refresh the facility inventory just now/)
    expect((screen.getByRole('button', { name: 'Confirm deploy' }) as HTMLButtonElement).disabled).toBe(true)
    expect(state.posts).toHaveLength(0)
  })

  it('does not withdraw writes for a degraded read caused by conflicting workload tags', async () => {
    const { state, refetch } = setup()
    await arm(/Deploy/)
    state.grouped = { degraded: true }
    await refetch()
    expect((screen.getByRole('button', { name: 'Confirm deploy' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
