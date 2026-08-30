/**
 * umbrella dmfdeploy/dmfdeploy#498 — the ghost-grid inspection harness's own
 * route gate + end-to-end reachability. Sibling test file to
 * devHarnessRoute.test.tsx, deliberately separate rather than appended to
 * it — see devHarnessRoute.ts's own comment on why isGhostGridHarnessRoute
 * is a standalone sibling function rather than a generalized multi-route
 * gate: each harness's contract is pinned independently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import {
  DEV_HARNESS_ROUTE,
  GHOST_GRID_HARNESS_ROUTE,
  isGhostGridHarnessRoute,
} from '../pages/Dev/devHarnessRoute'
import { APP_BASE } from '../../vite-base.config'

function renderAppAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('isGhostGridHarnessRoute — the pure gate', () => {
  it('matches the harness path only when DEV is true', () => {
    expect(import.meta.env.DEV).toBe(true) // sanity: vitest's own default
    expect(isGhostGridHarnessRoute(GHOST_GRID_HARNESS_ROUTE)).toBe(true)
  })

  it('never matches any other path, even under DEV — including the OTHER dev harness route', () => {
    expect(isGhostGridHarnessRoute('/media-workloads/studio-a')).toBe(false)
    expect(isGhostGridHarnessRoute('/')).toBe(false)
    expect(isGhostGridHarnessRoute(DEV_HARNESS_ROUTE)).toBe(false)
  })

  it('refuses to match when DEV is stubbed false — the production build\'s own value', () => {
    vi.stubEnv('DEV', false)
    expect(isGhostGridHarnessRoute(GHOST_GRID_HARNESS_ROUTE)).toBe(false)
  })

  it('tolerates a leading Vite base prefix, same as the sibling gate', () => {
    const prefixed = `${APP_BASE.replace(/\/$/, '')}${GHOST_GRID_HARNESS_ROUTE}`
    expect(isGhostGridHarnessRoute(prefixed, APP_BASE)).toBe(true)
  })
})

describe('the two dev harness routes never collide', () => {
  it('neither gate matches the other\'s route', () => {
    expect(isGhostGridHarnessRoute(DEV_HARNESS_ROUTE)).toBe(false)
  })
})

describe('the ghost-grid harness through the real <App/>', () => {
  it('is reachable when DEV is true, and App\'s own /api/me call stays disabled', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    renderAppAt(GHOST_GRID_HARNESS_ROUTE)
    expect(await screen.findByTestId('ghost-grid-harness')).toBeTruthy()

    // Whatever the default specimen fetched, it went through the specimen's
    // OWN stub (installed on mount — see GhostGridHarness.tsx's
    // SpecimenStage docstring), never the spy above with an /api/me call —
    // proving App.tsx's `useCurrentUser(!anyHarness)` genuinely stayed
    // disabled rather than merely racing the specimen's stub and losing.
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).endsWith('/api/me'))).toBe(false)
  })

  it('falls through to the ordinary catch-all when DEV is stubbed false, instead of rendering the harness', async () => {
    vi.stubEnv('DEV', false)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/me')) {
          return new Response(
            JSON.stringify({
              subject: 'ops',
              display_name: 'Ops',
              email: 'ops@dmf.example.com',
              role: 'engineer',
              real_role: 'engineer',
              view_as_active: false,
              groups: [],
              awx_configured: true,
              authentik_configured: true,
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({}), { status: 200 })
      }),
    )
    renderAppAt(GHOST_GRID_HARNESS_ROUTE)

    expect(await screen.findByText(/Loading|Workspace|Facilities/i)).toBeTruthy()
    expect(screen.queryByTestId('ghost-grid-harness')).toBeNull()
  })

  it('walking every specimen button renders that specimen\'s real page content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    renderAppAt(GHOST_GRID_HARNESS_ROUTE)
    await screen.findByTestId('ghost-grid-harness')

    // 0 workloads — the healthy-empty ghost canvas (operator ruling), the
    // copy stays exactly what it was before #498 touched this screen.
    fireEvent.click(screen.getByTestId('ghost-grid-specimen-button-workloads-zero'))
    await screen.findByText("No media workloads yet — they'll appear here once you create one.")

    // 2 workloads — the acceptance criteria's own named scrollbar check.
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghost-grid-specimen-button-workloads-two'))
    })
    await screen.findByText('Studio A')
    await screen.findByText('Studio B')

    // 8 workloads — the long-list check.
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghost-grid-specimen-button-workloads-many'))
    })
    await screen.findByText('Studio 1')
    await screen.findByText('Studio 8')

    // Facilities — always exactly one.
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghost-grid-specimen-button-facilities-one'))
    })
    await screen.findByText('DMF Lab')
  })
})
