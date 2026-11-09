/**
 * After a deploy, the Provision stage must not claim the outcome from the
 * catalog until the inventory confirms it. The automation job can finish
 * before the inventory record changes; the stage then says the job finished
 * and that it is waiting for the inventory, and shows the confirmed state
 * once the record catches up.
 *
 * jsdom has no real visibility API, so the hidden state is simulated by
 * redefining `document.visibilityState`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import ProvisionStage from '../pages/MediaWorkloads/stages/ProvisionStage'
import type { CatalogEntry, MediaWorkload } from '../api/types'

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

const WORKLOAD: MediaWorkload = {
  slug: 'studio-a',
  name: 'studio-a',
  lifecycle: 'provision',
  health: 'ok',
  instances: [],
  functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
}

interface Server {
  catalogLifecycle: CatalogEntry['lifecycle']
  // How the deploy is launched: a job id straight away, or an operation that
  // settles at `operationState`.
  path: 'job' | 'operation'
  jobStatus: string
  operationState: string
  catalogReads: number
}

function stubServer(initial: Partial<Server> = {}): Server {
  const server: Server = {
    catalogLifecycle: 'bootstrapped',
    path: 'job',
    jobStatus: 'successful',
    operationState: 'run_complete',
    catalogReads: 0,
    ...initial,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return json({ subject: 'ops', role: 'operator' })
      if (url.endsWith('/api/catalog')) {
        server.catalogReads += 1
        return json({ entries: [catalogEntry(server.catalogLifecycle)] })
      }
      if (url.match(/\/api\/catalog\/crosspoint\/deploy$/) && init?.method === 'POST') {
        if (server.path === 'operation') {
          return json({
            operation_id: 'op-dep', action: 'deploy', target: 'crosspoint', state: 'waking',
            job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: 'req-dep',
          })
        }
        return json({ job_id: 801, status: 'launched', request_id: 'req-dep' })
      }
      if (url.endsWith('/api/operations/op-dep')) {
        return json({
          operation_id: 'op-dep', action: 'deploy', target: 'crosspoint', state: server.operationState,
          job_id: 801, error: null, created_at: 't0', updated_at: 't1',
        })
      }
      if (url.match(/\/api\/catalog\/crosspoint\/status\/801$/)) {
        const done = server.jobStatus !== 'running'
        return json({ job_id: 801, status: server.jobStatus, is_done: done, is_running: !done })
      }
      return json({})
    }),
  )
  return server
}

function renderStage() {
  // The same QueryClient defaults as main.tsx, except retry.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProvisionStage
          workload={WORKLOAD}
          state="active"
          actions={['deploy']}
          onBusyChange={vi.fn()}
          onJobStart={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function deploy() {
  fireEvent.click(await screen.findByRole('button', { name: '▶ Deploy' }))
  fireEvent.change(screen.getByPlaceholderText(/Reason/), { target: { value: 'planned' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm deploy' }))
}

const WAITING = /The deploy job for crosspoint finished\. Waiting for the inventory to confirm\./

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

describe('Provision: the inventory has to confirm a finished deploy', () => {
  it('a successful job with the catalog still bootstrapped shows the waiting line, then the confirmed state', async () => {
    const server = stubServer({ catalogLifecycle: 'bootstrapped', jobStatus: 'successful' })
    renderStage()
    await deploy()

    // The job is done on the first poll; the hand-off is paced (2 s).
    await waitFor(() => expect(document.body.textContent).toMatch(WAITING), { timeout: 8000 })
    expect(screen.queryByRole('button', { name: '▶ Deploy' })).toBeNull()
    expect(document.body.textContent).not.toContain('Already deployed.')

    server.catalogLifecycle = 'active'
    await waitFor(() => expect(screen.getByText('Already deployed.')).toBeTruthy(), { timeout: 6000 })
    expect(document.body.textContent).not.toMatch(WAITING)
    expect(screen.queryByRole('button', { name: '▶ Deploy' })).toBeNull()
  }, 30_000)

  it('an operation that ends at run_complete is held to the same confirmation', async () => {
    const server = stubServer({ path: 'operation', operationState: 'run_complete', catalogLifecycle: 'bootstrapped' })
    renderStage()
    await deploy()

    await waitFor(() => expect(document.body.textContent).toMatch(WAITING), { timeout: 8000 })
    expect(screen.queryByRole('button', { name: '▶ Deploy' })).toBeNull()

    server.catalogLifecycle = 'active'
    await waitFor(() => expect(screen.getByText('Already deployed.')).toBeTruthy(), { timeout: 6000 })
    expect(document.body.textContent).not.toMatch(WAITING)
  }, 30_000)

  it('a failed job never says it is waiting for the inventory, and offers Deploy again', async () => {
    stubServer({ catalogLifecycle: 'bootstrapped', jobStatus: 'failed' })
    renderStage()
    await deploy()

    // The in-flight tracker clears (the Deploy button returns) once the job completes.
    await screen.findByRole('button', { name: '▶ Deploy' }, { timeout: 8000 })
    expect(document.body.textContent).not.toMatch(WAITING)
    expect(document.body.textContent).not.toContain('Already deployed.')
  }, 30_000)

  it('the job finishes while the tab is hidden: the stage still reaches the waiting line and confirms while hidden', async () => {
    const server = stubServer({ catalogLifecycle: 'bootstrapped', jobStatus: 'running' })
    renderStage()
    await deploy()
    await screen.findByText(/job #801/, {}, { timeout: 5000 })

    setTabHidden(true)
    server.jobStatus = 'successful'
    await waitFor(() => expect(document.body.textContent).toMatch(WAITING), { timeout: 10_000 })

    server.catalogLifecycle = 'active'
    const readsWhenFlipped = server.catalogReads
    await waitFor(() => expect(screen.getByText('Already deployed.')).toBeTruthy(), { timeout: 6000 })
    expect(server.catalogReads).toBeGreaterThan(readsWhenFlipped)
    expect(document.body.textContent).not.toMatch(WAITING)
  }, 40_000)
})
