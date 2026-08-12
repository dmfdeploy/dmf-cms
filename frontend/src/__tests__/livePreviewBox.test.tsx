/**
 * useLivePreview (LivePreviewBox.tsx) — retained-error honesty (fix-round 6,
 * PR #81, umbrella #385 codex sweep). `status.isError` was never checked —
 * a settled failed refetch after a successful available+preview read kept
 * the "Live · sidecar preview" caption and the live dot with no notice
 * that the current poll had failed.
 *
 * Mounted via WorkloadTile (not LivePreviewBox directly) because caption/
 * liveDot are WorkloadTile's own visible rendering of useLivePreview's
 * return value — LivePreviewBox/LivePreviewFrame render only the frame
 * itself, the same shared hook both consume.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import WorkloadTile from '../pages/MediaWorkloads/WorkloadTile'
import { STATUS_POLL_MS } from '../pages/MediaWorkloads/liveView'
import type { MediaWorkloadInstance } from '../api/types'

function instance(overrides: Partial<MediaWorkloadInstance> = {}): MediaWorkloadInstance {
  return {
    instance: 'mxl-a',
    netbox_id: 1,
    function_key: 'mxl-videotest-view',
    live_view: true,
    requested_state: 'active',
    observed_state: 'running',
    reconcile_pending: false,
    placement: { node: 'node-1', ports: [9000], protocol: 'tcp' },
    ...overrides,
  }
}

const AVAILABLE_STATUS = {
  available: true,
  role: 'receiver',
  provider: 'aliyun',
  preview: true,
  mxl_version: '1.2.3',
  flow: { head_index: 1, latency_ms: 1, latency_grains: 1, active: true, format: 'Video', grain_rate: '50/1' },
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderTile(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkloadTile instance={instance()} displayName="Test" active motionAllowed onOpen={() => {}} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WorkloadTile live preview — a settled failed poll never claims live', () => {
  it('a healthy poll shows the live caption and the live dot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ instance: 'mxl-a', ...AVAILABLE_STATUS })))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = renderTile(queryClient)
    expect(await screen.findByText('Live · sidecar preview')).toBeTruthy()
    expect(container.querySelector('.bg-green-400')).toBeTruthy()
  })

  it('a settled failed refetch keeps the held frame visible but drops the live claim', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.includes('/mxl/status')) {
          calls += 1
          if (calls === 1) return json({ instance: 'mxl-a', ...AVAILABLE_STATUS })
          return new Response('boom', { status: 500 })
        }
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = renderTile(queryClient)

    // First (successful) read settles — genuinely live. Fake timers active,
    // so settle() + getBy*, never findBy* (findBy* waits on real timers).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('Live · sidecar preview')).toBeTruthy()
    expect(container.querySelector('.bg-green-400')).toBeTruthy()
    expect(screen.getByAltText(/Live preview of/)).toBeTruthy()

    // Advance past the tile's STATUS_POLL_MS so the background refetch
    // fires and rejects, while the old (available, previewable) status
    // stays retained.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS + 100)
    })

    // The held frame is STILL shown (Art. 5) — but the caption must no
    // longer claim it is live, and the live dot must be off.
    expect(screen.getByAltText(/Live preview of/)).toBeTruthy()
    expect(screen.getByText('Could not be refreshed — showing the last reading')).toBeTruthy()
    expect(screen.queryByText('Live · sidecar preview')).toBeNull()
    expect(container.querySelector('.bg-green-400')).toBeNull()
  })

  it('a failed poll with no data at all reads as unavailable, never as live', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderTile(queryClient)
    expect(await screen.findByText('Live view unavailable (read failed)')).toBeTruthy()
    expect(screen.queryByText('Live · sidecar preview')).toBeNull()
  })
})
