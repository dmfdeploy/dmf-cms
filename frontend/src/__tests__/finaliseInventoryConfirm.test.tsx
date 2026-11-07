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
 *
 * jsdom and TanStack Query: @tanstack/query-core 5.100.7 listens only for
 * `visibilitychange` on `window` and reads `document.visibilityState`. It no
 * longer listens for `focus`, so the `focus` events dispatched below are
 * what a browser also sends but are inert here; `visibilitychange` is the
 * event that drives the refetch. jsdom reports `visible` by default, so the
 * hidden state is simulated by redefining `document.visibilityState`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import { OperationStatusLine } from '../pages/MediaWorkloads/stages/JobProgress'
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
