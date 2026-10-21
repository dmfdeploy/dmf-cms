import { useEffect, useRef } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Topbar from './Topbar'
import Sidebar from './Sidebar'

/**
 * FIX ROUND (umbrella #515, gate P1 — the fixed row's height was assumed,
 * not measured). The first attempt kept the header-slot row `position:
 * fixed` and offset `<main>` by a constant `mt-14` (56px) matching that
 * row's height at ONE viewport (1440px wide, LifecycleStrip on a single
 * line). Below ~390px the strip wraps into a 5-key single column (5 keys at
 * `h-10` + 4 `gap-2` gaps + the row's own `py-2` ≈ 248px tall) — the row was
 * then ~248px tall while `<main>` still started 56px below it, so roughly
 * 192px of the page's own first content sat under the still-fixed row:
 * exactly the "sidebar holds still while the rail covers the page" trap the
 * operator named, reintroduced at a width the previous round never
 * measured.
 *
 * Fixed by inverting which element leaves the flow, not by making the
 * offset dynamic (a ResizeObserver measuring the row's real height would
 * work, but keeps the actual defect: two numbers in two files that must
 * agree). The header-slot row is back in NORMAL FLOW (Topbar.tsx) — at any
 * width, at any height the rail wraps to, it reserves exactly its own real
 * height for whatever comes after it, with no constant anywhere to drift
 * out of sync. `<Sidebar/>` is the element positioned OUT of flow instead
 * (`fixed`, anchored to the header's own bottom edge and the viewport's own
 * bottom — see that component's own comment) — its position is now
 * independent of the row's presence or height entirely, which is the
 * actual "sidebar does not move" requirement, not a side effect of getting
 * the row's height right elsewhere.
 *
 * `<main>` takes a permanent `pl-16` (64px, Sidebar's own `w-16`) instead
 * of a slot-row-conditional `mt-14`: the sidebar occupies that column for
 * the page's full height now (it's `fixed`, not scoped to the rail's own
 * band), not just alongside the rail, so the offset is unconditional too —
 * Shell no longer needs to know whether the row is showing at all (no
 * `useShowHeaderSlotRow` import here any more), which removes the transient
 * Shell/Topbar timing question the previous version had to reason about,
 * rather than answering it.
 */
/**
 * dmfdeploy/dmfdeploy#610. `<main>` is the one scroll container, so it is
 * also the containing block for anything absolutely positioned inside a page
 * (`relative`, `min-h-0`): a descendant such as HistoryLane's visually hidden
 * span can no longer extend the document and let a wheel over the sidebar
 * scroll the window.
 *
 * On a route change `<main>` scrolls back to the top and focus moves to the
 * page heading (visually hidden on purpose) or, when the page has none yet,
 * to `<main>` itself. The first render is skipped: a page load keeps the
 * browser's own focus. The skip link is the first Tab stop and goes to the
 * same target.
 */
const MAIN_ID = 'main-content'

function focusMain(main: HTMLElement | null) {
  if (!main) return
  const heading = main.querySelector<HTMLElement>('h1')
  const target = heading ?? main
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
}

export default function Shell() {
  const { pathname } = useLocation()
  const mainRef = useRef<HTMLElement>(null)
  // The path the page was last settled on. Comparing paths, not counting
  // renders, keeps the first load (and a StrictMode effect replay) quiet.
  const settledPath = useRef(pathname)

  useEffect(() => {
    if (settledPath.current === pathname) return
    settledPath.current = pathname
    const main = mainRef.current
    if (!main) return
    // scroll-smooth would animate a reset; a route change should land at the top.
    if (typeof main.scrollTo === 'function') main.scrollTo({ top: 0, behavior: 'instant' })
    else main.scrollTop = 0
    focusMain(main)
  }, [pathname])

  return (
    <div className="bg-bg text-text h-full flex flex-col overflow-hidden">
      <a
        href={`#${MAIN_ID}`}
        onClick={(e) => {
          e.preventDefault()
          focusMain(mainRef.current)
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-panel focus:px-3 focus:py-2 focus:text-sm focus:text-text"
      >
        Skip to main content
      </a>
      <Topbar />
      <Sidebar />
      <main
        ref={mainRef}
        id={MAIN_ID}
        className="relative min-h-0 flex-1 overflow-y-auto scroll-smooth pl-16 outline-none"
      >
        <Outlet />
      </main>
    </div>
  )
}
