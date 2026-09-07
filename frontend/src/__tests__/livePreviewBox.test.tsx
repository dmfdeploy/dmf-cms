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
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import WorkloadTile from '../pages/MediaWorkloads/WorkloadTile'
import { PREVIEW_TICK_MS, STATUS_POLL_MS } from '../pages/MediaWorkloads/liveView'
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

// umbrella #432 G7: `node —` (the em-dash placeholder) used to render on
// every tile whose instance had no NetBox device/VM assigned yet — read as
// a rendering fault rather than as information. `active={false}` disables
// the live-preview query entirely (canPoll requires it), so these render
// with no fetch mock at all — nothing here is about the preview.
describe('WorkloadTile node placement — no placeholder glyph for an absent one', () => {
  function renderTileWithNode(node: string | null) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <WorkloadTile
          instance={instance({ placement: { node, ports: [], protocol: null } })}
          displayName="Test"
          active={false}
          motionAllowed={false}
          onOpen={() => {}}
        />
      </QueryClientProvider>,
    )
  }

  it('omits the node field entirely when NetBox has no device/VM assigned — never "node —"', () => {
    renderTileWithNode(null)
    expect(screen.queryByText('node —')).toBeNull()
    expect(screen.queryByText(/node/)).toBeNull()
  })

  it('still names the real node when NetBox has one', () => {
    renderTileWithNode('node-7')
    expect(screen.getByText('node node-7')).toBeTruthy()
  })
})

// umbrella #452 — the static pattern illustration branch. A topology-spawned
// SOURCE carries a live sidecar (live_view: true) whose preview endpoint
// 404s for a source role: `available: true, preview: false` — today's
// "Sidecar live · no preview on this side" case, now the static card's home.
const NO_PREVIEW_STATUS = {
  available: true,
  role: 'source',
  provider: 'aliyun',
  preview: false,
  mxl_version: '1.2.3',
  flow: null,
}

function renderTileWithInstance(overrides: Partial<MediaWorkloadInstance>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkloadTile instance={instance(overrides)} displayName="Source A" active motionAllowed onOpen={() => {}} />
    </QueryClientProvider>,
  )
}

describe('WorkloadTile live preview — the static pattern card (umbrella #452)', () => {
  it('a known pattern with no preview shows the static illustration: no live dot, the exact caption, no <img>', async () => {
    // The static caption is true even on the FIRST render (pattern known,
    // hasPreview trivially false before any fetch resolves) — fake timers +
    // an explicit settle is what proves `available` has actually turned
    // true and liveDot is STILL suppressed, not merely not-yet-computed
    // (the exact race a `findByText`-only assertion here would miss).
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ instance: 'mxl-source-a', ...NO_PREVIEW_STATUS }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const { container } = renderTileWithInstance({
      instance: 'mxl-source-a',
      function_key: 'mxl-videotest-view-source-a',
      topology_parent_key: 'mxl-videotest-view',
      topology_source_id: 'source-a',
      topology_source_pattern: 'smpte',
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('Emits the smpte pattern · static illustration')).toBeTruthy()
    expect(container.querySelector('.bg-green-400')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('STATIC')).toBeTruthy()
    // No Refresh affordance either — this is not a held live frame.
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  })

  it('an unrecognised pattern falls back to the ordinary PlaceholderThumb caption, never the static card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ instance: 'mxl-source-a', ...NO_PREVIEW_STATUS }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    renderTileWithInstance({
      instance: 'mxl-source-a',
      function_key: 'mxl-videotest-view-source-a',
      topology_parent_key: 'mxl-videotest-view',
      topology_source_id: 'source-a',
      topology_source_pattern: 'ball', // a real sources[].pattern value this component does not draw
    })
    expect(await screen.findByText('Sidecar live · no preview on this side')).toBeTruthy()
    expect(screen.queryByText('STATIC')).toBeNull()
  })

  it('a genuinely live preview wins over the static card even when the pattern is known', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ instance: 'mxl-source-a', ...AVAILABLE_STATUS }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const { container } = renderTileWithInstance({
      instance: 'mxl-source-a',
      function_key: 'mxl-videotest-view-source-a',
      topology_parent_key: 'mxl-videotest-view',
      topology_source_id: 'source-a',
      topology_source_pattern: 'smpte',
    })
    expect(await screen.findByText('Live · sidecar preview')).toBeTruthy()
    expect(container.querySelector('img')).toBeTruthy()
    expect(screen.queryByText('STATIC')).toBeNull()
    expect(container.querySelector('.bg-green-400')).toBeTruthy()
  })

  // fix-round r1 (codex P1): a sidecar that ADVERTISES a preview
  // (preview: true) but whose actual frame fails to load must never show
  // the static card — that combination is a live-signal failure, not a
  // reason to fall back to "what the source is configured to emit". Before
  // this round, showStaticCard read `!showImage` (which goes true on ANY
  // imgError, preview:true included) while the tick effect stayed gated on
  // `hasPreview` alone (still true here) — so the card appeared, then the
  // next tick's imgError reset flipped showImage back true, re-mounting
  // the <img>, which failed again, flipping back to the card: an endless
  // cycle. `showStaticCard` now reads `!hasPreview` — the SAME condition
  // the tick effect gates on — so this state is structurally impossible.
  it('a preview-advertising sidecar whose frame fails to load falls back to the ordinary placeholder, never the static card, even across a tick', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ instance: 'mxl-source-a', ...AVAILABLE_STATUS }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const { container } = renderTileWithInstance({
      instance: 'mxl-source-a',
      function_key: 'mxl-videotest-view-source-a',
      topology_parent_key: 'mxl-videotest-view',
      topology_source_id: 'source-a',
      topology_source_pattern: 'smpte',
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    const img = screen.getByAltText(/Live preview of/)
    fireEvent.error(img)

    expect(screen.getByText('no preview')).toBeTruthy()
    expect(screen.queryByText('STATIC')).toBeNull()
    expect(container.querySelector('img')).toBeNull()

    // Advance past the tick that resets imgError — the ordinary <img> retry
    // (pre-existing, unrelated to #452: "a fresh src is a fresh chance for
    // a recovered preview") may legitimately re-attempt the image, but the
    // static card must never appear at any point in that cycle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_TICK_MS + 10)
    })
    expect(screen.queryByText('STATIC')).toBeNull()
  })

  // fix-round r1 (codex P2): the known-pattern-with-no-preview test above
  // only proved the card RENDERS — it never proved the cache-bust interval
  // (whose only purpose is refreshing an <img> src, at PREVIEW_TICK_MS)
  // stays OFF while the card is showing. `vi.getTimerCount()` alone can't
  // tell it apart from react-query's OWN status-poll interval (STATUS_POLL_MS,
  // a DIFFERENT period, and one this branch deliberately leaves running —
  // "status polling may continue, cheap"), so this spies on `setInterval`
  // directly and asserts no call was ever scheduled at the preview-tick
  // period specifically.
  it('no cache-bust interval runs while the static card is showing (status polling still may)', async () => {
    vi.useFakeTimers()
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ instance: 'mxl-source-a', ...NO_PREVIEW_STATUS }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    renderTileWithInstance({
      instance: 'mxl-source-a',
      function_key: 'mxl-videotest-view-source-a',
      topology_parent_key: 'mxl-videotest-view',
      topology_source_id: 'source-a',
      topology_source_pattern: 'smpte',
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('STATIC')).toBeTruthy()
    const previewTickIntervals = intervalSpy.mock.calls.filter(([, delay]) => delay === PREVIEW_TICK_MS)
    expect(previewTickIntervals).toHaveLength(0)
    intervalSpy.mockRestore()
  })
})
