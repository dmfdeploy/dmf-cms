/**
 * dmfdeploy/dmfdeploy#861: a source switch in progress must not say the
 * selected source is gone.
 *
 * The topology query polls while the panel is armed. A poll that lands while
 * the switch request is in flight can show the target as active_source, fail,
 * return malformed data or leave no other source. While the request is
 * pending the panel keeps the pending indicator and shows the submitted
 * target in a disabled select, with no pre-submit "unknown or stale" line.
 * Before submit, and after an error settles while the control is still
 * rendered, the stale-target check applies to the current target.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ConfigureStage from '../pages/MediaWorkloads/stages/ConfigureStage'
import { InventoryWritesBlockedProvider } from '../lib/inventoryFreshness'
import type { MediaWorkload } from '../api/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
}

const WORKLOAD = {
  slug: 'studio-a',
  name: 'studio-a',
  lifecycle: 'operate',
  health: 'ok',
  instances: [
    {
      instance: 'viewer-1',
      netbox_id: 1,
      function_key: 'crosspoint',
      live_view: false,
      requested_state: 'active',
      observed_state: 'running',
      reconcile_pending: false,
      placement: { node: 'node-1', ports: [], protocol: null },
      workload_assignment: 'ok',
    },
  ],
  functions: [{ function_key: 'crosspoint', count: 1, running: 1, reconcile_pending: 0 }],
} as unknown as MediaWorkload

const SOURCES = [
  { id: 'source-a', flow_id: 'f1', pattern: 'smpte' },
  { id: 'source-b', flow_id: 'f2', pattern: 'ball' },
]

const KEY = ['media-workloads-topology', 'viewer-1']
type TopologyMode = 'ok' | 'error' | 'malformed' | 'null-entry' | 'idless-entry'

function setup() {
  let active = 'source-a'
  let sources = SOURCES
  let mode: TopologyMode = 'ok'
  let settlePost: (outcome: 'ok' | 'fail') => void = () => {}
  const gate = new Promise<'ok' | 'fail'>((resolve) => {
    settlePost = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (init?.method === 'POST') {
        if ((await gate) === 'fail') return json({ error: 'upstream failed' }, 500)
        return json({
          request_id: 'r1',
          status: 'active',
          outcome: 'active',
          source_instance: 'source-b',
          reason: 'go',
          actor: 'ops',
          role: 'engineer',
        })
      }
      if (url.endsWith('/topology')) {
        if (mode === 'error') return json({ error: 'boom' }, 500)
        return json({
          receiver_instance: 'viewer-1',
          sources:
            mode === 'malformed'
              ? 'not-a-list'
              : mode === 'null-entry'
                ? [null]
                : mode === 'idless-entry'
                  ? [{}]
                  : sources,
          active_source: active,
          provenance: 'observed-flow',
          observed_at: new Date().toISOString(),
        })
      }
      return json({})
    }),
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = () => (
    <QueryClientProvider client={qc}>
      <InventoryWritesBlockedProvider value={false}>
        <ConfigureStage
          workload={WORKLOAD}
          state="available"
          actions={['switch-source']}
          onBusyChange={() => {}}
          onSwitchResult={() => {}}
          onJobStart={() => {}}
        />
      </InventoryWritesBlockedProvider>
    </QueryClientProvider>
  )
  const view = render(tree())
  // Delivers a poll result, then waits until the query holds it, so the
  // assertions that follow cannot pass just because the poll never landed.
  const poll = async (next: { active?: string; sources?: typeof SOURCES; mode?: TopologyMode }) => {
    if (next.active) active = next.active
    if (next.sources) sources = next.sources
    mode = next.mode ?? 'ok'
    await act(async () => {
      await qc.refetchQueries({ queryKey: KEY })
    })
    await waitFor(() => {
      const state = qc.getQueryState(KEY)
      if (mode === 'error') expect(state?.status).toBe('error')
      else if (mode === 'malformed') expect(qc.getQueryData<{ sources: unknown }>(KEY)?.sources).toBe('not-a-list')
      else if (mode === 'null-entry') expect(qc.getQueryData<{ sources: unknown }>(KEY)?.sources).toEqual([null])
      else if (mode === 'idless-entry') expect(qc.getQueryData<{ sources: unknown }>(KEY)?.sources).toEqual([{}])
      else expect(qc.getQueryData<{ active_source: string }>(KEY)?.active_source).toBe(active)
    })
    // The query notifies React on a later task; let that render happen.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
  return { poll, settlePost, qc, view, tree }
}

async function armAndPick(target: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Switch source' }))
  fireEvent.change(screen.getByTestId('reason-switch-source'), { target: { value: 'go' } })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: target } })
}

async function submitAndWaitPending() {
  fireEvent.click(screen.getByTestId('confirm-switch-source'))
  await waitFor(() =>
    expect(screen.getByTestId('confirm-switch-source').textContent).toContain('Switching…'),
  )
}

function expectPendingPanel() {
  expect(screen.queryByText(HINT)).toBeNull()
  expect(screen.queryByText(/Live source is unknown or stale/)).toBeNull()
  const select = screen.getByRole('combobox') as HTMLSelectElement
  expect(select.value).toBe('source-b')
  expect(select.disabled).toBe(true)
  expect(screen.getByTestId('confirm-switch-source').textContent).toContain('Switching…')
  expect(screen.getByTestId('reason-confirm-spinner')).toBeTruthy()
}

const HINT = /no longer available/

describe('switch source while the request is pending (#861)', () => {
  it('a poll that shows the target as active keeps the submitted target and raises no hint', async () => {
    const { poll, settlePost } = setup()
    await armAndPick('source-b')
    await submitAndWaitPending()
    await poll({ active: 'source-b' })
    expectPendingPanel()
    settlePost('ok')
  })

  it('a poll that fails keeps the panel, the pending state and the submitted target', async () => {
    const { poll, settlePost } = setup()
    await armAndPick('source-b')
    await submitAndWaitPending()
    await poll({ mode: 'error' })
    expectPendingPanel()
    settlePost('ok')
  })

  it('a poll with malformed data keeps the panel, the pending state and the submitted target', async () => {
    const { poll, settlePost } = setup()
    await armAndPick('source-b')
    await submitAndWaitPending()
    await poll({ mode: 'malformed' })
    expectPendingPanel()
    settlePost('ok')
  })

  it('a poll that leaves no other source keeps the panel, the pending state and the submitted target', async () => {
    const { poll, settlePost } = setup()
    await armAndPick('source-b')
    await submitAndWaitPending()
    await poll({ active: 'source-b', sources: [SOURCES[1]] })
    expectPendingPanel()
    settlePost('ok')
  })

  it('an error settle after a poll made the target active shows the hint and disables Confirm', async () => {
    const { poll, settlePost } = setup()
    await armAndPick('source-b')
    await submitAndWaitPending()
    await poll({ active: 'source-b' })
    settlePost('fail')
    expect(await screen.findByText(HINT)).toBeTruthy()
    expect((screen.getByTestId('confirm-switch-source') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false)
  })

  it('a success settle closes the panel and shows the result', async () => {
    const { poll, settlePost } = setup()
    await armAndPick('source-b')
    await submitAndWaitPending()
    await poll({ active: 'source-b' })
    settlePost('ok')
    expect(await screen.findByText('Active source: source-b')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('unmounting while pending and remounting shows no stale snapshot or stuck pending state', async () => {
    const { settlePost, view, tree } = setup()
    await armAndPick('source-b')
    await submitAndWaitPending()
    view.unmount()
    render(tree())
    const arm = await screen.findByRole('button', { name: 'Switch source' })
    expect(screen.queryByText('Switching…')).toBeNull()
    fireEvent.click(arm)
    fireEvent.change(screen.getByTestId('reason-switch-source'), { target: { value: 'again' } })
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.disabled).toBe(false)
    expect(within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'source-b'])
    fireEvent.change(select, { target: { value: 'source-b' } })
    expect((screen.getByTestId('confirm-switch-source') as HTMLButtonElement).disabled).toBe(false)
    settlePost('ok')
    await act(async () => {})
  })
})

describe.each(['null-entry', 'idless-entry'] as const)('a sources array with a %s (#863)', (mode) => {
  it('fails closed like a non-array when nothing is pending, without throwing', async () => {
    const { poll } = setup()
    await screen.findByRole('button', { name: 'Switch source' })
    await poll({ mode })
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()
    expect(screen.queryByText(/Live source is unknown or stale/)).toBeNull()
  })

  it('keeps the snapshot panel while a switch is pending', async () => {
    const { poll, settlePost } = setup()
    await armAndPick('source-b')
    await submitAndWaitPending()
    await poll({ mode })
    expectPendingPanel()
    settlePost('ok')
  })
})

describe('switch source before submit (#861)', () => {
  it('a poll that drops the selected target shows the hint and disables Confirm', async () => {
    const { poll } = setup()
    await armAndPick('source-b')
    expect((screen.getByTestId('confirm-switch-source') as HTMLButtonElement).disabled).toBe(false)
    await poll({ active: 'source-b' })
    expect(await screen.findByText(HINT)).toBeTruthy()
    expect((screen.getByTestId('confirm-switch-source') as HTMLButtonElement).disabled).toBe(true)
  })
})
