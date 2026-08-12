/**
 * MxlDetailPanel — the legacy aggregate fallback (live_view: false path,
 * see mediaWorkloadsGrid.test.tsx's "never hits the retired legacy
 * aggregate on the live path" for the one legitimate caller).
 *
 * fix-round 5 (PR #81, codex sibling sweep): `isError` was never checked.
 * A settled failed read with nothing retained fell into `!data?.configured`
 * and told the operator "Live view endpoints are not configured" — false;
 * the endpoints may be perfectly well configured, the read just failed. A
 * settled failed read WITH retained data rendered every number/node/image
 * as current with no notice at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import MxlDetailPanel from '../pages/MediaWorkloads/MxlDetailPanel'
import type { MxlStatusResponse } from '../api/types'

function status(overrides: Partial<MxlStatusResponse> = {}): MxlStatusResponse {
  return {
    configured: true,
    reachable: true,
    nodes: [
      { role: 'receiver', provider: 'aliyun', online: true, node: 'n1', mxl_version: '1.2.3', flow: {} },
    ],
    flow: { head_index: 42, latency_ms: 3.5, latency_grains: 2 },
    transport: {},
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MxlDetailPanel />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('MxlDetailPanel — honesty on a failed read', () => {
  it('a failed read with no data at all says it could not be read, never "not configured"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    renderPanel()
    expect(await screen.findByText('Live status could not be read right now. Retrying automatically.')).toBeTruthy()
    expect(screen.queryByText(/not configured for this environment/)).toBeNull()
  })

  it('a genuinely successful, configured read renders real content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(status())))
    renderPanel()
    expect(await screen.findByText('42')).toBeTruthy()
  })

  // Hold-then-reject, not first-load: the first fetch succeeds (real
  // retained data) before the second one rejects.
  it('a settled failed refetch keeps the retained reading visible but adds a notice', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/mxl/status')) {
          calls += 1
          if (calls === 1) return json(status())
          return new Response('boom', { status: 500 })
        }
        return json({})
      }),
    )
    renderPanel()

    // First (successful) read settles. Fake timers active, so settle() +
    // getBy*, never findBy* (findBy* waits on real timers and would hang).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('42')).toBeTruthy()
    expect(screen.queryByText(/could not be refreshed/)).toBeNull()

    // Advance past the panel's 200ms live poll so the background refetch
    // fires and rejects, while the old (successful) status stays retained.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    // Retained reading STILL shown (Art. 5) — now qualified by a notice.
    expect(screen.getByText('42')).toBeTruthy()
    expect(
      screen.getByText('Could not be refreshed just now — showing the last reading. Retrying automatically.'),
    ).toBeTruthy()
  })
})
