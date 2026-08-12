/**
 * Catalog/index.tsx — useCatalog retained-error honesty (fix-round 7, PR
 * #81, umbrella #385, codex call-site sweep). Distinct from the isError-
 * gating shape the rest of this arc chases: `if (error)` used to replace
 * the ENTIRE page with the error panel on ANY failed read, even a settled
 * refetch that retained a perfectly good `catalogData` — discarding real,
 * still-current, still-deployable/tearable-down entries instead of keeping
 * the screen still with a notice (Art. 5). Same root cause as every other
 * fix in this arc (the CURRENT read's failure was never distinguished from
 * "nothing to show at all"), just the opposite direction: over-suppressing
 * good data instead of under-qualifying stale data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Catalog from '../pages/Catalog'
import type { CatalogEntry, UserIdentity } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops',
    email: 'ops@dmf.example.com',
    role: 'engineer',
    real_role: 'engineer',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
    ...overrides,
  }
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'crosspoint',
    display_name: 'MXL Crosspoint',
    summary: '',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'bootstrapped',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'deploy-crosspoint',
    finalise_awx_job_template: 'teardown-crosspoint',
    dependencies: [],
    ingress_url: null,
    ...overrides,
  }
}

function renderCatalog(fetchImpl: (input: RequestInfo | URL) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Catalog />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Catalog: a failed read with nothing ever retained shows the honest full-page notice', () => {
  it('says the read failed, not a bare/stringified exception', async () => {
    renderCatalog(async (input) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return json(identity())
      if (url.endsWith('/api/catalog')) return new Response('boom', { status: 500 })
      return json({})
    })
    expect(await screen.findByText('The catalog could not be loaded right now. Reload the page to try again.')).toBeTruthy()
  })
})

describe('Catalog: a settled failed refetch keeps the retained entries visible but adds a notice', () => {
  it('never silently discards a real, still-deployable catalog just because the latest poll failed', async () => {
    let calls = 0
    const { queryClient } = renderCatalog(async (input) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return json(identity())
      if (url.endsWith('/api/catalog')) {
        calls += 1
        if (calls === 1) return json({ entries: [catalogEntry({ lifecycle: 'active' })] })
        return new Response('boom', { status: 500 })
      }
      return json({})
    })

    // First (successful) read settles — the entry renders, no notice.
    expect(await screen.findByText('MXL Crosspoint')).toBeTruthy()
    expect(screen.queryByText(/could not be refreshed/)).toBeNull()
    expect(screen.queryByText(/could not be loaded/)).toBeNull()

    // Trigger the background refetch a window-focus/staleTime-driven poll
    // would cause; useCatalog has no refetchInterval, so this is driven
    // directly (established pattern for un-polled hooks elsewhere in this
    // arc) rather than by advancing a timer.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['catalog'] })
    })

    await waitFor(() => {
      // The retained entry is STILL shown (Art. 5) — the operator can still
      // see, deploy, and tear down what was already known-good.
      expect(screen.getByText('MXL Crosspoint')).toBeTruthy()
      expect(
        screen.getByText('The catalog could not be refreshed just now — showing the last successful read. Reload the page to try again.'),
      ).toBeTruthy()
    })
    // Never the full-page replacement — that claim is reserved for "nothing
    // was ever successfully read at all".
    expect(screen.queryByText('The catalog could not be loaded right now. Reload the page to try again.')).toBeNull()
  })
})
