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
 * These five tests exercise the switch control's actual rendered behaviour,
 * not the hook's option shape — mutation-tested against the fix itself (see
 * the WO-402 report for the paired break/confirm-fail/restore runs).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  // Tracked on every stub, not just the tests that arm+submit: proving a
  // dispatch never happened is only meaningful if the same stub could have
  // recorded one, and this way T1-T3 get the check for free too.
  const switchCalls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/topology')) {
        calls += 1
        return handler(calls)
      }
      if (url.endsWith('/switch-source')) {
        switchCalls.push({ url, init })
        return json({
          command_id: 'cmd-1',
          receiver_instance: 'mxl-a',
          source_instance: 'source-b',
          reason: 'go',
          status: 'active',
          previous_source: 'source-a',
          error: null,
          request_id: 'req-switch-1',
          initiator: 'ops',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          actor: 'ops',
          role: 'engineer',
        })
      }
      return json({})
    }),
  )
  return { switchCalls }
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

    // Force a re-render before the final assertion. With a working fix this
    // is redundant — each poll returns a changed observed_at, so the query
    // data changes and react-query's own notification already re-renders
    // the subscribed component; no help needed. Its real job is making the
    // NO-refetchInterval mutation observable: with nothing left to change
    // the query's data after mount, nothing prompts ANY re-render in this
    // isolated tree (InstanceSwitchControl only self-ticks once a second
    // while `arming`, which this test never does), so a stale button would
    // just sit unre-evaluated in the DOM and the assertion below would pass
    // vacuously whether or not the fix is present.
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

  it('T4: a target that goes stale mid-arm disables Confirm and blocks the dispatch', async () => {
    vi.useFakeTimers()
    const { switchCalls } = stubFetch((calls) => {
      if (calls === 1) return json(freshTopology())
      // The poll that lands while armed: source-b — the operator's already-
      // selected target — has become the active source. It's still a fresh
      // observed-flow read; only the operator's own choice has gone stale
      // underneath them.
      return json({
        receiver_instance: 'mxl-a',
        sources: [
          { id: 'source-a', flow_id: 'f1', pattern: 'smpte' },
          { id: 'source-b', flow_id: 'f2', pattern: 'ball' },
        ],
        active_source: 'source-b',
        provenance: 'observed-flow',
        observed_at: new Date().toISOString(),
      })
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderConfigure(queryClient)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })

    // Arm, pick source-b as the target, fill in a reason — the same operator
    // sequence mediaWorkloadsGrid.test.tsx's armed-staleness test uses.
    fireEvent.click(screen.getByRole('button', { name: 'Switch source' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'operator requested' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'source-b' } })
    expect((screen.getByRole('button', { name: 'Confirm switch' }) as HTMLButtonElement).disabled).toBe(
      false,
    )

    // The next poll (5s later) lands while still armed: source-b is now the
    // active source, dropping out of the valid-target list underneath the
    // operator's still-selected choice.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect((screen.getByRole('button', { name: 'Confirm switch' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    // Confirm is a genuinely disabled native button — clicking it must not
    // reach the switch-source endpoint. The dispatch, not the button's
    // appearance, is the actual safety property under test.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }))
    expect(switchCalls).toHaveLength(0)
  })

  it('T5: sustained poll failures still withdraw the control — the retry is bounded', async () => {
    vi.useFakeTimers()
    stubFetch((calls) => {
      if (calls === 1) return json(freshTopology())
      return new Response('boom', { status: 500 })
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderConfigure(queryClient)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(screen.getByRole('button', { name: 'Switch source' })).toBeTruthy()

    // First background poll fails, its one retry also fails — retry: 1 is
    // exhausted here, so isError should flip true and the control withdraws.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000) // the poll itself
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300) // its one retry
    })
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()

    // And stays withdrawn across at least one further poll cycle — bounded
    // retry must mean the control does not quietly resurrect on its own
    // while the outage continues, only that ONE transient failure (T2) is
    // forgiven.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.queryByRole('button', { name: 'Switch source' })).toBeNull()
  })
})
