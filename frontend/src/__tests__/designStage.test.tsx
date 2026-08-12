/**
 * DesignStage (fix-round 5, PR #81, codex sibling sweep) — two defects:
 *
 *  1. InstanceComposition (the topology-derived "composed of…" line) was
 *     the unfixed twin of Operate.tsx's InstanceActiveSource: no isError
 *     check, so a settled failed refetch kept naming a retained (possibly
 *     stale) active source as current.
 *  2. A failed useCatalog read left `catalogEntries` empty exactly like a
 *     genuinely-empty catalog — every function's join then missed, and
 *     EVERY item rendered "this function key isn't in the current catalog…
 *     may have been removed" for a reason that had nothing to do with
 *     removal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import DesignStage from '../pages/MediaWorkloads/stages/DesignStage'
import type { CatalogEntry, MediaWorkload } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function workload(overrides: Partial<MediaWorkload> = {}): MediaWorkload {
  return {
    slug: 'test',
    name: 'test',
    lifecycle: 'operate',
    health: 'ok',
    functions: [{ function_key: 'mxl-videotestsrc', count: 1, running: 1, reconcile_pending: 0 }],
    instances: [
      {
        instance: 'mxl-a',
        netbox_id: 1,
        function_key: 'mxl-videotestsrc',
        live_view: false,
        requested_state: 'active',
        observed_state: 'running',
        reconcile_pending: false,
        placement: { node: null, ports: [], protocol: null },
        workload_assignment: 'ok',
      },
    ],
    ...overrides,
  }
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'mxl-videotestsrc',
    display_name: 'MXL Test Source',
    summary: '',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'active',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: null,
    finalise_awx_job_template: null,
    dependencies: [],
    ingress_url: null,
    ...overrides,
  }
}

function renderStage(queryClient: QueryClient, props: Partial<Parameters<typeof DesignStage>[0]> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DesignStage
        workload={workload()}
        catalogEntries={[catalogEntry()]}
        catalogLoading={false}
        catalogFailed={false}
        state="informational"
        {...props}
      />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('DesignStage — catalog-read-failure honesty', () => {
  it('a healthy catalog read never shows the removed-function warning for a known key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderStage(queryClient)
    expect(await screen.findByText('MXL Test Source')).toBeTruthy()
    expect(screen.queryByText(/may have been removed/)).toBeNull()
  })

  it('a genuinely unknown function key (catalog read fine) still warns it may have been removed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderStage(queryClient, { catalogEntries: [] })
    expect(await screen.findByText('mxl-videotestsrc')).toBeTruthy()
    expect(screen.getByText(/may have been removed/)).toBeTruthy()
  })

  it('a failed catalog read names the real cause ONCE, never accuses the function of removal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderStage(queryClient, { catalogEntries: [], catalogFailed: true })
    expect(
      await screen.findByText(/The catalog couldn.t be read right now, so template details below could not be checked\./),
    ).toBeTruthy()
    expect(screen.queryByText(/may have been removed/)).toBeNull()
    // Falls back to the function key for display, same as the genuine miss.
    expect(screen.getByText('mxl-videotestsrc')).toBeTruthy()
  })
})

describe('DesignStage — InstanceComposition topology retained-error honesty', () => {
  it('renders the composed-of line for a real, current topology read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/topology')) {
          return json({
            receiver_instance: 'mxl-a',
            sources: [{ id: 'source-a', flow_id: 'f1', pattern: 'smpte' }],
            active_source: 'source-a',
            provenance: 'observed-flow',
            observed_at: new Date().toISOString(),
          })
        }
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderStage(queryClient)
    expect(await screen.findByText(/composed of/)).toBeTruthy()
    expect(screen.getByText(/source-a \(smpte\), active/)).toBeTruthy()
  })

  it('a settled failed refetch withdraws the row instead of naming a stale active source', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/topology')) {
          calls += 1
          if (calls === 1) {
            return json({
              receiver_instance: 'mxl-a',
              sources: [
                { id: 'source-a', flow_id: 'f1', pattern: 'smpte' },
                { id: 'source-b', flow_id: 'f2', pattern: 'ball' },
              ],
              active_source: 'source-a',
              provenance: 'observed-flow',
              observed_at: new Date().toISOString(),
            })
          }
          return new Response('boom', { status: 500 })
        }
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderStage(queryClient)

    // First (successful) read settles — the row names source-a as active.
    expect(await screen.findByText(/source-a \(smpte\), active/)).toBeTruthy()

    // Trigger the refetch a real caller (ConfigureStage, after a source
    // switch) would fire against the SAME query key — react-query dedupes
    // by key, so this updates the exact cache entry InstanceComposition
    // reads. This one rejects.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['media-workloads-topology', 'mxl-a'] })
    })

    // The row withdraws entirely — same contract as Operate.tsx's already-
    // fixed InstanceActiveSource: an errored read is unknown, not a stale
    // "still current" claim, so it says nothing rather than something wrong.
    // waitFor: the observer's re-render notification can land a tick after
    // the refetch promise itself settles.
    await waitFor(() => {
      expect(screen.queryByText(/composed of/)).toBeNull()
      expect(screen.queryByText(/source-a \(smpte\), active/)).toBeNull()
    })
  })
})
