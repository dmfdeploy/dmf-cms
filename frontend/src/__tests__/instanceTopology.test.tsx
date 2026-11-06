/**
 * The per-instance topology read seam (umbrella #339 item 5).
 *
 * A 404 from this endpoint is the ORDINARY answer, not a failure: it is what
 * the console gets for every instance that is not a catalog key (function
 * keys the catalog has since dropped — the Design stage's yellow drift state)
 * and for every instance that is one but carries no topology_ref, which is
 * every non-viewer. Treating that as an error meant the Design stage fetched
 * per-function topology and produced a stream of error-logged 404s for a
 * state it was already rendering correctly.
 *
 * The distinction that must hold in both directions: 404 resolves to null
 * data with no error, 422 (topology-invalid — a real catalog-authoring
 * defect) still errors. Asserted on the hook itself, because the two callers
 * render identically for "no data" and "error" and so cannot tell them apart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useInstanceTopology } from '../api/hooks'

function stubTopology(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
}

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useInstanceTopology', () => {
  it('resolves a 404 to no-topology, not to an error', async () => {
    stubTopology(404, { error: 'receiver-not-topology', detail: 'carries no topology_ref' })
    const { result } = renderHook(() => useInstanceTopology('source-a'), { wrapper })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.isError).toBe(false)
    expect(result.current.error).toBeNull()
    // null, not undefined: the query SUCCEEDED and the answer is "none".
    expect(result.current.data).toBeNull()
  })

  it('still errors on 422, the genuine catalog-authoring defect', async () => {
    stubTopology(422, { error: 'topology-invalid', detail: 'sources[] missing' })
    const { result } = renderHook(() => useInstanceTopology('viewer-1'), { wrapper })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.isError).toBe(true)
    expect(result.current.data).toBeUndefined()
  })

  it('passes a real topology through unchanged', async () => {
    stubTopology(200, {
      receiver_instance: 'viewer-1',
      sources: [{ id: 'source-a', pattern: 'smpte' }],
      active_source: 'source-a',
      provenance: 'observed-flow',
      observed_at: '2026-08-01T10:00:00Z',
    })
    const { result } = renderHook(() => useInstanceTopology('viewer-1'), { wrapper })
    await waitFor(() => expect(result.current.data).toBeTruthy())
    expect(result.current.data?.sources).toHaveLength(1)
  })

  describe('polling', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    async function settle(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    }

    const topology = {
      receiver_instance: 'viewer-1',
      sources: [{ id: 'source-a', pattern: 'smpte' }],
      active_source: 'source-a',
      provenance: 'observed-flow',
      observed_at: '2026-08-01T10:00:00Z',
    }

    // Serves the queued responses in order, then repeats the last one.
    function stubSequence(...responses: Array<[number, unknown]>) {
      let i = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          const [status, body] = responses[Math.min(i++, responses.length - 1)]
          return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          })
        }),
      )
    }
    // The shared wrapper builds a new client on every render, which would
    // restart the query; polling needs one client for the whole test.
    function stableWrapper() {
      const queryClient = new QueryClient()
      return ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      )
    }
    const fetchCount = () => vi.mocked(fetch).mock.calls.length

    it('backs off to 60s after a null instead of polling every 5s', async () => {
      vi.useFakeTimers()
      stubSequence([404, { error: 'receiver-not-topology' }])
      const { result } = renderHook(() => useInstanceTopology('source-a'), {
        wrapper: stableWrapper(),
      })
      await settle(0)
      expect(result.current.data).toBeNull()
      const calls = fetchCount()
      await settle(30_000)
      expect(fetchCount()).toBe(calls)
      await settle(31_000)
      expect(fetchCount()).toBe(calls + 1)
    })

    it('picks up a topology after a null and returns to 5s polling', async () => {
      vi.useFakeTimers()
      stubSequence([404, { error: 'receiver-not-topology' }], [200, topology])
      const { result } = renderHook(() => useInstanceTopology('viewer-1'), {
        wrapper: stableWrapper(),
      })
      await settle(0)
      expect(result.current.data).toBeNull()
      await settle(61_000)
      expect(result.current.data?.sources).toHaveLength(1)
      const calls = fetchCount()
      await settle(10_000)
      expect(fetchCount()).toBeGreaterThanOrEqual(calls + 2)
    })

    it('keeps polling when a fetch errors after a null', async () => {
      vi.useFakeTimers()
      stubSequence(
        [404, { error: 'receiver-not-topology' }],
        [500, { error: 'boom' }],
        [500, { error: 'boom' }],
        [200, topology],
      )
      const { result } = renderHook(
        () => {
          const q = useInstanceTopology('viewer-1')
          // Read isError so the observer re-renders when it flips.
          return { data: q.data, isError: q.isError }
        },
        { wrapper: stableWrapper() },
      )
      await settle(0)
      expect(result.current.data).toBeNull()
      // Failed poll plus its one retry: null is retained, status is error.
      await settle(61_000)
      expect(result.current.isError).toBe(true)
      expect(result.current.data).toBeNull()
      const calls = fetchCount()
      await settle(61_000)
      expect(fetchCount()).toBeGreaterThan(calls)
      expect(result.current.data?.sources).toHaveLength(1)
    })

    it('makes no topology request over several intervals when disabled by capability', async () => {
      vi.useFakeTimers()
      stubSequence([404, { error: 'receiver-not-topology' }])
      renderHook(() => useInstanceTopology('crosspoint-2', { enabled: false }), {
        wrapper: stableWrapper(),
      })
      await settle(0)
      await settle(5 * 60_000)
      expect(fetchCount()).toBe(0)
    })

    it('polls a capable instance whose topology is unknown with the same back-off', async () => {
      vi.useFakeTimers()
      stubSequence([404, { error: 'receiver-not-topology' }])
      renderHook(() => useInstanceTopology('viewer-1', { enabled: true }), {
        wrapper: stableWrapper(),
      })
      await settle(0)
      const calls = fetchCount()
      expect(calls).toBeGreaterThanOrEqual(1)
      await settle(30_000)
      expect(fetchCount()).toBe(calls)
      await settle(31_000)
      expect(fetchCount()).toBe(calls + 1)
    })

    it('reports no topology once disabled, whatever the cache holds', async () => {
      vi.useFakeTimers()
      stubSequence([200, topology])
      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) => useInstanceTopology('viewer-1', { enabled }),
        { wrapper: stableWrapper(), initialProps: { enabled: true } },
      )
      await settle(0)
      expect(result.current.data?.sources).toHaveLength(1)

      rerender({ enabled: false })
      await settle(0)
      expect(result.current.data).toBeNull()
      const calls = fetchCount()
      await settle(60_000)
      expect(fetchCount()).toBe(calls)
    })

    it('reports no topology for a disabled query another view already filled', async () => {
      vi.useFakeTimers()
      stubSequence([200, topology])
      const queryClient = new QueryClient()
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      )
      renderHook(() => useInstanceTopology('viewer-1'), { wrapper })
      await settle(0)
      const { result } = renderHook(() => useInstanceTopology('viewer-1', { enabled: false }), {
        wrapper,
      })
      await settle(0)
      expect(result.current.data).toBeNull()
    })

    it('shows the topology again when re-enabled', async () => {
      vi.useFakeTimers()
      stubSequence([200, topology])
      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) => useInstanceTopology('viewer-1', { enabled }),
        { wrapper: stableWrapper(), initialProps: { enabled: true } },
      )
      await settle(0)
      rerender({ enabled: false })
      await settle(0)
      expect(result.current.data).toBeNull()
      rerender({ enabled: true })
      await settle(0)
      expect(result.current.data?.sources).toHaveLength(1)
    })

    it('keeps polling a real topology every 5s', async () => {
      vi.useFakeTimers()
      stubSequence([200, topology])
      const { result } = renderHook(() => useInstanceTopology('viewer-1'), {
        wrapper: stableWrapper(),
      })
      await settle(0)
      expect(result.current.data).toBeTruthy()
      const calls = fetchCount()
      await settle(10_000)
      expect(fetchCount()).toBeGreaterThanOrEqual(calls + 2)
    })
  })
})
