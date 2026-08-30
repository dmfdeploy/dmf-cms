/**
 * The gate for dmf-cms#391's lifecycle-rail inspection harness.
 *
 * WHY THIS EXISTS AT ALL. There is no way to look at the rail in a real
 * browser today: the live console needs the full release chain (backend +
 * Authentik OIDC), and its passkey-first auth gate blocks headless browsers
 * outright (no passkey ceremony to drive). LifecycleStrip renders from props
 * alone (see testUtils/HeaderSlotProbe.tsx, which already proves this for
 * the test suite), and those props are themselves producible from a plain
 * WorkloadLifecycleInput plus an instances array run through the REAL
 * classifyWorkloadForHeaderSlot + buildHeaderSlotRail pipeline
 * (store/headerSlot.ts) — see pages/Dev/LifecycleRailHarness.tsx, which does
 * exactly that, never hand-building LifecycleStrip's props directly. Needs
 * no backend, no API, and (with useCurrentUser's query disabled on this
 * route — see App.tsx) genuinely no auth call either. This module is the
 * ONE gate that decides whether that harness is reachable at all, kept
 * deliberately tiny and separate from App.tsx so it is unit-testable
 * without rendering the whole app tree.
 *
 * WHY THE EARLY-RETURN, NOT A NORMAL <Route>. App.tsx's production route
 * table only renders once the operator is authenticated — the auth
 * loading/redirect logic runs BEFORE <Routes> is ever reached, so an
 * ordinary <Route path="/__dev/..."> entry inside that table would still be
 * unreachable without a passkey, defeating the entire point. App.tsx instead
 * checks `isDevHarnessRoute` FIRST, ahead of every auth-derived branch
 * (including the redirect effect), and returns the harness directly when it
 * matches — genuinely bypassing auth, not merely being exempt from
 * ProtectedRoute's wrapper the way every other route is.
 *
 * WHY import.meta.env.DEV, SPECIFICALLY. Vite statically replaces
 * `import.meta.env.DEV` with the literal `false` in a production build
 * (`vite build` runs with mode "production" by default).
 *
 * FIX ROUND (codex gate — P3): this used to claim that lets dead code
 * elimination remove "a dynamic `import()`" inside the gated branch — false;
 * App.tsx imports LifecycleRailHarness with a plain STATIC top-level
 * `import`, not a dynamic one, and this module makes no import() call of
 * its own either. What actually keeps the harness out of a production
 * bundle is Rollup's ordinary tree-shaking: with `import.meta.env.DEV`
 * replaced by the literal `false`, App.tsx's `if (devHarness) return
 * <LifecycleRailHarness />` becomes dead code, and once that is the only
 * remaining reference to the LifecycleRailHarness binding, Rollup drops
 * both the reference and — since nothing else in the module graph imports
 * it — the module itself. This is EMPIRICALLY VERIFIED, not just argued: a
 * real `vite build` followed by grepping the output bundle for
 * "lifecycle-rail-harness" (the harness root's own data-testid) and for the
 * harness's specimen titles returns zero matches — see the PR description
 * for that run's output. devHarnessRoute.test.tsx pins the runtime half of
 * the contract (DEV stubbed false -> the gate refuses to match) as a fast
 * unit test; the bundle grep itself is not re-run as part of the suite
 * (a full production build per test run is a heavy, redundant cost for
 * re-confirming the same already-verified compiler behaviour), so treat it
 * as a one-time verification rather than a standing regression test.
 *
 * FIX ROUND (dmf-cms#391): the matcher must tolerate a leading Vite `base`
 * prefix on `pathname`, not just the bare path. vite.config.ts sets
 * `base: '/static/app/'` (the production backend's static-asset mount
 * point), and Vite serves the dev SPA shell at that same prefix — a real
 * browser hard-navigating (or deep-linking/bookmarking) to
 * `/static/app/__dev/lifecycle-rail` gets `location.pathname ===
 * '/static/app/__dev/lifecycle-rail'`, which an exact bare-path match
 * rejects outright. (A CLIENT-SIDE navigation from an already-loaded page
 * lands on the bare path instead, since <BrowserRouter> in main.tsx carries
 * no `basename` — which is also exactly what a real production URL looks
 * like, per the backend's own unprefixed route serving. Both shapes are
 * therefore real and must both match.) `stripBase` below strips exactly one
 * leading, exact `base` prefix (Vite's own `import.meta.env.BASE_URL`
 * value, always normalized to start and end with "/") before comparing —
 * anything else (no prefix, a different prefix entirely) passes through
 * unchanged and is compared as-is.
 */
export const DEV_HARNESS_ROUTE = '/__dev/lifecycle-rail'

/**
 * Strips exactly one leading `base` prefix from `pathname`, if present.
 * `base` is expected in Vite's own normalized form (starts and ends with
 * "/", e.g. "/static/app/", or is exactly "/" for no prefix at all).
 * Exported for its own direct unit test.
 */
export function stripBase(pathname: string, base: string): string {
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base
  if (!normalizedBase || !pathname.startsWith(normalizedBase)) return pathname
  // A plain startsWith is not a path-boundary check: "/static/app" is a
  // STRING prefix of "/static/apples/..." too. Require the character right
  // after the matched prefix to be either nothing (pathname === base
  // exactly) or "/" (a real path segment boundary) — otherwise this is a
  // same-prefix-different-segment path, not actually base-prefixed, and
  // must pass through unchanged.
  const boundary = pathname[normalizedBase.length]
  if (boundary !== undefined && boundary !== '/') return pathname
  const rest = pathname.slice(normalizedBase.length)
  return rest === '' ? '/' : rest
}

/**
 * `base` defaults to Vite's own `import.meta.env.BASE_URL` — the exact
 * value `vite.config.ts`'s `base` option resolves to at runtime, in both a
 * real `vite dev` server and a production build. NOT reliable inside
 * Vitest's own test runner, which normalizes BASE_URL to "/" regardless of
 * config (no real base-relative serving happens there) — callers that need
 * to exercise the base-prefixed shape in a test pass it explicitly instead
 * (see devHarnessRoute.test.tsx, which sources it from vite-base.config.ts,
 * the same file vite.config.ts itself reads `base` from — not a hardcoded
 * duplicate string).
 */
export function isDevHarnessRoute(pathname: string, base: string = import.meta.env.BASE_URL): boolean {
  return import.meta.env.DEV && stripBase(pathname, base) === DEV_HARNESS_ROUTE
}

/**
 * The ghost-grid inspection harness's own route (umbrella
 * dmfdeploy/dmfdeploy#498). A SIBLING constant/gate pair, not a generalized
 * multi-route version of the pair above — `isDevHarnessRoute`'s exact
 * boolean contract is pinned in real depth by this file's own test suite's
 * base-prefix-tolerance fix-round history, and widening its signature to
 * cover a second route for the sake of a few avoided lines wasn't worth
 * that risk. `stripBase` (the actually-reusable logic) is shared as-is.
 */
export const GHOST_GRID_HARNESS_ROUTE = '/__dev/ghost-grid'

export function isGhostGridHarnessRoute(
  pathname: string,
  base: string = import.meta.env.BASE_URL,
): boolean {
  return import.meta.env.DEV && stripBase(pathname, base) === GHOST_GRID_HARNESS_ROUTE
}
