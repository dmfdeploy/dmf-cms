/**
 * dmfdeploy#319: a confirmation armed while the inventory was fresh must not
 * send its write once the inventory turns stale or degraded.
 *
 * Each case arms the control, types the reason, turns the inventory stale,
 * and presses Confirm. No request may reach the write endpoint, and the typed
 * reason survives so the operator can confirm after the next good read.
 * Deploy and teardown run through the real route and grouped query; the
 * other mutating confirms (switch source, delete permanently, clear for
 * deployment) run through their own components with the same provider the
 * route supplies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadSetup from '../pages/MediaWorkloads/WorkloadSetup'
import ConfigureStage from '../pages/MediaWorkloads/stages/ConfigureStage'
import FinaliseStage from '../pages/MediaWorkloads/stages/FinaliseStage'
import ClearForDeployment from '../pages/MediaWorkloads/ClearForDeployment'
import {
  InventoryWritesBlockedError,
  InventoryWritesBlockedProvider,
  useGuardWrite,
} from '../lib/inventoryFreshness'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import type { MediaWorkload, MediaWorkloadInstance, UserIdentity } from '../api/types'

const WRITE = /\/(deploy|teardown|switch-source|purge)$/

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
}

function instance(o: Partial<MediaWorkloadInstance> = {}): MediaWorkloadInstance & {
  workload_assignment: string
} {
  return {
    instance: 'viewer-1',
    netbox_id: 1,
    function_key: 'crosspoint',
    live_view: false,
    requested_state: 'active',
    observed_state: 'running',
    reconcile_pending: false,
    placement: { node: 'node-1', ports: [], protocol: null },
    workload_assignment: 'ok',
    ...o,
  }
}

function workload(o: Partial<MediaWorkload> = {}): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'operate',
    health: 'ok',
    instances: [instance()],
    functions: [{ function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 }],
    ...o,
  }
}

const CATALOG = {
  key: 'crosspoint',
  display_name: 'MXL Crosspoint',
  summary: 's',
  lifecycle: 'active',
  configure_awx_job_template: 'deploy-crosspoint',
  finalise_awx_job_template: 'teardown-crosspoint',
  dependencies: [],
}

const OPERATOR: UserIdentity = {
  subject: 'ops',
  display_name: 'Ops',
  email: 'o@x',
  role: 'engineer',
  real_role: 'engineer',
  view_as_active: false,
  groups: [],
  awx_configured: true,
  authentik_configured: true,
}

interface Inventory {
  workloads: MediaWorkload[]
  stale: boolean
}

function stubFetch(inv: Inventory, catalogLifecycle: string, writes: string[]) {
  const ago = () => new Date(Date.now() - 60_000).toISOString()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (init?.method && init.method !== 'GET' && WRITE.test(url)) writes.push(`${init.method} ${url}`)
      if (url.endsWith('/api/me')) return json(OPERATOR)
      if (url.endsWith('/api/catalog')) return json({ entries: [{ ...CATALOG, lifecycle: catalogLifecycle }] })
      if (url.endsWith('/api/media-workloads/grouped')) {
        return json({
          configured: true,
          degraded: false,
          scope: [],
          workloads: inv.workloads,
          invalid_instances: [],
          stale: inv.stale,
          last_success: inv.stale ? ago() : null,
          failure_since: inv.stale ? ago() : null,
        })
      }
      return json({ request_id: 'r1', status: 'accepted' })
    }),
  )
}

function mountRoute(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/media-workloads/studio-a/setup']}>
        <Routes>
          <Route path="/media-workloads/:slug/setup" element={<WorkloadSetup />} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return qc
}

async function refetch(qc: QueryClient) {
  await act(async () => {
    await qc.refetchQueries({ queryKey: ['media-workloads-grouped'] })
  })
}

async function openStep(label: string): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
  fireEvent.click(await waitFor(() => within(nav).getByRole('button', { name: label })))
  return screen.getByRole('heading', { name: label, level: 2 }).closest('[data-step-state]') as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function armAndGoStale(opts: {
  workloads: MediaWorkload[]
  catalog: string
  step: string
  openButton: string
  confirm: string
}) {
  const writes: string[] = []
  const inv: Inventory = { workloads: opts.workloads, stale: false }
  stubFetch(inv, opts.catalog, writes)
  const qc = mountRoute()
  const section = await openStep(opts.step)
  fireEvent.click(await within(section).findByRole('button', { name: opts.openButton }))
  fireEvent.change(screen.getByTestId('reason-input'), { target: { value: 'planned change' } })
  const confirm = screen.getByRole('button', { name: opts.confirm }) as HTMLButtonElement
  expect(confirm.disabled).toBe(false)

  inv.stale = true
  await refetch(qc)
  await screen.findByText(/This view may be out of date/)
  return { writes, confirm: screen.getByRole('button', { name: opts.confirm }) as HTMLButtonElement }
}

describe('armed confirmations while the inventory turns stale (route)', () => {
  it('deploy: Confirm is disabled and no deploy request is sent', async () => {
    const { writes, confirm } = await armAndGoStale({
      workloads: [workload({ lifecycle: 'provision', instances: [instance({ requested_state: 'bootstrapped', observed_state: 'unknown' })] })],
      catalog: 'planned',
      step: 'Provision',
      openButton: '▶ Deploy',
      confirm: 'Confirm deploy',
    })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    await act(async () => {})
    expect(writes).toEqual([])
    expect((screen.getByTestId('reason-input') as HTMLTextAreaElement).value).toBe('planned change')
  })

  it('teardown: Confirm is disabled and no teardown request is sent', async () => {
    const { writes, confirm } = await armAndGoStale({
      workloads: [workload()],
      catalog: 'active',
      step: 'Finalise & Review',
      openButton: '⏏ Teardown',
      confirm: 'Confirm teardown',
    })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    await act(async () => {})
    expect(writes).toEqual([])
  })
})

describe('armed confirmations while the inventory turns stale (components)', () => {
  function frame(blocked: boolean, child: React.ReactElement, qc: QueryClient) {
    return (
      <QueryClientProvider client={qc}>
        <InventoryWritesBlockedProvider value={blocked}>{child}</InventoryWritesBlockedProvider>
      </QueryClientProvider>
    )
  }

  it('switch source: no switch request after the provider turns blocked', async () => {
    const writes: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (init?.method === 'POST') writes.push(url)
        if (url.endsWith('/topology')) {
          return json({
            receiver_instance: 'viewer-1',
            sources: [
              { id: 'source-a', flow_id: 'f1', pattern: 'smpte' },
              { id: 'source-b', flow_id: 'f2', pattern: 'ball' },
            ],
            active_source: 'source-a',
            provenance: 'observed-flow',
            observed_at: new Date().toISOString(),
          })
        }
        return json({})
      }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const el = (blocked: boolean) =>
      frame(
        blocked,
        <ConfigureStage
          workload={workload()}
          state="available"
          actions={['switch-source']}
          onBusyChange={() => {}}
          onSwitchResult={() => {}}
          onJobStart={() => {}}
        />,
        qc,
      )
    const { rerender } = render(el(false))
    fireEvent.click(await screen.findByRole('button', { name: 'Switch source' }))
    fireEvent.change(screen.getByTestId('reason-input'), { target: { value: 'go' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'source-b' } })
    expect((screen.getByTestId('confirm-switch-source') as HTMLButtonElement).disabled).toBe(false)

    rerender(el(true))
    const confirm = screen.getByTestId('confirm-switch-source') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    await act(async () => {})
    expect(writes).toEqual([])
  })

  it('delete permanently: no purge request after the provider turns blocked', async () => {
    const writes: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') writes.push((input as string).toString())
        return json({})
      }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const el = (blocked: boolean) =>
      frame(
        blocked,
        <FinaliseStage
          workload={workload({ lifecycle: 'provision', instances: [] })}
          state="available"
          actions={['delete-permanently']}
          onBusyChange={() => {}}
          lastSwitchResult={null}
          onJobStart={() => {}}
          user={OPERATOR}
          runningReadout={{ running: 0, total: 0, trustworthy: true }}
        />,
        qc,
      )
    const { rerender } = render(el(false))
    fireEvent.click(await screen.findByRole('button', { name: /Delete permanently/ }))
    fireEvent.change(screen.getByTestId('reason-input'), { target: { value: 'cleanup' } })
    fireEvent.change(screen.getByPlaceholderText('studio-a'), { target: { value: 'studio-a' } })
    expect((screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled).toBe(false)

    rerender(el(true))
    const confirm = screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    await act(async () => {})
    expect(writes).toEqual([])
  })

  it('clear for deployment: Confirm sends nothing while blocked', () => {
    const onConfirm = vi.fn()
    const qc = new QueryClient()
    const el = (blocked: boolean) =>
      frame(blocked, <ClearForDeployment instance="viewer-1" onConfirm={onConfirm} />, qc)
    const { rerender } = render(el(false))
    fireEvent.click(screen.getByRole('button', { name: /Clear for deployment/ }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ready' } })
    rerender(el(true))
    const confirm = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()

    rerender(el(false))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onConfirm).toHaveBeenCalledWith('viewer-1', 'ready')
  })
})

describe('useGuardWrite (execution-time backstop)', () => {
  it('refuses once the same mounted provider turns stale, and allows again when fresh', () => {
    let guard: () => void = () => {}
    function Probe() {
      guard = useGuardWrite()
      return null
    }
    const tree = (blocked: boolean) => (
      <InventoryWritesBlockedProvider value={blocked}>
        <Probe />
      </InventoryWritesBlockedProvider>
    )
    const { rerender } = render(tree(false))
    const captured = guard
    expect(() => captured()).not.toThrow()

    rerender(tree(true))
    expect(() => captured()).toThrow(InventoryWritesBlockedError)
    expect(() => guard()).toThrow(InventoryWritesBlockedError)

    rerender(tree(false))
    expect(() => captured()).not.toThrow()
  })
})
