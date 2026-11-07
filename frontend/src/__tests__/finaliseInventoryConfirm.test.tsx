/**
 * A finished teardown used to show late on the workload page, for several
 * independent reasons, and these tests pin each of them:
 *
 * 1. The operation poll did not run while the tab was hidden, and the app's
 *    global `refetchOnWindowFocus: false` meant coming back to the tab did
 *    not refresh it either (T3a-T3c).
 * 2. The automation job can finish before the inventory (catalog) record
 *    changes. The stage then claimed "Teardown of X completed." and offered
 *    Teardown again while the entry still read `active`, and nothing
 *    re-read the catalog until the next window focus (T1, T2, T4).
 * 3. With two functions, each pending entry has to stay guarded until its own
 *    inventory record changes, whatever happens to the other entry's teardown
 *    (T5a, T5b), and the catalog poll has to keep running in a hidden tab (T6).
 * 4. A teardown can also hand off from the operation to its automation job
 *    (`launched` with a job id). That path has to reach the same inventory
 *    confirmation (T7a, T7b, T7c) and has to keep polling in a hidden tab
 *    (T8a, T8b).
 *
 * jsdom and TanStack Query: @tanstack/query-core 5.100.7 listens only for
 * `visibilitychange` on `window` and reads `document.visibilityState`. It no
 * longer listens for `focus`, so the `focus` events dispatched below are
 * what a browser also sends but are inert here; `visibilitychange` is the
 * event that drives the refetch. jsdom reports `visible` by default, so the
 * hidden state is simulated by redefining `document.visibilityState`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import { JobStatusLine, OperationStatusLine } from '../pages/MediaWorkloads/stages/JobProgress'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import type { CatalogEntry, MediaWorkload, MediaWorkloadsGroupedResponse } from '../api/types'

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'crosspoint',
    display_name: 'MXL Crosspoint',
    summary: '',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'active',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'deploy-crosspoint',
    finalise_awx_job_template: 'teardown-crosspoint',
    dependencies: [],
    ingress_url: null,
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function operation(state: string) {
  return {
    operation_id: 'op-inv', action: 'teardown', target: 'crosspoint', state,
    job_id: 9001, error: null, created_at: 't0', updated_at: 't1',
  }
}

// The same QueryClient defaults as main.tsx, except retry: main.tsx sets
// `retry: 1`; retries are off here so a failed read never hides behind one.
function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
}

interface Server {
  catalogLifecycle: CatalogEntry['lifecycle']
  operationState: string
  catalogReads: number
  operationReads: number
}

function stubServer(initial: Partial<Server> = {}): Server {
  const server: Server = {
    catalogLifecycle: 'active',
    operationState: 'run_complete',
    catalogReads: 0,
    operationReads: 0,
    ...initial,
  }
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true, degraded: false, scope: [], invalid_instances: [],
    workloads: [offFlowWorkload()],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/catalog')) {
        server.catalogReads += 1
        return json({ entries: [catalogEntry({ lifecycle: server.catalogLifecycle })] })
      }
      if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
      if (url.match(/\/api\/catalog\/crosspoint\/teardown$/)) {
        return json({ ...operation('waking'), job_id: null, request_id: 'req-inv' })
      }
      if (url.endsWith('/api/operations/op-inv')) {
        server.operationReads += 1
        return json(operation(server.operationState))
      }
      return json({})
    }),
  )
  return server
}

const KEY_A = 'crosspoint'
const KEY_B = 'switch'

interface TwoServer {
  lifecycle: Record<string, CatalogEntry['lifecycle']>
  outcome: Record<string, string>
}

// Two active functions, each torn down by its own operation (`op-<key>`).
// Tearing an entry down moves its inventory record to `bootstrapped` only when
// the test says so, which is how a lagging inventory is simulated per entry.
function stubTwoFunctionServer(initial: Partial<TwoServer> = {}): TwoServer {
  const server: TwoServer = {
    lifecycle: { [KEY_A]: 'active', [KEY_B]: 'active' },
    outcome: { [KEY_A]: 'run_complete', [KEY_B]: 'run_complete' },
    ...initial,
  }
  const workload: MediaWorkload = {
    ...offFlowWorkload(),
    functions: [
      { function_key: KEY_A, count: 1, running: 1, reconcile_pending: 0 },
      { function_key: KEY_B, count: 1, running: 1, reconcile_pending: 0 },
    ],
  }
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true, degraded: false, scope: [], invalid_instances: [], workloads: [workload],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/catalog')) {
        return json({
          entries: [
            catalogEntry({ key: KEY_A, display_name: 'MXL Crosspoint', lifecycle: server.lifecycle[KEY_A] }),
            catalogEntry({ key: KEY_B, display_name: 'MXL Switch', lifecycle: server.lifecycle[KEY_B] }),
          ],
        })
      }
      if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
      const teardown = url.match(/\/api\/catalog\/([a-z]+)\/teardown$/)
      if (teardown) {
        const key = teardown[1]
        return json({
          operation_id: `op-${key}`, action: 'teardown', target: key, state: 'waking',
          job_id: null, error: null, created_at: 't0', updated_at: 't0', request_id: `req-${key}`,
        })
      }
      const op = url.match(/\/api\/operations\/op-([a-z]+)$/)
      if (op) {
        const key = op[1]
        return json({
          operation_id: `op-${key}`, action: 'teardown', target: key, state: server.outcome[key],
          job_id: 9001, error: server.outcome[key] === 'run_failed' ? 'ansible-timeout' : null,
          created_at: 't0', updated_at: 't1',
        })
      }
      return json({})
    }),
  )
  return server
}

interface JobServer {
  catalogLifecycle: CatalogEntry['lifecycle']
  jobStatus: string
  jobDone: boolean
  catalogReads: number
  jobReads: number
}

// The `launched` -> job-id path: the teardown operation reports `launched`
// with a job id (and never moves on), and the job itself is polled by id.
function stubJobPathServer(initial: Partial<JobServer> = {}): JobServer {
  const server: JobServer = {
    catalogLifecycle: 'active',
    jobStatus: 'successful',
    jobDone: true,
    catalogReads: 0,
    jobReads: 0,
    ...initial,
  }
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true, degraded: false, scope: [], invalid_instances: [],
    workloads: [offFlowWorkload()],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/catalog')) {
        server.catalogReads += 1
        return json({ entries: [catalogEntry({ lifecycle: server.catalogLifecycle })] })
      }
      if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
      if (url.match(/\/api\/catalog\/crosspoint\/teardown$/)) {
        return json({ ...operation('waking'), job_id: null, request_id: 'req-inv' })
      }
      if (url.endsWith('/api/operations/op-inv')) return json({ ...operation('launched'), job_id: 7001 })
      if (url.match(/\/api\/catalog\/crosspoint\/status\/7001$/)) {
        server.jobReads += 1
        return json({
          job_id: 7001, status: server.jobStatus, is_done: server.jobDone,
          is_running: !server.jobDone,
        })
      }
      return json({})
    }),
  )
  return server
}

function waitingFor(key: string): RegExp {
  return new RegExp(`The teardown job for ${key} finished\\. Waiting for the inventory to confirm\\.`)
}

function teardownButtons(finalise: HTMLElement): HTMLElement[] {
  return within(finalise).queryAllByRole('button', { name: /Teardown/ })
}

function offFlowWorkload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'operate',
    health: 'ok',
    instances: [],
    functions: [{ function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 }],
  }
}

function renderDetail(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/media-workloads/studio-a/setup']}>
        <Routes>
          <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function stageSection(label: string): HTMLElement {
  return screen.getByRole('heading', { name: label, level: 2 }).closest('[data-step-state]') as HTMLElement
}

async function mountFinalise(queryClient: QueryClient) {
  const view = renderDetail(queryClient)
  await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
  const finalise = stageSection('Finalise & Review')
  await within(finalise).findAllByRole('button', { name: /Teardown/ })
  return { view, finalise }
}

function armAndConfirmTeardown(finalise: HTMLElement) {
  fireEvent.click(within(finalise).getAllByRole('button', { name: /Teardown/ })[0])
  fireEvent.change(within(finalise).getAllByRole('textbox')[0], { target: { value: 'go' } })
  fireEvent.click(within(finalise).getByRole('button', { name: /Confirm teardown/ }))
}

const WAITING = /The teardown job for crosspoint finished\. Waiting for the inventory to confirm\./
const COMPLETED = 'Teardown of crosspoint completed.'

function setTabHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
  if (!hidden) window.dispatchEvent(new Event('focus'))
}

afterEach(() => {
  cleanup()
  // Remove the own-property override so jsdom's `visible` default applies.
  delete (document as { visibilityState?: unknown }).visibilityState
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Finalise & Review: the inventory has to confirm a finished teardown', () => {
  it('T1: run_complete with the catalog still active shows the waiting line, not "completed", and no Teardown button', async () => {
    stubServer({ catalogLifecycle: 'active', operationState: 'run_complete' })
    const { finalise } = await mountFinalise(newQueryClient())
    armAndConfirmTeardown(finalise)

    // The operation reaches run_complete on the first poll; the hand-off to
    // the review is paced (about one second).
    await waitFor(() => expect(finalise.textContent).toMatch(WAITING), { timeout: 4000 })
    expect(finalise.textContent).not.toContain(COMPLETED)
    expect(within(finalise).queryByRole('button', { name: /Teardown/ })).toBeNull()
  }, 20_000)

  it('T2: once the catalog stops reporting active, the stage confirms within 5 s with no focus event', async () => {
    const server = stubServer({ catalogLifecycle: 'active', operationState: 'run_complete' })
    const { finalise } = await mountFinalise(newQueryClient())
    armAndConfirmTeardown(finalise)
    await waitFor(() => expect(finalise.textContent).toMatch(WAITING), { timeout: 4000 })

    server.catalogLifecycle = 'bootstrapped'

    await waitFor(() => expect(within(finalise).getByText('Not currently deployed.')).toBeTruthy(), { timeout: 5000 })
    expect(finalise.textContent).not.toMatch(WAITING)
    expect(finalise.textContent).toContain(COMPLETED)
    expect(within(finalise).queryByRole('button', { name: /Teardown/ })).toBeNull()
  }, 20_000)

  it('T4: mount -> pending -> unmount while pending -> remount: no leaked poll, and the remount reads the catalog alone', async () => {
    const server = stubServer({ catalogLifecycle: 'active', operationState: 'run_complete' })
    const queryClient = newQueryClient()
    const first = await mountFinalise(queryClient)
    armAndConfirmTeardown(first.finalise)
    await waitFor(() => expect(first.finalise.textContent).toMatch(WAITING), { timeout: 4000 })

    // Unmount while the inventory is still pending.
    first.view.unmount()
    const readsAtUnmount = server.catalogReads
    // Longer than one 3 s poll interval: a leaked interval would read again.
    await new Promise((resolve) => setTimeout(resolve, 3600))
    expect(server.catalogReads).toBe(readsAtUnmount)

    // Remount: the catalog still says active, and the stage must not remember
    // the earlier pending state or the earlier outcome.
    const second = await mountFinalise(queryClient)
    expect(second.finalise.textContent).not.toMatch(WAITING)
    expect(second.finalise.textContent).not.toContain(COMPLETED)
    // The control is available again: a single use does not retire it.
    fireEvent.click(within(second.finalise).getByRole('button', { name: /Teardown/ }))
    expect(within(second.finalise).getByRole('button', { name: /Confirm teardown/ })).toBeTruthy()

    // The remounted stage is not polling either.
    const readsAtRemount = server.catalogReads
    await new Promise((resolve) => setTimeout(resolve, 3600))
    expect(server.catalogReads).toBe(readsAtRemount)
  }, 30_000)
})

describe('Finalise & Review: two entries pending on the inventory are tracked independently', () => {
  // Entry A finishes while its inventory record still says `active`; entry B
  // is then torn down and reaches `outcomeB`. A must keep its guard, its
  // waiting line and the catalog poll, until A's own record changes.
  async function pendingAThenB(outcomeB: 'run_complete' | 'run_failed') {
    const server = stubTwoFunctionServer()
    const { finalise } = await mountFinalise(newQueryClient())
    armAndConfirmTeardown(finalise)
    await waitFor(() => expect(finalise.textContent).toMatch(waitingFor(KEY_A)), { timeout: 4000 })
    // A's button is withheld, so the only Teardown button now belongs to B.
    expect(teardownButtons(finalise)).toHaveLength(1)

    server.outcome[KEY_B] = outcomeB
    if (outcomeB === 'run_complete') server.lifecycle[KEY_B] = 'bootstrapped'
    armAndConfirmTeardown(finalise)
    await waitFor(
      () => expect(finalise.textContent).toMatch(
        outcomeB === 'run_complete' ? /Teardown of switch completed\./ : /Teardown of switch did not complete/,
      ),
      { timeout: 4000 },
    )
    return { server, finalise }
  }

  function entryOf(button: HTMLElement): string {
    return button.closest('.border-t')?.textContent ?? ''
  }

  it('T5a: B succeeding while A is still active leaves A guarded, then A confirms', async () => {
    const { server, finalise } = await pendingAThenB('run_complete')

    expect(finalise.textContent).toMatch(waitingFor(KEY_A))
    expect(teardownButtons(finalise)).toHaveLength(0)

    server.lifecycle[KEY_A] = 'bootstrapped'
    await waitFor(() => expect(finalise.textContent).not.toMatch(waitingFor(KEY_A)), { timeout: 5000 })
    expect(within(finalise).getAllByText('Not currently deployed.')).toHaveLength(2)
    expect(teardownButtons(finalise)).toHaveLength(0)
  }, 30_000)

  it('T5b: B failing while A is still active leaves A guarded, then A confirms', async () => {
    const { server, finalise } = await pendingAThenB('run_failed')

    expect(finalise.textContent).toMatch(waitingFor(KEY_A))
    // Only B, whose teardown failed and which is still active, offers Teardown.
    const buttons = teardownButtons(finalise)
    expect(buttons).toHaveLength(1)
    expect(entryOf(buttons[0])).toContain('MXL Switch')

    server.lifecycle[KEY_A] = 'bootstrapped'
    await waitFor(() => expect(finalise.textContent).not.toMatch(waitingFor(KEY_A)), { timeout: 5000 })
    expect(within(finalise).getAllByText('Not currently deployed.')).toHaveLength(1)
    expect(teardownButtons(finalise)).toHaveLength(1)
    expect(entryOf(teardownButtons(finalise)[0])).toContain('MXL Switch')
  }, 30_000)
})

describe('Finalise & Review: the inventory poll runs in a hidden tab', () => {
  it('T6: run_complete while hidden, then the catalog flips while still hidden: the stage confirms without the tab returning', async () => {
    const server = stubServer({ catalogLifecycle: 'active', operationState: 'running' })
    const { finalise } = await mountFinalise(newQueryClient())
    armAndConfirmTeardown(finalise)
    await within(finalise).findByText('Running', {}, { timeout: 4000 })

    setTabHidden(true)
    server.operationState = 'run_complete'
    await waitFor(() => expect(finalise.textContent).toMatch(WAITING), { timeout: 8000 })

    server.catalogLifecycle = 'bootstrapped'
    const readsWhenFlipped = server.catalogReads
    await waitFor(() => expect(within(finalise).getByText('Not currently deployed.')).toBeTruthy(), { timeout: 6000 })
    expect(server.catalogReads).toBeGreaterThan(readsWhenFlipped)
    expect(finalise.textContent).not.toMatch(WAITING)
  }, 40_000)
})

describe('Finalise & Review: the launched -> job-id path confirms against the inventory too', () => {
  it('T7a: a successful job with the catalog still active shows the waiting line and no Teardown button, then confirms', async () => {
    const server = stubJobPathServer({ catalogLifecycle: 'active', jobStatus: 'successful', jobDone: true })
    const { finalise } = await mountFinalise(newQueryClient())
    armAndConfirmTeardown(finalise)

    // Hand-off to the job (about 1 s), then the paced completion (2 s).
    await waitFor(() => expect(finalise.textContent).toMatch(waitingFor('crosspoint')), { timeout: 10_000 })
    expect(within(finalise).queryByRole('button', { name: /Teardown/ })).toBeNull()

    server.catalogLifecycle = 'bootstrapped'
    await waitFor(() => expect(within(finalise).getByText('Not currently deployed.')).toBeTruthy(), { timeout: 5000 })
    expect(finalise.textContent).not.toMatch(waitingFor('crosspoint'))
    expect(within(finalise).queryByRole('button', { name: /Teardown/ })).toBeNull()
  }, 40_000)

  it('T7b: a failed job never claims the inventory is pending, and offers Teardown again', async () => {
    stubJobPathServer({ catalogLifecycle: 'active', jobStatus: 'failed', jobDone: true })
    const { finalise } = await mountFinalise(newQueryClient())
    armAndConfirmTeardown(finalise)

    await waitFor(() => expect(finalise.textContent).toMatch(/Last job: #7001/), { timeout: 10_000 })
    // The in-flight tracker clears (the Teardown button returns) once the job completes.
    await within(finalise).findByRole('button', { name: /Teardown/ }, { timeout: 5000 })
    expect(finalise.textContent).not.toMatch(waitingFor('crosspoint'))
  }, 40_000)

  it('T7c: a pending key is released even when the catalog already read non-active, so a later redeploy is not held back', async () => {
    const server = stubJobPathServer({ catalogLifecycle: 'active', jobStatus: 'running', jobDone: false })
    const queryClient = newQueryClient()
    const refreshCatalog = () => act(() => queryClient.invalidateQueries({ queryKey: ['catalog'] }))
    const { finalise } = await mountFinalise(queryClient)
    armAndConfirmTeardown(finalise)
    await within(finalise).findByText(/job #7001/, {}, { timeout: 5000 })

    // The inventory catches up before the job is reported done, and the stage
    // reads it. When the job then finishes, the catalog read it triggers is
    // identical to the one already held, so the stage's data does not change.
    server.catalogLifecycle = 'bootstrapped'
    await refreshCatalog()
    server.jobStatus = 'successful'
    server.jobDone = true
    await waitFor(() => expect(within(finalise).getByText('Not currently deployed.')).toBeTruthy(), { timeout: 10_000 })
    expect(finalise.textContent).not.toMatch(waitingFor('crosspoint'))

    // The entry is deployed again. Nothing about the finished teardown may
    // still hold it back.
    server.catalogLifecycle = 'active'
    await refreshCatalog()
    await within(finalise).findByRole('button', { name: /Teardown/ }, { timeout: 5000 })
    expect(finalise.textContent).not.toMatch(waitingFor('crosspoint'))
  }, 40_000)

  it('T8a: the job finishes while the tab is hidden: the stage still reaches the waiting line, then confirms while hidden', async () => {
    const server = stubJobPathServer({ catalogLifecycle: 'active', jobStatus: 'running', jobDone: false })
    const { finalise } = await mountFinalise(newQueryClient())
    armAndConfirmTeardown(finalise)
    await within(finalise).findByText(/job #7001/, {}, { timeout: 5000 })

    setTabHidden(true)
    server.jobStatus = 'successful'
    server.jobDone = true
    await waitFor(() => expect(finalise.textContent).toMatch(waitingFor('crosspoint')), { timeout: 10_000 })

    server.catalogLifecycle = 'bootstrapped'
    await waitFor(() => expect(within(finalise).getByText('Not currently deployed.')).toBeTruthy(), { timeout: 6000 })
  }, 40_000)
})

describe('useOperationStatus: a hidden tab does not delay the outcome', () => {
  function renderLine() {
    const queryClient = newQueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <OperationStatusLine operationId="op-inv" onLaunched={() => {}} onError={() => {}} />
      </QueryClientProvider>,
    )
  }

  it('T3a: becoming visible again fetches the outcome faster than the next 3 s tick', async () => {
    const server = stubServer({ operationState: 'running' })
    renderLine()
    await screen.findByText('Running')
    const seenAt = performance.now()

    setTabHidden(true)
    server.operationState = 'run_complete'
    setTabHidden(false)

    await screen.findByText('Complete', {}, { timeout: 1500 })
    // The interval tick is 3 s after the first read; this arrived well before.
    expect(performance.now() - seenAt).toBeLessThan(2500)
  }, 20_000)

  it('T3b: polling continues while the tab stays hidden', async () => {
    const server = stubServer({ operationState: 'running' })
    renderLine()
    await screen.findByText('Running')

    setTabHidden(true)
    server.operationState = 'run_complete'

    await screen.findByText('Complete', {}, { timeout: 5000 })
  }, 20_000)

  it('T3c: a settled operation is not refetched when the tab becomes visible', async () => {
    const server = stubServer({ operationState: 'run_complete' })
    renderLine()
    await screen.findByText('Complete')
    const reads = server.operationReads

    setTabHidden(true)
    setTabHidden(false)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(server.operationReads).toBe(reads)
  })
})

describe('useCatalogJobStatus: a hidden tab does not delay the job outcome', () => {
  it('T8b: becoming visible again fetches the job outcome faster than the next 2 s tick', async () => {
    const server = stubJobPathServer({ jobStatus: 'running', jobDone: false })
    render(
      <QueryClientProvider client={newQueryClient()}>
        <JobStatusLine entryKey="crosspoint" jobId={7001} onComplete={() => {}} />
      </QueryClientProvider>,
    )
    await screen.findByText(/Running/)
    const reads = server.jobReads

    setTabHidden(true)
    server.jobStatus = 'successful'
    server.jobDone = true
    setTabHidden(false)

    await screen.findByText('Successful', {}, { timeout: 1500 })
    expect(server.jobReads).toBeGreaterThan(reads)
  }, 20_000)
})
