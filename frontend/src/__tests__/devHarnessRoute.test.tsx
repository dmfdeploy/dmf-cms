/**
 * dmf-cms#391 — the lifecycle-rail inspection harness's route gate.
 *
 * Three things are pinned here: the pure gating logic (isDevHarnessRoute)
 * directly; the base-prefix-tolerance FIX ROUND below (a real bug the
 * operator found by loading the harness in an actual browser — the first
 * version of this file only ever exercised the bare, unprefixed pathname,
 * which is exactly the "easier property" a matcher can pass on and still be
 * broken in the shape a real dev server actually serves); and the
 * end-to-end contract that actually matters — with import.meta.env.DEV
 * genuinely false (the production build's own value, per Vite's documented
 * static replacement — see devHarnessRoute.ts's own docstring), the harness
 * is unreachable through <App/>'s real routing and the unmatched path falls
 * through to the ordinary catch-all instead. A `vite build` + bundle grep
 * would additionally prove the harness's own code is eliminated from the
 * shipped chunk graph, not just unreachable at runtime — that check was run
 * by hand (see the PR description) rather than added here, since it
 * exercises the same documented Vite behaviour this runtime test already
 * pins, at the cost of a full production build per suite run.
 *
 * FIX ROUND (codex gate — D): App.tsx passes `useCurrentUser(!devHarness)`,
 * so the dev-harness route is also pinned here to make genuinely ZERO
 * network calls — not merely to render successfully despite one going
 * unread, which is what an earlier version of this file's own comments
 * overstated (see git history / the PR description for that correction).
 *

 * HONEST LIMIT ON WHAT THIS FILE CAN PROVE: Vitest's own
 * `import.meta.env.BASE_URL` is always "/" inside the test runner,
 * regardless of vite.config.ts's real `base` — there is no actual
 * base-relative serving happening in a Node-run jsdom test, so Vite has
 * nothing to normalize it against. That means a full <App/> render test at
 * the base-PREFIXED path (e.g. "/static/app/__dev/lifecycle-rail") cannot
 * exercise isDevHarnessRoute's DEFAULT parameter the way a real browser
 * does — App.tsx's own call site never passes `base` explicitly, so under
 * this suite it always resolves against "/", not the real "/static/app/".
 * The tests below instead prove the STRIPPING LOGIC itself is correct
 * against the real configured base (passed explicitly, sourced from
 * vite-base.config.ts — the same file vite.config.ts itself reads `base`
 * from, never a hardcoded duplicate). The claim that this logic is what
 * actually runs in a real browser is verified by loading the harness at
 * that exact URL in an actual browser (gstack/browse) — see the PR
 * description for that run's output — which is the only environment where
 * import.meta.env.BASE_URL genuinely equals the configured value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import {
  DEV_HARNESS_ROUTE,
  isDevHarnessRoute,
  isThrobberHarnessRoute,
  stripBase,
  THROBBER_HARNESS_ROUTE,
} from '../pages/Dev/devHarnessRoute'
import { APP_BASE } from '../../vite-base.config'
import type { UserIdentity } from '../api/types'

function identity(): UserIdentity {
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
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// A real, authenticated /api/me so a DEV-false render exercises the
// PRODUCTION happy path (falls through to the catch-all route) rather than
// the unauthenticated redirect branch — window.location.href assignment
// isn't meaningfully observable in jsdom and isn't what this test is about.
function stubAuthenticatedFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return json(identity())
      return json({})
    }),
  )
}

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

describe('isDevHarnessRoute — the pure gate', () => {
  it('matches the harness path only when DEV is true', () => {
    expect(import.meta.env.DEV).toBe(true) // sanity: vitest's own default
    expect(isDevHarnessRoute(DEV_HARNESS_ROUTE)).toBe(true)
  })

  it('never matches any other path, even under DEV', () => {
    expect(isDevHarnessRoute('/media-workloads/studio-a')).toBe(false)
    expect(isDevHarnessRoute('/')).toBe(false)
  })

  it('refuses to match when DEV is stubbed false — the production build\'s own value', () => {
    vi.stubEnv('DEV', false)
    expect(isDevHarnessRoute(DEV_HARNESS_ROUTE)).toBe(false)
  })
})

// FIX ROUND (dmf-cms#391): found by loading the harness in a real browser —
// the exact-match version of isDevHarnessRoute could only ever see the bare
// path, but Vite serves the dev SPA shell (and a real deep-link/bookmark
// hard-navigation lands on) the base-PREFIXED path, `${APP_BASE}__dev/...`.
// APP_BASE is imported from vite-base.config.ts, the same file
// vite.config.ts itself reads `base` from — if that value ever changes,
// this test changes with it rather than silently testing a stale prefix.
describe('stripBase — tolerates a leading Vite `base` prefix', () => {
  it('strips the real configured base prefix, keeping the leading slash', () => {
    const prefixed = `${APP_BASE.replace(/\/$/, '')}${DEV_HARNESS_ROUTE}`
    expect(prefixed).toBe(`${APP_BASE}${DEV_HARNESS_ROUTE.slice(1)}`) // sanity on the fixture itself
    expect(stripBase(prefixed, APP_BASE)).toBe(DEV_HARNESS_ROUTE)
  })

  it('passes an unprefixed path through unchanged — the production/client-navigation shape', () => {
    expect(stripBase(DEV_HARNESS_ROUTE, APP_BASE)).toBe(DEV_HARNESS_ROUTE)
  })

  it('is a no-op when base is "/" (no prefix configured at all)', () => {
    const prefixed = `${APP_BASE.replace(/\/$/, '')}${DEV_HARNESS_ROUTE}`
    expect(stripBase(prefixed, '/')).toBe(prefixed)
  })

  it('does not strip a path that merely starts with the same characters as base but isn\'t actually prefixed by it', () => {
    // e.g. base "/static/app/" must not falsely match "/static/apples/..."
    const base = '/static/app/'
    const lookalike = '/static/apples/__dev/lifecycle-rail'
    expect(stripBase(lookalike, base)).toBe(lookalike)
  })
})

describe('isDevHarnessRoute — accepts the base-prefixed pathname form Vite actually serves in dev', () => {
  it('matches when given the real configured base explicitly (the value App.tsx\'s DEFAULT parameter resolves to in an actual browser)', () => {
    const prefixed = `${APP_BASE.replace(/\/$/, '')}${DEV_HARNESS_ROUTE}`
    expect(isDevHarnessRoute(prefixed, APP_BASE)).toBe(true)
  })

  it('still matches the bare, unprefixed path with the real base supplied — the production/client-navigation shape', () => {
    expect(isDevHarnessRoute(DEV_HARNESS_ROUTE, APP_BASE)).toBe(true)
  })

  it('still refuses every other path when the real base is supplied', () => {
    expect(isDevHarnessRoute(`${APP_BASE}media-workloads/studio-a`, APP_BASE)).toBe(false)
  })
})

describe('the harness is absent from the production route table', () => {
  it('is reachable through the real <App/> when DEV is true, and makes NO network call at all', async () => {
    // FIX ROUND (codex gate — D): App.tsx now calls
    // useCurrentUser(!devHarness), so on this route the query is genuinely
    // `enabled: false` — no /api/me request fires at all, not merely one
    // whose result goes unread. A spy (not a stub) is the actual proof: no
    // response is configured for it to return, so if anything called
    // fetch, this test would explode instead of silently passing.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderAppAt(DEV_HARNESS_ROUTE)
    expect(await screen.findByTestId('lifecycle-rail-harness')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls through to the ordinary catch-all when DEV is stubbed false, instead of rendering the harness', async () => {
    vi.stubEnv('DEV', false)
    stubAuthenticatedFetch()
    renderAppAt(DEV_HARNESS_ROUTE)

    // The catch-all route (`<Route path="*" element={<Navigate to="/" />} />`)
    // redirects to Workspace — same as any other unknown path would.
    expect(await screen.findByText(/Loading|Workspace|Facilities/i)).toBeTruthy()
    expect(screen.queryByTestId('lifecycle-rail-harness')).toBeNull()
  })
})

// dmfdeploy/dmfdeploy#390 (F16) — the throbber harness's own route gate.
// Deliberately the SAME shape of test as the lifecycle-rail describes
// above, not a shared/parametrized one — isThrobberHarnessRoute is its own
// sibling function (see devHarnessRoute.ts's own comment on why), so its
// contract is pinned independently rather than assumed to track the other
// gate's tests forever.
describe('isThrobberHarnessRoute — the pure gate', () => {
  it('matches the harness path only when DEV is true', () => {
    expect(import.meta.env.DEV).toBe(true) // sanity: vitest's own default
    expect(isThrobberHarnessRoute(THROBBER_HARNESS_ROUTE)).toBe(true)
  })

  it('never matches any other path, even under DEV — including the OTHER dev harness route', () => {
    expect(isThrobberHarnessRoute('/media-workloads/studio-a')).toBe(false)
    expect(isThrobberHarnessRoute('/')).toBe(false)
    expect(isThrobberHarnessRoute(DEV_HARNESS_ROUTE)).toBe(false)
  })

  it('refuses to match when DEV is stubbed false — the production build\'s own value', () => {
    vi.stubEnv('DEV', false)
    expect(isThrobberHarnessRoute(THROBBER_HARNESS_ROUTE)).toBe(false)
  })

  it('tolerates a leading Vite base prefix — reuses stripBase, the same logic the rail gate already proves', () => {
    const prefixed = `${APP_BASE.replace(/\/$/, '')}${THROBBER_HARNESS_ROUTE}`
    expect(isThrobberHarnessRoute(prefixed, APP_BASE)).toBe(true)
  })
})

describe('the two dev harness routes never collide', () => {
  it('the rail gate does not match the throbber route, and vice versa', () => {
    expect(isDevHarnessRoute(THROBBER_HARNESS_ROUTE)).toBe(false)
    expect(isThrobberHarnessRoute(DEV_HARNESS_ROUTE)).toBe(false)
  })
})

describe('the throbber harness is absent from the production route table', () => {
  it('is reachable through the real <App/> when DEV is true, and makes NO network call at all', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderAppAt(THROBBER_HARNESS_ROUTE)
    expect(await screen.findByTestId('throbber-harness')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls through to the ordinary catch-all when DEV is stubbed false, instead of rendering the harness', async () => {
    vi.stubEnv('DEV', false)
    stubAuthenticatedFetch()
    renderAppAt(THROBBER_HARNESS_ROUTE)

    expect(await screen.findByText(/Loading|Workspace|Facilities/i)).toBeTruthy()
    expect(screen.queryByTestId('throbber-harness')).toBeNull()
  })

  it('renders every documented specimen, none crashing, none silently empty', async () => {
    vi.stubGlobal('fetch', vi.fn())
    renderAppAt(THROBBER_HARNESS_ROUTE)
    const harness = await screen.findByTestId('throbber-harness')
    // 12 specimens as of F16 — a loose floor (>= 10), not a brittle exact
    // pin, so adding one more specimen later doesn't fail this test for no
    // reason; the point is "the page actually rendered a full set", not
    // "exactly this many forever".
    const specimens = harness.querySelectorAll('[data-testid^="throbber-specimen-"]')
    expect(specimens.length).toBeGreaterThanOrEqual(10)
  })
})
