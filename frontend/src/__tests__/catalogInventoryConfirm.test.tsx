/**
 * After a deploy or teardown job, the Catalog page must not show the
 * entry's lifecycle from the catalog until the inventory confirms the result.
 * The automation job can finish before the inventory record changes; the card
 * then says the job finished and that it is waiting for the inventory, offers
 * no action on the old record, and shows the confirmed state once the record
 * catches up.
 *
 * jsdom has no real visibility API, so the hidden state is simulated by
 * redefining `document.visibilityState`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Catalog from '../pages/Catalog'
import type { CatalogEntry, OperationState } from '../api/types'

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

interface Server {
  catalogLifecycle: CatalogEntry['lifecycle']
  jobStatus: string
  catalogReads: number
  // When set, deploy and teardown return a watched operation (202) that
  // reads at this state from the first poll on, never passing through
  // `launched`.
  operationState: OperationState | null
}

function stubServer(initial: Partial<Server> = {}): Server {
  const server: Server = { catalogLifecycle: 'bootstrapped', jobStatus: 'successful', catalogReads: 0, operationState: null, ...initial }
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
      if (/\/api\/catalog\/crosspoint\/(deploy|teardown)$/.test(url) && init?.method === 'POST' && server.operationState) {
        return json({ operation_id: 'op-0123456789', state: 'waking', request_id: 'req-1' }, 202)
      }
      if (url.endsWith('/api/operations/op-0123456789') && server.operationState) {
        return json({
          operation_id: 'op-0123456789', action: url.includes('teardown') ? 'teardown' : 'deploy', target: 'crosspoint',
          state: server.operationState, job_id: null,
          error: server.operationState === 'run_failed' ? 'job failed' : null,
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        })
      }
      if (/\/api\/catalog\/crosspoint\/(deploy|teardown)$/.test(url) && init?.method === 'POST') {
        return json({ job_id: 901, status: 'launched', request_id: 'req-1' })
      }
      if (url.match(/\/api\/catalog\/crosspoint\/status\/901$/)) {
        const done = server.jobStatus !== 'running'
        return json({ job_id: 901, status: server.jobStatus, is_done: done, is_running: !done })
      }
      return json({})
    }),
  )
  return server
}

function renderCatalog() {
  // The same QueryClient defaults as main.tsx, except retry.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Catalog />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function arm(buttonName: RegExp, confirmName: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }))
  fireEvent.change(screen.getByPlaceholderText(/Reason/), { target: { value: 'planned' } })
  fireEvent.click(screen.getByRole('button', { name: confirmName }))
}

const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement
const waiting = (kind: 'deploy' | 'teardown') =>
  new RegExp(`The ${kind} job for crosspoint finished\\. Waiting for the inventory to confirm\\.`)

function setTabHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
}

afterEach(() => {
  cleanup()
  // Remove the own-property override so jsdom's `visible` default applies.
  delete (document as { visibilityState?: unknown }).visibilityState
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Catalog: the inventory has to confirm a finished deploy or teardown', () => {
  it('a deployed entry still bootstrapped shows the waiting line and no lifecycle, then the confirmed state', async () => {
    const server = stubServer({ catalogLifecycle: 'bootstrapped', jobStatus: 'successful' })
    renderCatalog()
    await arm(/Deploy/, /Confirm deploy/)

    // The job is done on the first poll; the hand-off is paced (2 s).
    await waitFor(() => expect(document.body.textContent).toMatch(waiting('deploy')), { timeout: 8000 })
    expect(screen.getByText('unconfirmed')).toBeTruthy()
    expect(screen.queryByText('bootstrapped')).toBeNull()
    expect(button(/Deploy/).disabled).toBe(true)
    expect(button(/Teardown/).disabled).toBe(true)

    server.catalogLifecycle = 'active'
    await waitFor(() => expect(screen.getByText('active')).toBeTruthy(), { timeout: 6000 })
    expect(document.body.textContent).not.toMatch(waiting('deploy'))
    expect(screen.queryByText('unconfirmed')).toBeNull()
    expect(button(/Teardown/).disabled).toBe(false)
  }, 30_000)

  it('a torn down entry still active shows the waiting line and no lifecycle, then the confirmed state', async () => {
    const server = stubServer({ catalogLifecycle: 'active', jobStatus: 'successful' })
    renderCatalog()
    await arm(/Teardown/, /Confirm teardown/)

    await waitFor(() => expect(document.body.textContent).toMatch(waiting('teardown')), { timeout: 8000 })
    expect(screen.getByText('unconfirmed')).toBeTruthy()
    expect(screen.queryByText('active')).toBeNull()
    expect(button(/Teardown/).disabled).toBe(true)
    expect(button(/Deploy/).disabled).toBe(true)

    server.catalogLifecycle = 'bootstrapped'
    await waitFor(() => expect(screen.getByText('bootstrapped')).toBeTruthy(), { timeout: 6000 })
    expect(document.body.textContent).not.toMatch(waiting('teardown'))
    expect(button(/Deploy/).disabled).toBe(false)
  }, 30_000)

  it('a failed job never says it is waiting for the inventory', async () => {
    stubServer({ catalogLifecycle: 'bootstrapped', jobStatus: 'failed' })
    renderCatalog()
    await arm(/Deploy/, /Confirm deploy/)

    // The in-flight tracker clears (the Deploy button returns) once the job completes.
    await waitFor(() => expect(button(/Deploy/).disabled).toBe(false), { timeout: 8000 })
    expect(document.body.textContent).not.toMatch(waiting('deploy'))
    expect(screen.queryByText('unconfirmed')).toBeNull()
    expect(screen.getByText('bootstrapped')).toBeTruthy()
    // Nothing is in flight for the other action either, so it does not read as running.
    expect(screen.getByRole('button', { name: '⏏ Teardown' })).toBeTruthy()
  }, 30_000)

  it('the job finishes while the tab is hidden: the page reaches the waiting line and confirms while hidden', async () => {
    const server = stubServer({ catalogLifecycle: 'bootstrapped', jobStatus: 'running' })
    renderCatalog()
    await arm(/Deploy/, /Confirm deploy/)
    await screen.findByText(/job #901/, {}, { timeout: 5000 })

    setTabHidden(true)
    server.jobStatus = 'successful'
    await waitFor(() => expect(document.body.textContent).toMatch(waiting('deploy')), { timeout: 10_000 })

    server.catalogLifecycle = 'active'
    const readsWhenFlipped = server.catalogReads
    await waitFor(() => expect(screen.getByText('active')).toBeTruthy(), { timeout: 6000 })
    expect(server.catalogReads).toBeGreaterThan(readsWhenFlipped)
    expect(document.body.textContent).not.toMatch(waiting('deploy'))
  }, 40_000)

  it('a deploy operation that goes straight to run_complete waits for the inventory, then confirms', async () => {
    const server = stubServer({ catalogLifecycle: 'bootstrapped', operationState: 'run_complete' })
    renderCatalog()
    await arm(/Deploy/, /Confirm deploy/)

    await waitFor(() => expect(document.body.textContent).toMatch(waiting('deploy')), { timeout: 8000 })
    expect(screen.getByText('unconfirmed')).toBeTruthy()
    expect(button(/Deploy/).disabled).toBe(true)

    server.catalogLifecycle = 'active'
    await waitFor(() => expect(screen.getByText('active')).toBeTruthy(), { timeout: 6000 })
    expect(document.body.textContent).not.toMatch(waiting('deploy'))
    expect(screen.queryByText('unconfirmed')).toBeNull()
    expect(button(/Teardown/).disabled).toBe(false)
  }, 30_000)

  it('a teardown operation that goes straight to run_complete waits for the inventory, then confirms', async () => {
    const server = stubServer({ catalogLifecycle: 'active', operationState: 'run_complete' })
    renderCatalog()
    await arm(/Teardown/, /Confirm teardown/)

    await waitFor(() => expect(document.body.textContent).toMatch(waiting('teardown')), { timeout: 8000 })
    expect(screen.getByText('unconfirmed')).toBeTruthy()
    expect(button(/Teardown/).disabled).toBe(true)

    server.catalogLifecycle = 'bootstrapped'
    await waitFor(() => expect(screen.getByText('bootstrapped')).toBeTruthy(), { timeout: 6000 })
    expect(document.body.textContent).not.toMatch(waiting('teardown'))
    expect(button(/Deploy/).disabled).toBe(false)
  }, 30_000)

  it('a deploy operation that ends run_failed releases the action and claims no deployed state', async () => {
    stubServer({ catalogLifecycle: 'bootstrapped', operationState: 'run_failed' })
    renderCatalog()
    await arm(/Deploy/, /Confirm deploy/)

    await waitFor(() => expect(button(/Deploy/).disabled).toBe(false), { timeout: 8000 })
    expect(document.body.textContent).not.toMatch(waiting('deploy'))
    expect(screen.queryByText('unconfirmed')).toBeNull()
    expect(screen.getByText('bootstrapped')).toBeTruthy()
    expect(screen.queryByText('active')).toBeNull()
  }, 30_000)
})
