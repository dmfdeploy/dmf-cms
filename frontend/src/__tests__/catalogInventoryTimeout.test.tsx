/**
 * The Catalog page waits a bounded time for the inventory to confirm a
 * finished job. When the wait runs out, the card says the result is not
 * confirmed instead of claiming it, and the catalog poll stops. The wait is
 * shortened here so the test does not run for a minute.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Catalog from '../pages/Catalog'
import type { CatalogEntry } from '../api/types'

vi.mock('../lib/inventoryWait', () => ({ INVENTORY_WAIT_MS: 1500 }))

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function catalogEntry(lifecycle: CatalogEntry['lifecycle']): CatalogEntry {
  return {
    key: 'crosspoint',
    display_name: 'MXL Crosspoint',
    summary: '',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle,
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'deploy-crosspoint',
    finalise_awx_job_template: 'teardown-crosspoint',
    dependencies: [],
    ingress_url: null,
  }
}

const server = { catalogLifecycle: 'active' as CatalogEntry['lifecycle'], catalogReads: 0 }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Catalog: the wait for the inventory is bounded', () => {
  it('when the inventory never confirms, the card says so, stops polling, and still takes a later confirmation', async () => {
    server.catalogLifecycle = 'active'
    server.catalogReads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) {
          return json({
            subject: 'ops', display_name: 'Ops', email: 'o@x', role: 'engineer', real_role: 'engineer',
            groups: [], awx_configured: true,
          })
        }
        if (url.endsWith('/api/catalog')) {
          server.catalogReads += 1
          return json({ entries: [catalogEntry(server.catalogLifecycle)] })
        }
        if (url.endsWith('/api/media-workloads/grouped')) {
          return json({ configured: true, degraded: false, workloads: [], invalid_instances: [] })
        }
        if (/\/api\/catalog\/crosspoint\/teardown$/.test(url) && init?.method === 'POST') {
          return json({ job_id: 901, status: 'launched', request_id: 'req-1' })
        }
        if (url.match(/\/api\/catalog\/crosspoint\/status\/901$/)) {
          return json({ job_id: 901, status: 'successful', is_done: true, is_running: false })
        }
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Catalog />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Teardown/ }))
    fireEvent.change(screen.getByPlaceholderText(/Reason/), { target: { value: 'planned' } })
    fireEvent.click(screen.getByRole('button', { name: /Confirm teardown/ }))

    const timedOut =
      /The teardown job for crosspoint finished, but the inventory has not confirmed it yet\. Reload the page to check again\./
    await waitFor(() => expect(document.body.textContent).toMatch(timedOut), { timeout: 8000 })
    expect(document.body.textContent).not.toMatch(/Waiting for the inventory to confirm/)
    expect(screen.getByText('unconfirmed')).toBeTruthy()
    expect(screen.queryByText('active')).toBeNull()

    // The poll has stopped: a poll that kept running would read again within 3 s.
    const readsAtTimeout = server.catalogReads
    await new Promise((resolve) => setTimeout(resolve, 3600))
    expect(server.catalogReads).toBe(readsAtTimeout)

    // A later read that shows the result still replaces the notice.
    server.catalogLifecycle = 'bootstrapped'
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['catalog'] })
    })
    await waitFor(() => expect(screen.getByText('bootstrapped')).toBeTruthy())
    expect(document.body.textContent).not.toMatch(timedOut)
    expect(screen.queryByText('unconfirmed')).toBeNull()
  }, 30_000)
})
