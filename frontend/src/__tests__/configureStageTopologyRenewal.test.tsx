/**
 * Closes umbrella dmfdeploy/dmfdeploy#402.
 *
 * useInstanceTopology (api/hooks.ts) fetched once on mount with no
 * refetchInterval and retry:false. ConfigureStage's switch control gates on
 * observed_at being within OBSERVED_SOURCE_STALE_MS (15s) of Date.now() —
 * with observed_at frozen at mount and Date.now() advancing, freshness could
 * only decay. The control withdrew ~15s after page load and never came back
 * without a reload, even though the backend genuinely re-stamps observed_at
 * on every request from a live probe.
 *
 * The fix: refetchInterval: 5000 (renews the stamp before the fuse trips)
 * plus retry: 1 / retryDelay: 300 (so one transient poll failure — now
 * reachable, since polling exists at all — doesn't itself flip isError and
 * withdraw the control via ConfigureStage.tsx's `topology.failed` check).
 *
 * These three tests exercise the switch control's actual rendered behaviour,
 * not the hook's option shape — mutation-tested against the fix itself (see
 * the WO-402 report for the paired break/confirm-fail/restore runs).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ConfigureStage from '../pages/MediaWorkloads/stages/ConfigureStage'
import type { MediaWorkload } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function workload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'operate',
    health: 'ok',
    functions: [{ function_key: 'mxl-viewer', count: 1, running: 1, reconcile_pending: 0 }],
    instances: [
      {
        instance: 'mxl-a',
        netbox_id: 1,
        function_key: 'mxl-viewer',
        live_view: false,
        requested_state: 'active',
        observed_state: 'running',
        reconcile_pending: false,
        placement: { node: null, ports: [], protocol: null },
        workload_assignment: 'ok',
      },
    ],
  }
}

function configureElement(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigureStage
        workload={workload()}
        state="available"
        actions={['switch-source']}
        onBusyChange={() => {}}
        onSwitchResult={() => {}}
        onJobStart={() => {}}
      />
    </QueryClientProvider>
  )
}

function renderConfigure(queryClient: QueryClient) {
  return render(configureElement(queryClient))
}

function freshTopology() {
  return {
    receiver_instance: 'mxl-a',
    sources: [
      { id: 'source-a', flow_id: 'f1', pattern: 'smpte' },
      { id: 'source-b', flow_id: 'f2', pattern: 'ball' },
    ],
    active_source: 'source-a',
    provenance: 'observed-flow',
    // Computed at CALL time against the current (possibly fake) clock, the
    // same way the real backend re-stamps it per request — a static
    // timestamp here would just reintroduce the bug into the test fixture.
    observed_at: new Date().toISOString(),
  }
}

function stubFetch(handler: (calls: number) => Response | Promise<Response>) {
  let calls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/topology')) {
        calls += 1
        return handler(calls)
      }
      return json({})
    }),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ConfigureStage switch control — topology polling (umbrella #402)', () => {
  it('T1: the control survives past 20s when every poll renews a fresh observed_at (the fuse is gone)', async () => {
    vi.useFakeTimers()
    stubFetch(() => json(freshTopology()))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = renderConfigure(queryClient)

    // Flush the mount fetch. Fake timers active: getBy*, never findBy*
    // (findBy*/waitFor poll on real timers and would hang) — same
    // convention as monitoring.test.tsx's fake-timer suite.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(screen.getByRole('button', { name: 'Switch source' })).toBeTruthy()

    // Past the 15s stale bound, and past four 5s poll cycles — each poll's
    // mocked observed_at is fresh AT CALL TIME, so if refetchInterval is
    // actually renewing the stamp, freshness never lapses.
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
    }

    // Force a re-render decoupled from whatever triggered the last one: the
    // property under test is "observed_at was actually renewed", which is
    // only visible once something re-evaluates isObservedFresh against the
    // NOW-advanced clock. In the real app an unrelated sibling poll would do
    // this; nothing else in this isolated tree would, so without this the
    // assertion below would trivially "pass" by never re-checking at all —
    // true with or without a working fix, which does not discriminate.
    rerender(configureElement(queryClient))
    expect(screen.getByRole('button', { name: 'Switch source' })).toBeTruthy()
  })

  it('T2: a single transient poll failure does not withdraw the control', async () => {
    vi.useFakeTimers()
    stubFetch((calls) => {
      if (calls === 2) return new Response('boom', { status: 500 })
      return json(freshTopology())
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderConfigure(queryClient)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(screen.getByRole('button', { name: 'Switch source' })).toBeTruthy()

    // Advance to the first background poll (call #2, the one that fails).
    // With the retry pending, react-query keeps the prior successful data
    // and isError stays false — the control must still be rendered right
    // here, before the retry has even fired.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByRole('button', { name: 'Switch source' })).toBeTruthy()

    // Advance past retryDelay so the retry (call #3) lands and succeeds.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(screen.getByRole('button', { name: 'Switch source' })).toBeTruthy()
  })

  it('T3: the gate still fails closed once the observation itself is no longer observed-flow', async () => {
    vi.useFakeTimers()
    stubFetch((calls) => {
      if (calls === 1) return json(freshTopology())
      // A later poll landing WITHOUT a fresh observed-flow match (sidecar
      // unreachable / no flow match) — provenance/active_source/observed_at
      // fall back to null together, same contract main.py's
      // _resolve_observed_active_source documents.
      return json({
        receiver_instance: 'mxl-a',
        sources: [
          { id: 'source-a', flow_id: 'f1', pattern: 'smpte' },
          { id: 'source-b', flow_id: 'f2', pattern: 'ball' },
        ],
        active_source: null,
        provenance: null,
        observed_at: null,
      })
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderConfigure(queryClient)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(screen.getByRole('button', { name: 'Switch source' })).toBeTruthy()

    // The next poll (5s later) reports the observation is no longer fresh —
    // polling being alive must not paper over that; the control withdraws.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()
    expect(screen.getByText(/Live source is unknown or stale/)).toBeTruthy()
  })
})
