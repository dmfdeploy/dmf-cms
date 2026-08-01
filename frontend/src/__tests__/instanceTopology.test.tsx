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
import { cleanup, renderHook, waitFor } from '@testing-library/react'
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
})
