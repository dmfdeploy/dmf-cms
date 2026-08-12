/**
 * Monitoring page (fix-round 5, PR #81, codex sibling sweep).
 *
 * None of the three reads on this page (metrics, alerts, targets) checked
 * `isError` anywhere. A never-loaded read defaulted every metric to a
 * confident `0%` plus a green "✓ Healthy" badge, and every list to its
 * genuinely-empty copy ("No active alerts", "No scrape targets available")
 * — the exact absence/status claims this fix arc exists to stop. A settled
 * failed refetch additionally kept rendering retained numbers/rows as
 * current with no notice at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Monitoring from '../pages/Monitoring'
import type { AlertsResponse, MonitoringMetrics, TargetsResponse } from '../api/types'

function metrics(overrides: Partial<MonitoringMetrics> = {}): MonitoringMetrics {
  return { cpu_percent: 10, memory_percent: 20, pod_restarts_24h: 0, pvc_usage_percent: 30, ...overrides }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderPage(routes: { metrics?: unknown; metricsStatus?: number; alerts?: AlertsResponse; targets?: TargetsResponse }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/monitoring/metrics')) {
        return json(routes.metrics ?? metrics(), routes.metricsStatus ?? 200)
      }
      if (url.endsWith('/api/monitoring/alerts')) return json(routes.alerts ?? { alerts: [] })
      if (url.endsWith('/api/monitoring/targets')) return json(routes.targets ?? { targets: [] })
      return json({})
    }),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Monitoring />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Monitoring page — happy path', () => {
  it('renders real metric values and their posture badge', async () => {
    renderPage({ metrics: metrics({ cpu_percent: 91 }) })
    expect(await screen.findByText('91%')).toBeTruthy()
    expect(screen.getByText('⚠️ High')).toBeTruthy()
  })

  it('renders the genuine empty states when reads succeed with nothing', async () => {
    renderPage({})
    expect(await screen.findByText('✓ No active alerts')).toBeTruthy()
    expect(screen.getByText('No scrape targets available')).toBeTruthy()
  })
})

describe('Monitoring page — failed reads never manufacture a confident claim', () => {
  it('a failed metrics read with no data at all shows an honest placeholder, never 0% + Healthy', async () => {
    renderPage({ metricsStatus: 500 })
    expect(await screen.findByText('Metrics could not be read. Retrying automatically.')).toBeTruthy()
    expect(screen.getAllByText('—')).toHaveLength(4)
    expect(screen.getAllByText('Cannot confirm')).toHaveLength(4)
    expect(screen.queryByText('0%')).toBeNull()
    expect(screen.queryByText('✓ Healthy')).toBeNull()
  })

  it('a failed alerts read with no data at all does not claim "No active alerts"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/monitoring/metrics')) return json(metrics())
        if (url.endsWith('/api/monitoring/alerts')) return new Response('boom', { status: 500 })
        if (url.endsWith('/api/monitoring/targets')) return json({ targets: [] })
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Monitoring />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Alerts could not be read. Retrying automatically.')).toBeTruthy()
    expect(screen.queryByText('✓ No active alerts')).toBeNull()
  })

  it('a failed targets read with no data at all does not claim "No scrape targets available"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/monitoring/metrics')) return json(metrics())
        if (url.endsWith('/api/monitoring/alerts')) return json({ alerts: [] })
        if (url.endsWith('/api/monitoring/targets')) return new Response('boom', { status: 500 })
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Monitoring />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Scrape targets could not be read. Retrying automatically.')).toBeTruthy()
    expect(screen.queryByText('No scrape targets available')).toBeNull()
  })
})

describe('Monitoring page — hold-then-reject (settled error over retained data)', () => {
  it('a settled failed metrics refetch keeps the retained number visible but adds a notice', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/monitoring/metrics')) {
          calls += 1
          if (calls === 1) return json(metrics({ cpu_percent: 42 }))
          return new Response('boom', { status: 500 })
        }
        if (url.endsWith('/api/monitoring/alerts')) return json({ alerts: [] })
        if (url.endsWith('/api/monitoring/targets')) return json({ targets: [] })
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Monitoring />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // First (successful) read settles. Fake timers active, so settle() +
    // getBy*, never findBy* (findBy* waits on real timers and would hang).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('42%')).toBeTruthy()
    expect(screen.queryByText(/could not be refreshed/)).toBeNull()

    // Advance past useMonitoringMetrics' 30s refetchInterval so the
    // background refetch fires and rejects, while the old value stays
    // retained.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100)
    })

    // Retained value STILL shown (Art. 5) — now qualified by a notice.
    expect(screen.getByText('42%')).toBeTruthy()
    expect(
      screen.getByText('Metrics could not be refreshed just now — showing the last successful read. Retrying automatically.'),
    ).toBeTruthy()
  })

  it('a settled failed alerts refetch keeps retained alerts visible but adds a notice', async () => {
    vi.useFakeTimers()
    let calls = 0
    const firingAlert = { name: 'HostMemoryPressure', state: 'firing', severity: 'warning', summary: '', activeAt: '' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/monitoring/metrics')) return json(metrics())
        if (url.endsWith('/api/monitoring/targets')) return json({ targets: [] })
        if (url.endsWith('/api/monitoring/alerts')) {
          calls += 1
          if (calls === 1) return json({ alerts: [firingAlert] })
          return new Response('boom', { status: 500 })
        }
        return json({})
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Monitoring />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60)
    })
    expect(screen.getByText('HostMemoryPressure')).toBeTruthy()
    expect(screen.queryByText(/could not be refreshed/)).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100)
    })

    expect(screen.getByText('HostMemoryPressure')).toBeTruthy()
    expect(
      screen.getByText('Alerts could not be refreshed just now — showing the last successful read. Retrying automatically.'),
    ).toBeTruthy()
  })
})
